const YOUTUBEI_BASE = "https://www.youtube.com/youtubei/v1";
const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;
const ALLOWED_YT_MEDIA_HOST_RE = /^([a-z0-9-]+\.)*googlevideo\.com$/i;
const STREAM_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 100;

const PLAYER_CLIENTS = [
  {
    ua: "com.google.android.youtube/20.10.38 (Linux; U; Android 14)",
    client: {
      clientName: "ANDROID",
      clientVersion: "20.10.38",
      androidSdkVersion: 34,
      osName: "Android",
      osVersion: "14",
      hl: "en",
      gl: "US",
    },
  },
  {
    ua: "com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1)",
    client: {
      clientName: "ANDROID_VR",
      clientVersion: "1.60.19",
      androidSdkVersion: 32,
      osName: "Android",
      osVersion: "12L",
      deviceMake: "Oculus",
      deviceModel: "Quest 3",
      hl: "en",
      gl: "US",
    },
  },
];

const WEB_SEARCH_CLIENT = {
  clientName: "WEB",
  clientVersion: "2.20250201.00.00",
  hl: "en",
  gl: "US",
};

const streamCache = new Map();

export function isValidYouTubeVideoId(id) {
  return typeof id === "string" && VIDEO_ID_RE.test(id.trim());
}

export function isAllowedYouTubeMediaUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return (
      parsed.protocol === "https:" &&
      ALLOWED_YT_MEDIA_HOST_RE.test(parsed.hostname)
    );
  } catch {
    return false;
  }
}

export function pickPlayableFormat(formats) {
  if (!Array.isArray(formats) || formats.length === 0) return null;
  const valid = formats.filter(
    (f) =>
      f?.url &&
      isAllowedYouTubeMediaUrl(f.url) &&
      typeof f.mimeType === "string" &&
      f.mimeType.startsWith("video/")
  );
  if (valid.length === 0) return null;

  valid.sort((a, b) => (Number(b.height) || 0) - (Number(a.height) || 0));
  return valid[0];
}

async function fetchOembedMetadata(cleanId) {
  try {
    const watchUrl = `https://www.youtube.com/watch?v=${cleanId}`;
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`,
      {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(6000),
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return {
      title: data?.title || "YouTube Video",
      author: data?.author_name || "YouTube",
    };
  } catch {
    return null;
  }
}

export async function resolveYouTubeVideo(videoId) {
  const cleanId = String(videoId || "").trim();
  if (!isValidYouTubeVideoId(cleanId)) {
    throw new Error("Invalid YouTube video ID");
  }

  const cached = streamCache.get(cleanId);
  if (cached && Date.now() - cached.cachedAt < STREAM_CACHE_TTL_MS) {
    return cached.value;
  }

  let lastReason = "";
  for (const entry of PLAYER_CLIENTS) {
    try {
      const res = await fetch(`${YOUTUBEI_BASE}/player?prettyPrint=false`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": entry.ua,
        },
        body: JSON.stringify({
          videoId: cleanId,
          context: { client: entry.client },
          contentCheckOk: true,
          racyCheckOk: true,
        }),
        signal: AbortSignal.timeout(8000),
      });

      if (!res.ok) continue;
      const data = await res.json();
      if (data?.playabilityStatus?.status !== "OK") {
        lastReason = data?.playabilityStatus?.reason || lastReason;
        continue;
      }

      const chosen = pickPlayableFormat(data?.streamingData?.formats);
      if (!chosen) continue;

      const details = data?.videoDetails || {};
      const value = {
        id: cleanId,
        mode: "stream",
        title: details.title || "Untitled",
        author: details.author || "YouTube",
        durationSec: Number(details.lengthSeconds || 0),
        viewCount: Number(details.viewCount || 0),
        description: String(details.shortDescription || "").slice(0, 2000),
        quality: chosen.qualityLabel || `${chosen.height || 360}p`,
        mimeType: chosen.mimeType || "video/mp4",
        streamUrl: chosen.url,
        embedUrl: `https://www.youtube-nocookie.com/embed/${cleanId}?autoplay=1&rel=0`,
        userAgent: entry.ua,
      };

      if (streamCache.size >= MAX_CACHE_ENTRIES) {
        const oldestKey = streamCache.keys().next().value;
        if (oldestKey) streamCache.delete(oldestKey);
      }
      streamCache.set(cleanId, { cachedAt: Date.now(), value });
      return value;
    } catch {
      // Try next client
    }
  }

  const oembed = await fetchOembedMetadata(cleanId);
  return {
    id: cleanId,
    mode: "embed",
    title: oembed?.title || "YouTube Video",
    author: oembed?.author || "YouTube",
    durationSec: 0,
    viewCount: 0,
    description: "",
    quality: "HD Embed",
    mimeType: "",
    streamUrl: "",
    embedUrl: `https://www.youtube-nocookie.com/embed/${cleanId}?autoplay=1&rel=0`,
    userAgent: "Mozilla/5.0",
    fallbackReason: lastReason,
  };
}

export async function searchYouTubeVideos(query, limit = 18) {
  const trimmed = String(query || "").trim();
  if (!trimmed) return [];

  const res = await fetch(`${YOUTUBEI_BASE}/search?prettyPrint=false`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0",
    },
    body: JSON.stringify({
      query: trimmed,
      context: { client: WEB_SEARCH_CLIENT },
    }),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    throw new Error(`YouTube search returned HTTP ${res.status}`);
  }

  const data = await res.json();
  const results = [];
  const seen = new Set();

  function walk(node) {
    if (!node || typeof node !== "object" || results.length >= limit) return;
    if (node.videoRenderer && isValidYouTubeVideoId(node.videoRenderer.videoId)) {
      const v = node.videoRenderer;
      const id = v.videoId;
      if (!seen.has(id)) {
        seen.add(id);
        const title =
          v.title?.runs?.map((r) => r.text).join("") ||
          v.title?.simpleText ||
          "Untitled";
        const author =
          v.ownerText?.runs?.[0]?.text ||
          v.longBylineText?.runs?.[0]?.text ||
          v.shortBylineText?.runs?.[0]?.text ||
          "";
        const duration = v.lengthText?.simpleText || "LIVE";
        const views =
          v.shortViewCountText?.simpleText ||
          v.viewCountText?.simpleText ||
          "";
        results.push({ id, title, author, duration, views });
      }
      return;
    }
    for (const child of Object.values(node)) {
      walk(child);
      if (results.length >= limit) break;
    }
  }

  walk(data);
  return results;
}
