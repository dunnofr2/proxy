import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { createProxyServer } from "../src/server.js";
import { createAuthService } from "../src/auth.js";
import { createChatService } from "../src/chat.js";
import { createAiStore } from "../src/ai-store.js";
import { getConfiguredDeliveryMode } from "../src/mailer.js";
import { WebSocket as WsClient } from "ws";
import { resolveInputToUrl } from "../public/js/url.js";
import {
  COVERS_BASES,
  HTML_BASES,
  filterPlayableZones,
  getHtmlCandidates,
  resolveCoverUrl,
} from "../public/js/games.js";
import {
  isAllowedSoundCloudMediaUrl,
  normalizeTrack,
  pickPlayableTranscoding,
  rewriteM3u8,
} from "../src/soundcloud.js";
import { cleanTrackTitle, parseLrc } from "../src/lyrics.js";

let server;
let baseUrl;
let wsBaseUrl;
let tempDir;
const sentEmails = new Map();

test.before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "simple-proxy-test-"));
  const authService = createAuthService({
    storePath: join(tempDir, "accounts.json"),
    sendEmail: async ({ to, code }) => {
      sentEmails.set(to, code);
      return { delivery: "smtp" };
    },
  });
  const chatService = createChatService({
    storePath: join(tempDir, "chat.json"),
    authService,
  });

  const aiStore = createAiStore({ storePath: join(tempDir, "ai-chats.json") });

  server = createProxyServer({ authService, chatService, aiStore });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
  wsBaseUrl = `ws://127.0.0.1:${port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("GET / serves the Simple proxy frontend", async () => {
  const res = await fetch(`${baseUrl}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/html/);
  const html = await res.text();
  assert.match(html, /<title>Simple<\/title>/);
  assert.match(html, /class="simple-title">Simple<\/h1>/);
  assert.match(html, /uv\.bundle\.js/);
  assert.match(html, /uv\.config\.js/);
  assert.match(html, /css\/style\.css/);
  assert.match(html, /js\/main\.js/);
});

test("POST /api/ai/chat requires sign-in and never exposes the API key", async () => {
  const res = await fetch(`${baseUrl}/api/ai/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(res.status, 401);

  const status = await (await fetch(`${baseUrl}/api/ai/status`)).json();
  assert.deepEqual(Object.keys(status), ["configured", "models"]);
  assert.deepEqual(status.models.map((m) => m.id), ["deepseek/deepseek-v4.1-flash"]);
  assert.ok(!JSON.stringify(status).includes("sk-or"));
});

test("GET /api/health returns proxy diagnostics", async () => {
  const res = await fetch(`${baseUrl}/api/health`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(data, {
    ok: true,
    engine: "ultraviolet",
    prefix: "/service/",
    wisp: "/wisp/",
    transport: "libcurl",
  });
});

test("Custom /uv.config.js and /sw.js override stock UV files", async () => {
  const cfgRes = await fetch(`${baseUrl}/uv.config.js`);
  assert.equal(cfgRes.status, 200);
  const cfgText = await cfgRes.text();
  assert.match(cfgText, /prefix:\s*["']\/service\/["']/);
  assert.match(cfgText, /bundle:\s*["']\/uv\/uv\.bundle\.js["']/);

  const swRes = await fetch(`${baseUrl}/sw.js`);
  assert.equal(swRes.status, 200);
  const swText = await swRes.text();
  assert.match(swText, /importScripts\(["']\/uv\/uv\.bundle\.js["']\)/);
  assert.match(swText, /UVServiceWorker/);
});

test("Core UV, bare-mux, and epoxy assets are served", async () => {
  const paths = [
    "/uv.bundle.js",
    "/uv/uv.bundle.js",
    "/uv/uv.handler.js",
    "/uv/uv.client.js",
    "/uv/uv.sw.js",
    "/baremux/index.mjs",
    "/baremux/worker.js",
    "/epoxy/index.mjs",
    "/libcurl/index.mjs",
    "/hls/hls.min.mjs",
  ];

  for (const path of paths) {
    const res = await fetch(`${baseUrl}${path}`);
    assert.equal(res.status, 200, `Expected 200 for ${path}`);
    assert.match(
      res.headers.get("content-type") || "",
      /javascript/,
      `Expected JS MIME type for ${path}`
    );
    await res.body?.cancel();
  }
});

test("Cold-start /service/* fallback serves SW bootstrap page", async () => {
  const res = await fetch(`${baseUrl}/service/test`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/html/);
  const html = await res.text();
  assert.match(html, /navigator\.serviceWorker\.register\("\/sw\.js"/);
});

test("Unknown HTTP routes return 404", async () => {
  const res = await fetch(`${baseUrl}/does-not-exist`);
  assert.equal(res.status, 404);
});

test("WebSocket upgrade on /wisp/ completes Wisp handshake", async () => {
  const packet = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBaseUrl}/wisp/`);
    ws.binaryType = "arraybuffer";
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("Timed out waiting for Wisp initial packet"));
    }, 3000);

    ws.addEventListener("message", (event) => {
      clearTimeout(timer);
      const bytes = new Uint8Array(event.data);
      ws.close();
      resolve(bytes);
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("WebSocket connection error"));
    });
  });

  // Wisp v1 initial CONTINUE packet: type=0x03, stream_id=0 (uint32 LE), buffer_remaining (uint32 LE)
  assert.ok(packet.length >= 9, `Expected >= 9 bytes, got ${packet.length}`);
  assert.equal(packet[0], 0x03);
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  assert.equal(view.getUint32(1, true), 0);
  assert.ok(view.getUint32(5, true) > 0);
});

test("WebSocket upgrade on /wisp (without trailing slash) normalizes to /wisp/", async () => {
  const packet = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBaseUrl}/wisp`);
    ws.binaryType = "arraybuffer";
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("Timed out waiting for Wisp initial packet"));
    }, 3000);

    ws.addEventListener("message", (event) => {
      clearTimeout(timer);
      const bytes = new Uint8Array(event.data);
      ws.close();
      resolve(bytes);
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("WebSocket connection error"));
    });
  });

  assert.equal(packet[0], 0x03);
});

test("WebSocket upgrade on non-wisp path is rejected", async () => {
  await assert.rejects(
    () =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`${wsBaseUrl}/invalid-ws`);
        ws.addEventListener("open", () => {
          ws.close();
          resolve();
        });
        ws.addEventListener("error", () => {
          reject(new Error("Rejected as expected"));
        });
      }),
    /Rejected as expected/
  );
});

test("Served uv.config.js encodes and decodes URLs using Ultraviolet xor codec", async () => {
  const bundleCode = await (await fetch(`${baseUrl}/uv.bundle.js`)).text();
  const configCode = await (await fetch(`${baseUrl}/uv.config.js`)).text();

  const sandbox = {
    self: {},
    console,
    URL,
    EventTarget,
    MessagePort,
    WebSocket,
    fetch,
    Request,
    Response,
    Headers,
    location: { origin: baseUrl },
    navigator: { serviceWorker: { addEventListener() {} } },
    SharedWorker: function () {},
    BroadcastChannel: function () {
      return { postMessage() {} };
    },
    localStorage: {},
  };
  sandbox.self = sandbox;

  vm.runInNewContext(bundleCode, sandbox);
  vm.runInNewContext(configCode, sandbox);

  const cfg = sandbox.self.__uv$config;
  assert.equal(cfg.prefix, "/service/");
  const target = "https://example.com/search?q=ultraviolet&lang=en";
  const encoded = cfg.encodeUrl(target);
  assert.notEqual(encoded, target);
  assert.equal(cfg.decodeUrl(encoded), target);
});

test("resolveInputToUrl distinguishes search queries, filenames, and URLs", () => {
  assert.equal(
    resolveInputToUrl("cats playing piano", "ddg_html"),
    "https://html.duckduckgo.com/html/?q=cats%20playing%20piano"
  );
  assert.equal(
    resolveInputToUrl("ultraviolet", "google"),
    "https://www.google.com/search?q=ultraviolet"
  );
  assert.equal(
    resolveInputToUrl("node.js", "ddg_html"),
    "https://html.duckduckgo.com/html/?q=node.js"
  );
  assert.equal(
    resolveInputToUrl("wikipedia.org", "ddg_html"),
    "https://wikipedia.org/"
  );
  assert.equal(
    resolveInputToUrl("localhost:3000/test", "ddg_html"),
    "http://localhost:3000/test"
  );
  assert.equal(
    resolveInputToUrl("https://example.com/a?b=1", "ddg_html"),
    "https://example.com/a?b=1"
  );
});

test("gn-math games helpers filter playable zones and resolve cover/HTML URLs", () => {
  const sample = [
    { id: -1, name: "Discord", cover: "{COVER_URL}/dc.png", url: "https://discord.gg/test" },
    { id: 1, name: "OvO", cover: "{COVER_URL}/1.png", url: "{HTML_URL}/1-fix2.html" },
  ];

  const filtered = filterPlayableZones(sample);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].name, "OvO");

  assert.equal(
    resolveCoverUrl(filtered[0], COVERS_BASES[0]),
    "https://cdn.jsdelivr.net/gh/gn-math/covers@main/1.png"
  );
  assert.equal(
    resolveCoverUrl(filtered[0], COVERS_BASES[1]),
    "https://raw.githubusercontent.com/gn-math/covers/main/1.png"
  );

  const htmlCandidates = getHtmlCandidates(filtered[0], HTML_BASES[0]);
  assert.equal(
    htmlCandidates[0],
    "https://cdn.jsdelivr.net/gh/gn-math/html@main/1-fix2.html"
  );
  assert.ok(
    htmlCandidates.includes("https://raw.githubusercontent.com/gn-math/html/main/1-fix2.html")
  );
  assert.ok(
    htmlCandidates.includes("https://cdn.jsdelivr.net/gh/gn-math/html@main/OvO.html")
  );
});

test("SoundCloud helpers validate hosts, skip encrypted streams, and rewrite m3u8 playlists", () => {
  assert.equal(
    isAllowedSoundCloudMediaUrl("https://playback.media-streaming.soundcloud.cloud/abc/init.mp4"),
    true
  );
  assert.equal(
    isAllowedSoundCloudMediaUrl("https://cf-media.sndcdn.com/track.mp3"),
    true
  );
  assert.equal(isAllowedSoundCloudMediaUrl("http://127.0.0.1:3000/secret"), false);
  assert.equal(isAllowedSoundCloudMediaUrl("https://evil.example.com/a.mp3"), false);
  assert.equal(isAllowedSoundCloudMediaUrl("https://notsoundcloud.cloud/a.mp3"), false);
  assert.equal(isAllowedSoundCloudMediaUrl("https://sndcdn.com.evil.com/a.mp3"), false);

  const encryptedOnly = {
    id: 1,
    title: "DRM Track",
    media: {
      transcodings: [
        { url: "https://api-v2.soundcloud.com/x", format: { protocol: "cbc-encrypted-hls", mime_type: "audio/mp4" } },
      ],
    },
  };
  assert.equal(pickPlayableTranscoding(encryptedOnly), null);
  assert.equal(normalizeTrack(encryptedOnly), null);

  const playable = {
    id: 42,
    title: "Test Track",
    user: { username: "Artist" },
    duration: 90000,
    artwork_url: "https://i1.sndcdn.com/artworks-1-large.jpg",
    media: {
      transcodings: [
        { url: "https://api-v2.soundcloud.com/hls", preset: "aac_96k", duration: 90000, format: { protocol: "hls", mime_type: 'audio/mp4; codecs="mp4a.40.2"' } },
        { url: "https://api-v2.soundcloud.com/prog", preset: "mp3_1_0", duration: 90000, format: { protocol: "progressive", mime_type: "audio/mpeg" } },
      ],
    },
  };
  const norm = normalizeTrack(playable);
  assert.equal(norm.protocol, "progressive");
  assert.equal(norm.artwork, "https://i1.sndcdn.com/artworks-1-t200x200.jpg");

  const sampleM3u8 = [
    "#EXTM3U",
    '#EXT-X-MAP:URI="https://playback.media-streaming.soundcloud.cloud/x/init.mp4?a=1"',
    "#EXTINF:10.0,",
    "https://playback.media-streaming.soundcloud.cloud/x/data000.m4s?a=1",
  ].join("\n");
  const rewritten = rewriteM3u8(sampleM3u8, "https://playback.media-streaming.soundcloud.cloud/x/playlist.m3u8");
  assert.match(rewritten, /URI="\/api\/music\/segment\?url=/);
  assert.match(rewritten, /\n\/api\/music\/segment\?url=https%3A%2F%2Fplayback\.media-streaming\.soundcloud\.cloud/);
});

test("Music search rejects missing query and segment proxy blocks non-SoundCloud hosts", async () => {
  const emptySearch = await fetch(`${baseUrl}/api/music/search`);
  assert.equal(emptySearch.status, 400);

  const ssrfAttempt = await fetch(
    `${baseUrl}/api/music/segment?url=${encodeURIComponent("http://127.0.0.1:3000/api/health")}`
  );
  assert.equal(ssrfAttempt.status, 400);

  const emptyLyrics = await fetch(`${baseUrl}/api/music/lyrics`);
  assert.equal(emptyLyrics.status, 400);
});

test("Lyrics helpers clean SoundCloud titles and parse LRC timestamps", () => {
  assert.equal(cleanTrackTitle("Get Lucky [Original Version] (feat. Pharrell)"), "Get Lucky");
  assert.equal(cleanTrackTitle("Song Title (Official Audio) ft. Artist"), "Song Title");

  const parsed = parseLrc("[00:12.50] First line\n[00:15.00]\n[00:16.00]\n[01:02.25] Second line");
  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed[0], { time: 12.5, text: "First line" });
  assert.deepEqual(parsed[1], { time: 15, text: "" });
  assert.deepEqual(parsed[2], { time: 62.25, text: "Second line" });
});

test("Email OTP account flow sends code, verifies session, updates profile, and logs out", async () => {
  const unauth = await fetch(`${baseUrl}/api/auth/me`);
  assert.equal(unauth.status, 200);
  assert.deepEqual(await unauth.json(), { authenticated: false, user: null });

  const badEmail = await fetch(`${baseUrl}/api/auth/request-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "not-an-email" }),
  });
  assert.equal(badEmail.status, 400);

  const reqRes = await fetch(`${baseUrl}/api/auth/request-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "Tester@Example.com" }),
  });
  assert.equal(reqRes.status, 200);
  const reqBody = await reqRes.json();
  assert.equal(reqBody.ok, true);
  assert.equal(reqBody.email, "tester@example.com");
  assert.equal(reqBody.devCode, undefined);

  const code = sentEmails.get("tester@example.com");
  assert.match(code, /^\d{6}$/);

  // Immediate resend hits 30s cooldown
  const cooldownRes = await fetch(`${baseUrl}/api/auth/request-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "tester@example.com" }),
  });
  assert.equal(cooldownRes.status, 429);

  // Wrong code rejected with remaining attempts
  const wrongVerify = await fetch(`${baseUrl}/api/auth/verify-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "tester@example.com", code: "000000" === code ? "111111" : "000000" }),
  });
  assert.equal(wrongVerify.status, 400);

  // Correct code sets HttpOnly session cookie
  const verifyRes = await fetch(`${baseUrl}/api/auth/verify-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "tester@example.com", code }),
  });
  assert.equal(verifyRes.status, 200);
  const setCookie = verifyRes.headers.get("set-cookie") || "";
  assert.match(setCookie, /simple_session=[^;]+/);
  assert.match(setCookie, /HttpOnly/i);
  const cookieHeader = setCookie.split(";")[0];

  const verifyBody = await verifyRes.json();
  assert.equal(verifyBody.user.email, "tester@example.com");

  // Session persists on /api/auth/me
  const meRes = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Cookie: cookieHeader },
  });
  const meBody = await meRes.json();
  assert.equal(meBody.authenticated, true);
  assert.equal(meBody.user.email, "tester@example.com");

  // Profile & preferences update
  const patchRes = await fetch(`${baseUrl}/api/auth/profile`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookieHeader,
    },
    body: JSON.stringify({
      displayName: "Hunter",
      preferences: {
        searchEngine: "brave",
        favoriteGames: ["1", "24"],
        savedTracks: [{ id: "99", title: "Track", artist: "Artist", protocol: "hls" }],
      },
    }),
  });
  assert.equal(patchRes.status, 200);
  const patched = await patchRes.json();
  assert.equal(patched.user.displayName, "Hunter");
  assert.equal(patched.user.preferences.searchEngine, "brave");
  assert.deepEqual(patched.user.preferences.favoriteGames, ["1", "24"]);
  assert.equal(patched.user.preferences.savedTracks.length, 1);

  // Logout revokes session
  const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
    method: "POST",
    headers: { Cookie: cookieHeader },
  });
  assert.equal(logoutRes.status, 200);

  const afterLogout = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Cookie: cookieHeader },
  });
  assert.deepEqual(await afterLogout.json(), { authenticated: false, user: null });
});

test("getConfiguredDeliveryMode selects resend, smtp, or dev based on env", () => {
  const prev = {
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    SMTP_HOST: process.env.SMTP_HOST,
    SMTP_URL: process.env.SMTP_URL,
  };
  try {
    delete process.env.RESEND_API_KEY;
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_URL;
    assert.equal(getConfiguredDeliveryMode(), "dev");

    process.env.SMTP_HOST = "smtp.example.com";
    assert.equal(getConfiguredDeliveryMode(), "smtp");

    process.env.RESEND_API_KEY = "re_test";
    assert.equal(getConfiguredDeliveryMode(), "resend");
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

async function signInAs(email) {
  const reqRes = await fetch(`${baseUrl}/api/auth/request-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  assert.equal(reqRes.status, 200);
  const code = sentEmails.get(email.toLowerCase());
  const verifyRes = await fetch(`${baseUrl}/api/auth/verify-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, code }),
  });
  assert.equal(verifyRes.status, 200);
  const cookie = (verifyRes.headers.get("set-cookie") || "").split(";")[0];
  const body = await verifyRes.json();
  return { cookie, user: body.user };
}

test("AI conversations save per account and stay private", async () => {
  const alice = await signInAs("alice-ai@example.com");
  const bob = await signInAs("bob-ai@example.com");
  const id = "11111111-2222-3333-4444-555555555555";
  const url = `${baseUrl}/api/ai/conversations/${id}`;
  const json = { "Content-Type": "application/json" };

  // Signed-out requests are rejected
  assert.equal((await fetch(`${baseUrl}/api/ai/conversations`)).status, 401);

  const put = await fetch(url, {
    method: "PUT",
    headers: { ...json, Cookie: alice.cookie },
    body: JSON.stringify({
      model: "deepseek/deepseek-v4.1-flash",
      messages: [
        { role: "user", content: "What is 12 * 12?" },
        { role: "assistant", content: "144" },
      ],
    }),
  });
  assert.equal(put.status, 200);
  assert.equal((await put.json()).conversation.title, "What is 12 * 12?");

  const list = await (
    await fetch(`${baseUrl}/api/ai/conversations`, { headers: { Cookie: alice.cookie } })
  ).json();
  assert.equal(list.conversations.length, 1);

  // Bob cannot read, list, or delete Alice's conversation
  assert.equal((await fetch(url, { headers: { Cookie: bob.cookie } })).status, 404);
  const bobList = await (
    await fetch(`${baseUrl}/api/ai/conversations`, { headers: { Cookie: bob.cookie } })
  ).json();
  assert.equal(bobList.conversations.length, 0);
  await fetch(url, { method: "DELETE", headers: { Cookie: bob.cookie } });
  const still = await fetch(url, { headers: { Cookie: alice.cookie } });
  assert.equal(still.status, 200);
  assert.equal((await still.json()).conversation.messages.length, 2);

  // Malformed ids are rejected
  const bad = await fetch(`${baseUrl}/api/ai/conversations/bad%20id`, {
    method: "PUT",
    headers: { ...json, Cookie: alice.cookie },
    body: JSON.stringify({ messages: [{ role: "user", content: "x" }] }),
  });
  assert.equal(bad.status, 400);

  // The owner can delete their own
  await fetch(url, { method: "DELETE", headers: { Cookie: alice.cookie } });
  assert.equal((await fetch(url, { headers: { Cookie: alice.cookie } })).status, 404);
});

test("PFPs, owner role for mr.eggg62@gmail.com, and logged-in chat room work end-to-end", async () => {
  // Unauthenticated chat requests rejected
  assert.equal((await fetch(`${baseUrl}/api/chat/messages`)).status, 401);
  assert.equal(
    (
      await fetch(`${baseUrl}/api/chat/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "nope" }),
      })
    ).status,
    401
  );

  await assert.rejects(
    () =>
      new Promise((resolve, reject) => {
        const ws = new WsClient(`${wsBaseUrl}/ws/chat`);
        ws.on("open", () => {
          ws.close();
          resolve();
        });
        ws.on("error", () => reject(new Error("401 rejected")));
      }),
    /401 rejected/
  );

  // Sign in regular member & owner
  const member = await signInAs("member1@example.com");
  assert.equal(member.user.isOwner, false);
  assert.equal(member.user.role, "member");

  const owner = await signInAs("mr.eggg62@gmail.com");
  assert.equal(owner.user.isOwner, true);
  assert.equal(owner.user.role, "owner");

  // PFP validation & update
  const badSvg = await fetch(`${baseUrl}/api/auth/profile`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: owner.cookie },
    body: JSON.stringify({ avatarUrl: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" }),
  });
  assert.equal(badSvg.status, 400);

  const validPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const goodPfp = await fetch(`${baseUrl}/api/auth/profile`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: owner.cookie },
    body: JSON.stringify({ displayName: "Eggg", avatarUrl: validPng }),
  });
  assert.equal(goodPfp.status, 200);
  const updatedOwner = (await goodPfp.json()).user;
  assert.equal(updatedOwner.avatarUrl, validPng);
  assert.equal(updatedOwner.isOwner, true);

  // Connect member to chat WebSocket, send message via owner, verify live broadcast
  const wsEvents = [];
  const ws = new WsClient(`${wsBaseUrl}/ws/chat`, {
    headers: { Cookie: member.cookie },
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WS history timeout")), 3000);
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      wsEvents.push(msg);
      if (msg.type === "history") {
        clearTimeout(timer);
        resolve();
      }
    });
    ws.on("error", reject);
  });

  const memberPost = await fetch(`${baseUrl}/api/chat/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: member.cookie },
    body: JSON.stringify({ text: "Hello from member!" }),
  });
  assert.equal(memberPost.status, 201);
  const memberMsgId = (await memberPost.json()).message.id;

  const ownerPost = await fetch(`${baseUrl}/api/chat/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: owner.cookie },
    body: JSON.stringify({ text: "Owner message!", replyTo: memberMsgId }),
  });
  assert.equal(ownerPost.status, 201);
  const ownerMsg = (await ownerPost.json()).message;
  assert.equal(ownerMsg.author.isOwner, true);
  assert.equal(ownerMsg.author.avatarUrl, validPng);
  assert.equal(ownerMsg.replyTo?.id, memberMsgId);
  assert.equal(ownerMsg.replyTo?.textSnippet, "Hello from member!");

  // Wait briefly for WS messages to arrive
  await new Promise((r) => setTimeout(r, 80));
  const historyEvent = wsEvents.find((e) => e.type === "history");
  assert.ok(Array.isArray(historyEvent?.onlineUsers));
  assert.ok(wsEvents.some((e) => e.type === "message" && e.message.text === "Owner message!"));

  // Member cannot delete owner's message or clear chat
  const forbiddenDel = await fetch(`${baseUrl}/api/chat/messages/${ownerMsg.id}`, {
    method: "DELETE",
    headers: { Cookie: member.cookie },
  });
  assert.equal(forbiddenDel.status, 403);

  const forbiddenClear = await fetch(`${baseUrl}/api/chat/messages`, {
    method: "DELETE",
    headers: { Cookie: member.cookie },
  });
  assert.equal(forbiddenClear.status, 403);

  // Owner CAN delete member's message and clear chat
  const ownerDel = await fetch(`${baseUrl}/api/chat/messages/${memberMsgId}`, {
    method: "DELETE",
    headers: { Cookie: owner.cookie },
  });
  assert.equal(ownerDel.status, 200);

  const ownerClear = await fetch(`${baseUrl}/api/chat/messages`, {
    method: "DELETE",
    headers: { Cookie: owner.cookie },
  });
  assert.equal(ownerClear.status, 200);

  ws.close();
});
