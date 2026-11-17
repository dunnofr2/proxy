const SOUNDCLOUD_HOME = "https://soundcloud.com";
const SOUNDCLOUD_API_V2 = "https://api-v2.soundcloud.com";
const CLIENT_ID_TTL_MS = 30 * 60 * 1000;
const ALLOWED_MEDIA_HOST_RE = /^([a-z0-9-]+\.)*(sndcdn\.com|soundcloud\.cloud)$/i;

let cachedClientId = process.env.SOUNDCLOUD_CLIENT_ID || null;
let cachedAt = cachedClientId ? Date.now() : 0;
let clientIdPromise = null;

export function isAllowedSoundCloudMediaUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return (
      parsed.protocol === "https:" &&
      ALLOWED_MEDIA_HOST_RE.test(parsed.hostname)
    );
  } catch {
    return false;
  }
}

export async function getClientId(forceRefresh = false) {
  if (process.env.SOUNDCLOUD_CLIENT_ID) {
    return process.env.SOUNDCLOUD_CLIENT_ID;
  }
  if (
    !forceRefresh &&
    cachedClientId &&
    Date.now() - cachedAt < CLIENT_ID_TTL_MS
  ) {
    return cachedClientId;
  }
  if (clientIdPromise && !forceRefresh) {
    return clientIdPromise;
  }

  clientIdPromise = (async () => {
    const homeRes = await fetch(SOUNDCLOUD_HOME, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!homeRes.ok) {
      throw new Error(`SoundCloud homepage returned HTTP ${homeRes.status}`);
    }
    const html = await homeRes.text();
    const scriptUrls = [
      ...html.matchAll(/https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js/g),
    ].map((m) => m[0]);

    for (const scriptUrl of scriptUrls.slice().reverse()) {
      const jsRes = await fetch(scriptUrl, { signal: AbortSignal.timeout(8000) });
      if (!jsRes.ok) continue;
      const js = await jsRes.text();
      const match = js.match(/client_id\s*:\s*"([a-zA-Z0-9]{20,40})"/);
      if (match) {
        cachedClientId = match[1];
        cachedAt = Date.now();
        return cachedClientId;
      }
    }

    throw new Error("Could not extract SoundCloud client_id");
  })().finally(() => {
    clientIdPromise = null;
  });

  return clientIdPromise;
}

async function fetchSoundCloudJson(pathAndQuery) {
  let clientId = await getClientId(false);
  const sep = pathAndQuery.includes("?") ? "&" : "?";
  let res = await fetch(
    `${SOUNDCLOUD_API_V2}${pathAndQuery}${sep}client_id=${encodeURIComponent(clientId)}`,
    { signal: AbortSignal.timeout(8000) }
  );

  if ((res.status === 401 || res.status === 403) && !process.env.SOUNDCLOUD_CLIENT_ID) {
    clientId = await getClientId(true);
    res = await fetch(
      `${SOUNDCLOUD_API_V2}${pathAndQuery}${sep}client_id=${encodeURIComponent(clientId)}`,
      { signal: AbortSignal.timeout(8000) }
    );
  }

  if (!res.ok) {
    throw new Error(`SoundCloud API returned HTTP ${res.status}`);
  }
  return { data: await res.json(), clientId };
}

export function pickPlayableTranscoding(track) {
  const list = track?.media?.transcodings;
  if (!Array.isArray(list) || list.length === 0) return null;

  const isEncrypted = (tr) =>
    typeof tr?.format?.protocol === "string" &&
    tr.format.protocol.includes("encrypted");

  // Prefer unencrypted progressive MP3 when available.
  const progressive = list.find(
    (tr) => !isEncrypted(tr) && tr?.format?.protocol === "progressive" && tr.url
  );
  if (progressive) return progressive;

  // Prefer unencrypted AAC fMP4 HLS (aac_160k, then aac_96k, then other unencrypted non-mpegurl HLS).
  const hlsCandidates = list.filter(
    (tr) =>
      !isEncrypted(tr) &&
      tr?.format?.protocol === "hls" &&
      tr.url &&
      tr.format?.mime_type !== "audio/mpegurl"
  );
  if (hlsCandidates.length === 0) return null;

  return (
    hlsCandidates.find((tr) => tr.preset === "aac_160k") ||
    hlsCandidates.find((tr) => tr.preset === "aac_96k") ||
    hlsCandidates.find((tr) => tr.format?.mime_type?.includes("audio/mp4")) ||
    hlsCandidates[0]
  );
}

export function normalizeTrack(track) {
  const transcoding = pickPlayableTranscoding(track);
  if (!transcoding || !track?.id) return null;

  const rawArtwork = track.artwork_url || track.user?.avatar_url || "";
  const artwork = rawArtwork
    ? rawArtwork.replace("-large.", "-t200x200.")
    : "";

  return {
    id: String(track.id),
    title: track.title || "Untitled",
    artist: track.user?.username || "Unknown Artist",
    durationMs: Number(transcoding.duration || track.duration || 0),
    snipped: Boolean(transcoding.snipped || track.policy === "SNIP"),
    artwork,
    protocol: transcoding.format.protocol,
    mimeType: transcoding.format.mime_type || "",
    permalink: track.permalink_url || "",
  };
}

export async function searchSoundCloud(query, limit = 15) {
  const trimmed = String(query || "").trim();
  if (!trimmed) return [];

  const fetchLimit = Math.min(Math.max(limit * 2, 20), 40);
  const { data } = await fetchSoundCloudJson(
    `/search/tracks?q=${encodeURIComponent(trimmed)}&limit=${fetchLimit}`
  );

  const items = Array.isArray(data?.collection) ? data.collection : [];
  const tracks = [];
  for (const raw of items) {
    const normalized = normalizeTrack(raw);
    if (normalized) {
      tracks.push(normalized);
      if (tracks.length >= limit) break;
    }
  }
  return tracks;
}

export async function resolveTrackStream(trackId) {
  const safeId = String(trackId || "").replace(/[^0-9]/g, "");
  if (!safeId) {
    throw new Error("Invalid track ID");
  }

  const { data: track, clientId } = await fetchSoundCloudJson(`/tracks/${safeId}`);
  const transcoding = pickPlayableTranscoding(track);
  if (!transcoding) {
    throw new Error("Track has no unencrypted playable stream");
  }

  const sep = transcoding.url.includes("?") ? "&" : "?";
  const resolvedRes = await fetch(
    `${transcoding.url}${sep}client_id=${encodeURIComponent(clientId)}`,
    { signal: AbortSignal.timeout(8000) }
  );
  if (!resolvedRes.ok) {
    throw new Error(`Failed to resolve stream URL (HTTP ${resolvedRes.status})`);
  }
  const resolved = await resolvedRes.json();
  if (!resolved?.url || !isAllowedSoundCloudMediaUrl(resolved.url)) {
    throw new Error("Upstream returned an invalid stream URL");
  }

  return {
    id: safeId,
    url: resolved.url,
    protocol: transcoding.format.protocol,
    mimeType: transcoding.format.mime_type || "",
  };
}

export function rewriteM3u8(m3u8Text, basePlaylistUrl, proxyPrefix = "/api/music/segment?url=") {
  const toProxyUrl = (raw) => {
    const abs = new URL(raw, basePlaylistUrl).href;
    if (!isAllowedSoundCloudMediaUrl(abs)) {
      throw new Error("Disallowed media segment host in playlist");
    }
    return `${proxyPrefix}${encodeURIComponent(abs)}`;
  };

  return m3u8Text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith("#EXT-X-MAP:")) {
        return line.replace(/URI="([^"]+)"/i, (_, uri) => `URI="${toProxyUrl(uri)}"`);
      }
      if (trimmed.startsWith("#")) return line;
      return toProxyUrl(trimmed);
    })
    .join("\n");
}
