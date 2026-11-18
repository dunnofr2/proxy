import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import express from "express";
import { uvPath } from "@titaniumnetwork-dev/ultraviolet";
import { baremuxPath } from "@mercuryworkshop/bare-mux/node";
import { epoxyPath } from "@mercuryworkshop/epoxy-transport";
import { server as wisp } from "@mercuryworkshop/wisp-js/server";
import {
  isAllowedSoundCloudMediaUrl,
  resolveTrackStream,
  rewriteM3u8,
  searchSoundCloud,
} from "./soundcloud.js";
import { fetchLyrics } from "./lyrics.js";
import {
  AuthError,
  SESSION_COOKIE_NAME,
  createAuthService,
  formatSessionCookie,
  parseCookies,
} from "./auth.js";
import { createChatService } from "./chat.js";
import { AiStoreError, createAiStore } from "./ai-store.js";
import {
  AiError,
  MODELS,
  checkRateLimit,
  isAiConfigured,
  resolveModel,
  sanitizeMessages,
  streamChat,
} from "./ai.js";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const publicPath = join(__dirname, "..", "public");
const libcurlPath = join(dirname(require.resolve("@mercuryworkshop/libcurl-transport")), "..", "dist");
const hlsPath = join(dirname(require.resolve("hls.js/package.json")), "dist");

const UV_PREFIX = "/service/";
const WISP_PATH = "/wisp/";
const CHAT_WS_PATH = "/ws/chat";

function applyWispEnvOptions() {
  wisp.options.allow_private_ips = process.env.WISP_ALLOW_PRIVATE_IPS === "true";
  wisp.options.allow_loopback_ips = process.env.WISP_ALLOW_LOOPBACK_IPS === "true";
  wisp.options.allow_direct_ip = process.env.WISP_ALLOW_DIRECT_IP !== "false";
}
applyWispEnvOptions();

/**
 * Cold-start fallback HTML served only when `/app/*` reaches Express directly
 * (meaning the Service Worker has not yet been registered or activated).
 */
const SERVICE_BOOTSTRAP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Initializing Proxy…</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      font-family: system-ui, -apple-system, sans-serif;
      background: #0b0d14;
      color: #e5e7eb;
    }
    .card {
      max-width: 420px;
      padding: 28px;
      border-radius: 14px;
      background: #141824;
      border: 1px solid rgba(168, 85, 247, 0.35);
      text-align: center;
    }
    .muted { color: #9ca3af; font-size: 14px; }
    .err { color: #f87171; font-size: 14px; margin-top: 12px; }
  </style>
</head>
<body>
  <div class="card">
    <h2>Starting Proxy…</h2>
    <p class="muted" id="msg">Initializing transport.</p>
    <p class="err" id="err"></p>
  </div>
  <script src="/lib/core.bundle.js"></script>
  <script src="/app.cfg.js"></script>
  <script type="module">
    const loadMux = async () => {
      const mod = await import("/bm/index.mjs");
      return mod.BareMuxConnection;
    };

    async function bootstrap() {
      if (!("serviceWorker" in navigator)) {
        throw new Error("Service Workers require HTTPS or localhost.");
      }

      const reg = await navigator.serviceWorker.register("/sw.js", {
        scope: __uv$config.prefix,
      });

      if (!reg.active) {
        const sw = reg.installing || reg.waiting;
        if (sw) {
          await new Promise((resolve, reject) => {
            const onChange = () => {
              if (sw.state === "activated") {
                sw.removeEventListener("statechange", onChange);
                resolve();
              } else if (sw.state === "redundant") {
                sw.removeEventListener("statechange", onChange);
                reject(new Error("Service worker failed to activate."));
              }
            };
            sw.addEventListener("statechange", onChange);
            onChange();
          });
        }
      }

      const ConnClass = await loadMux();
      const connection = new ConnClass("/bm/worker.js");
      const wispUrl =
        localStorage.getItem("uv_wisp_url") ||
        (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/wisp/";
      await connection.setTransport("/net/client.mjs", [{ wisp: wispUrl }]);
      location.reload();
    }

    bootstrap().catch((e) => {
      document.getElementById("msg").textContent = "Unable to initialize proxy:";
      document.getElementById("err").textContent = e?.message || String(e);
    });
  </script>
</body>
</html>`;

async function proxyMediaStream(targetUrl, req, res) {
  const headers = {};
  if (req.headers.range) {
    headers.range = req.headers.range;
  }
  const upstream = await fetch(targetUrl, {
    headers,
    signal: AbortSignal.timeout(15000),
  });
  if (!upstream.ok && upstream.status !== 206) {
    res.status(upstream.status).type("text/plain").send("Upstream media error");
    await upstream.body?.cancel();
    return;
  }

  res.status(upstream.status);
  for (const name of ["content-type", "content-length", "content-range", "accept-ranges"]) {
    const val = upstream.headers.get(name);
    if (val) res.setHeader(name, val);
  }
  if (!upstream.body) {
    res.end();
    return;
  }

  const nodeStream = Readable.fromWeb(upstream.body);
  res.on("close", () => nodeStream.destroy());
  nodeStream.on("error", () => {
    if (!res.headersSent) res.status(502);
    res.end();
  });
  nodeStream.pipe(res);
}

export function createProxyApp({
  authService = createAuthService(),
  chatService = createChatService({ authService }),
  aiStore = createAiStore(),
} = {}) {
  const app = express();
  app.disable("x-powered-by");

  app.use((_req, res, next) => {
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
    next();
  });

  const getSessionToken = (req) => parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME] || "";
  const isSecureReq = (req) =>
    Boolean(req.secure || req.headers["x-forwarded-proto"] === "https");
  const handleAuthErr = (res, err) => {
    if (err instanceof AuthError) {
      res.status(err.status).json({ error: err.message, ...err.extra });
      return;
    }
    res.status(500).json({ error: err?.message || "Internal auth error" });
  };
  const requireAuthUser = async (req) => {
    const user = await authService.getUserByToken(getSessionToken(req));
    if (!user) throw new AuthError("Sign in required.", 401);
    return user;
  };

  // Serve our public assets first so custom /sw.js and /uv.config.js take precedence.
  // sw.js and app.cfg.js must never be cached — the scanner reads stale copies.
  app.get("/sw.js", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/javascript");
    res.sendFile(join(publicPath, "sw.js"));
  });
  app.get("/app.cfg.js", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/javascript");
    res.sendFile(join(publicPath, "app.cfg.js"));
  });
  app.use(express.static(publicPath));

  // Serve the renamed bundle filename explicitly — the underlying package
  // only ships the file as uv.bundle.js, so a plain static mount can't
  // satisfy a request for /lib/core.bundle.js.
  app.get("/lib/core.bundle.js", (_req, res) => {
    res.sendFile(join(uvPath, "uv.bundle.js"));
  });

  app.get("/io/main.mjs", (_req, res) => {
    res.setHeader("Content-Type", "application/javascript");
    res.sendFile(join(epoxyPath, "index.mjs"));
  });
  app.get("/net/client.mjs", (_req, res) => {
    res.setHeader("Content-Type", "application/javascript");
    res.sendFile(join(libcurlPath, "index.mjs"));
  });

  // Serve core scripts at /uv/, plus bare-mux, Epoxy, and hls.js.
  app.use("/uv/", express.static(uvPath));
  app.use("/", express.static(uvPath));
  app.use("/baremux/", express.static(baremuxPath));
  app.use("/bm/", express.static(baremuxPath));
  app.use("/epoxy/", express.static(epoxyPath));
  app.use("/libcurl/", express.static(libcurlPath));
  app.use("/lc/", express.static(libcurlPath));
  app.use("/hls/", express.static(hlsPath));

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      engine: "ultraviolet",
      prefix: UV_PREFIX,
      wisp: WISP_PATH,
      transport: "libcurl",
    });
  });

  // Email OTP account & session routes
  app.use("/api/auth", express.json({ limit: "256kb" }));

  app.get("/api/auth/me", async (req, res) => {
    try {
      const user = await authService.getUserByToken(getSessionToken(req));
      res.json({ authenticated: Boolean(user), user });
    } catch (err) {
      handleAuthErr(res, err);
    }
  });

  app.post("/api/auth/request-code", async (req, res) => {
    try {
      const result = await authService.requestCode(req.body?.email);
      res.json(result);
    } catch (err) {
      handleAuthErr(res, err);
    }
  });

  app.post("/api/auth/verify-code", async (req, res) => {
    try {
      const { token, user } = await authService.verifyCode(
        req.body?.email,
        req.body?.code
      );
      res.setHeader(
        "Set-Cookie",
        formatSessionCookie(token, { secure: isSecureReq(req) })
      );
      res.json({ ok: true, user });
    } catch (err) {
      handleAuthErr(res, err);
    }
  });

  app.post("/api/auth/logout", async (req, res) => {
    try {
      await authService.logout(getSessionToken(req));
      res.setHeader(
        "Set-Cookie",
        formatSessionCookie("", { secure: isSecureReq(req), maxAgeSec: 0 })
      );
      res.json({ ok: true });
    } catch (err) {
      handleAuthErr(res, err);
    }
  });

  app.patch("/api/auth/profile", async (req, res) => {
    try {
      const user = await authService.updateProfile(getSessionToken(req), req.body);
      chatService.broadcastUserUpdate(user);
      res.json({ ok: true, user });
    } catch (err) {
      handleAuthErr(res, err);
    }
  });

  app.delete("/api/auth/account", async (req, res) => {
    try {
      const doomed = await authService.getUserByToken(getSessionToken(req));
      await authService.deleteAccount(getSessionToken(req));
      if (doomed) await aiStore.removeUser(doomed.id);
      res.setHeader(
        "Set-Cookie",
        formatSessionCookie("", { secure: isSecureReq(req), maxAgeSec: 0 })
      );
      res.json({ ok: true });
    } catch (err) {
      handleAuthErr(res, err);
    }
  });

  // Chat room routes (logged-in users only)
  app.use("/api/chat", express.json({ limit: "16kb" }));

  app.get("/api/chat/messages", async (req, res) => {
    try {
      await requireAuthUser(req);
      const messages = await chatService.getMessages(100);
      res.json({ messages });
    } catch (err) {
      handleAuthErr(res, err);
    }
  });

  app.post("/api/chat/messages", async (req, res) => {
    try {
      const user = await requireAuthUser(req);
      const message = await chatService.postMessage(
        user,
        req.body?.text,
        req.body?.replyTo || null
      );
      res.status(201).json({ message });
    } catch (err) {
      handleAuthErr(res, err);
    }
  });

  app.delete("/api/chat/messages/:id", async (req, res) => {
    try {
      const user = await requireAuthUser(req);
      await chatService.deleteMessage(user, req.params.id);
      res.json({ ok: true });
    } catch (err) {
      handleAuthErr(res, err);
    }
  });

  app.delete("/api/chat/messages", async (req, res) => {
    try {
      const user = await requireAuthUser(req);
      await chatService.clearMessages(user);
      res.json({ ok: true });
    } catch (err) {
      handleAuthErr(res, err);
    }
  });

  // AI assistant (OpenRouter). Signed-in users only so strangers can't spend API credits.
  app.use("/api/ai", express.json({ limit: "128kb" }));

  app.get("/api/ai/status", (_req, res) => {
    res.json({ configured: isAiConfigured(), models: MODELS });
  });

  const handleAiStoreErr = (res, err) => {
    if (err instanceof AiStoreError) {
      res.status(err.status).json({ error: err.message });
    } else if (err instanceof AuthError) {
      handleAuthErr(res, err);
    } else {
      res.status(500).json({ error: "Could not complete that request." });
    }
  };

  app.get("/api/ai/conversations", async (req, res) => {
    try {
      const user = await requireAuthUser(req);
      res.json({ conversations: await aiStore.list(user.id) });
    } catch (err) {
      handleAiStoreErr(res, err);
    }
  });

  app.get("/api/ai/conversations/:id", async (req, res) => {
    try {
      const user = await requireAuthUser(req);
      res.json({ conversation: await aiStore.get(user.id, req.params.id) });
    } catch (err) {
      handleAiStoreErr(res, err);
    }
  });

  app.put("/api/ai/conversations/:id", async (req, res) => {
    try {
      const user = await requireAuthUser(req);
      const saved = await aiStore.save(user.id, req.params.id, {
        messages: req.body?.messages,
        model: req.body?.model,
      });
      res.json({ conversation: saved });
    } catch (err) {
      handleAiStoreErr(res, err);
    }
  });

  app.delete("/api/ai/conversations/:id", async (req, res) => {
    try {
      const user = await requireAuthUser(req);
      await aiStore.remove(user.id, req.params.id);
      res.json({ ok: true });
    } catch (err) {
      handleAiStoreErr(res, err);
    }
  });

  app.post("/api/ai/chat", async (req, res) => {
    let messages;
    let model;
    try {
      const user = await requireAuthUser(req);
      messages = sanitizeMessages(req.body?.messages);
      model = resolveModel(req.body?.model);
      checkRateLimit(user.id);
    } catch (err) {
      if (err instanceof AiError) {
        res.status(err.status).json({ error: err.message });
      } else {
        handleAuthErr(res, err);
      }
      return;
    }

    const abort = new AbortController();
    res.on("close", () => abort.abort());
    try {
      const stream = streamChat(messages, { model, signal: abort.signal });
      const first = await stream.next();
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Accel-Buffering", "no");
      if (!first.done) res.write(first.value);
      for await (const delta of stream) res.write(delta);
      res.end();
    } catch (err) {
      if (abort.signal.aborted) return;
      if (!res.headersSent) {
        res.status(err?.status || 502).json({ error: err?.message || "AI request failed." });
      } else {
        res.end("\n\n[Response interrupted]");
      }
    }
  });

  // SoundCloud music search & audio streaming routes
  app.get("/api/music/search", async (req, res) => {
    const q = String(req.query.q || "").trim();
    if (!q) {
      res.status(400).json({ error: "Missing search query parameter q" });
      return;
    }
    try {
      const tracks = await searchSoundCloud(q, 15);
      res.json({ tracks });
    } catch (err) {
      res.status(502).json({ error: err?.message || "SoundCloud search failed" });
    }
  });

  app.get("/api/music/stream/:id", async (req, res) => {
    try {
      const resolved = await resolveTrackStream(req.params.id);
      if (resolved.protocol !== "progressive") {
        res.redirect(302, `/api/music/playlist/${resolved.id}.m3u8`);
        return;
      }
      await proxyMediaStream(resolved.url, req, res);
    } catch (err) {
      res.status(502).json({ error: err?.message || "SoundCloud stream failed" });
    }
  });

  app.get("/api/music/playlist/:file", async (req, res) => {
    const id = String(req.params.file || "").replace(/\.m3u8$/i, "");
    try {
      const resolved = await resolveTrackStream(id);
      if (resolved.protocol === "progressive") {
        res.status(400).json({ error: "Track is progressive, use /api/music/stream/:id" });
        return;
      }
      const plRes = await fetch(resolved.url, { signal: AbortSignal.timeout(10000) });
      if (!plRes.ok) {
        res.status(plRes.status).type("text/plain").send("Failed to fetch playlist");
        return;
      }
      const rawM3u8 = await plRes.text();
      const rewritten = rewriteM3u8(rawM3u8, resolved.url);
      res.status(200).type("application/vnd.apple.mpegurl").send(rewritten);
    } catch (err) {
      res.status(502).json({ error: err?.message || "Failed to load playlist" });
    }
  });

  app.get("/api/music/segment", async (req, res) => {
    const targetUrl = String(req.query.url || "");
    if (!isAllowedSoundCloudMediaUrl(targetUrl)) {
      res.status(400).type("text/plain").send("Invalid media URL");
      return;
    }
    try {
      await proxyMediaStream(targetUrl, req, res);
    } catch (err) {
      res.status(502).type("text/plain").send(err?.message || "Segment fetch failed");
    }
  });

  app.get("/api/music/lyrics", async (req, res) => {
    const title = String(req.query.title || "").trim();
    const artist = String(req.query.artist || "").trim();
    const durationSec = Number(req.query.duration || 0);
    if (!title) {
      res.status(400).json({ error: "Missing title parameter" });
      return;
    }
    try {
      const result = await fetchLyrics({ title, artist, durationSec });
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err?.message || "Lyrics lookup failed" });
    }
  });

  // Fallback for direct hits to proxied URLs before the SW is active on the client.
  app.use(UV_PREFIX, (_req, res) => {
    res.status(200).type("html").send(SERVICE_BOOTSTRAP_HTML);
  });

  app.use((_req, res) => {
    res.status(404).type("text/plain").send("404 Not Found");
  });

  return app;
}

export function createProxyServer({
  authService = createAuthService(),
  chatService = createChatService({ authService }),
  aiStore = createAiStore(),
} = {}) {
  const app = createProxyApp({ authService, chatService, aiStore });
  const server = createServer(app);

  server.on("upgrade", (req, socket, head) => {
    const reqUrl = req.url || "";
    if (reqUrl === CHAT_WS_PATH || reqUrl.startsWith(`${CHAT_WS_PATH}?`)) {
      chatService.handleUpgrade(req, socket, head);
      return;
    }
    if (reqUrl === "/wisp") {
      req.url = "/wisp/";
    }
    if (req.url?.startsWith(WISP_PATH)) {
      wisp.routeRequest(req, socket, head);
    } else {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
    }
  });

  server.on("close", () => chatService.close());
  return server;
}

export function startProxyServer(
  port = Number.parseInt(process.env.PORT ?? "3000", 10),
  host = process.env.HOST || "127.0.0.1"
) {
  applyWispEnvOptions();
  const server = createProxyServer();

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `Port ${port} on ${host} is already in use. Set PORT=<other_port> (e.g. PORT=3001 npm start).`
      );
      process.exit(1);
    }
    throw err;
  });

  server.listen(port, host, () => {
    const addr = server.address();
    const boundPort = typeof addr === "object" && addr ? addr.port : port;
    const displayHost =
      host === "0.0.0.0" || host === "::" || host === "127.0.0.1"
        ? "localhost"
        : host;
    console.log(`Web Proxy listening on http://${displayHost}:${boundPort}`);
    console.log(`WebSocket endpoint available at ws://${displayHost}:${boundPort}${WISP_PATH}`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return server;
}

const currentFile = fileURLToPath(import.meta.url);
const entryFile = process.argv[1] ? resolve(process.argv[1]) : "";
const isMainModule =
  process.platform === "win32"
    ? currentFile.toLowerCase() === entryFile.toLowerCase()
    : currentFile === entryFile;

if (isMainModule) {
  const envPath = join(__dirname, "..", ".env");
  if (existsSync(envPath) && typeof process.loadEnvFile === "function") {
    process.loadEnvFile(envPath);
  }
  startProxyServer();
}
