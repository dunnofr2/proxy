export const SEARCH_ENGINES = {
  ddg_html: {
    label: "DuckDuckGo (Fast)",
    template: "https://html.duckduckgo.com/html/?q=%s",
  },
  ddg: {
    label: "DuckDuckGo",
    template: "https://duckduckgo.com/?q=%s",
  },
  brave: {
    label: "Brave Search",
    template: "https://search.brave.com/search?q=%s",
  },
  google: {
    label: "Google",
    template: "https://www.google.com/search?q=%s",
  },
  bing: {
    label: "Bing",
    template: "https://www.bing.com/search?q=%s",
  },
  startpage: {
    label: "Startpage",
    template: "https://www.startpage.com/do/search?q=%s",
  },
  wikipedia: {
    label: "Wikipedia",
    template: "https://en.wikipedia.org/w/index.php?search=%s",
  },
};

const NON_TLD_EXTENSIONS = new Set([
  "js",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "jsx",
  "css",
  "scss",
  "html",
  "htm",
  "json",
  "txt",
  "md",
  "py",
  "rb",
  "go",
  "rs",
  "cpp",
  "hpp",
  "java",
  "php",
  "xml",
  "yaml",
  "yml",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
  "pdf",
  "zip",
  "tar",
  "gz",
  "exe",
  "dll",
  "env",
  "log",
  "sql",
  "sh",
  "ps1",
]);

export function resolveInputToUrl(rawInput, engineKey = "ddg_html") {
  const trimmed = (rawInput || "").trim();
  if (!trimmed) return "";

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).href;
    } catch {
      // Fall through to search query if malformed
    }
  }

  const noSpaces = !/\s/.test(trimmed);
  const hostMatch = trimmed.match(/^([^./][^/]*\.([a-z]{2,}))(?::\d+)?(\/|$)/i);
  const ext = hostMatch?.[2]?.toLowerCase() || "";
  const isBareFilename =
    Boolean(hostMatch) &&
    !trimmed.includes("/") &&
    !trimmed.includes(":") &&
    hostMatch[1].split(".").length === 2 &&
    NON_TLD_EXTENSIONS.has(ext);

  const looksLikeHost =
    noSpaces &&
    !isBareFilename &&
    (/^localhost(:\d+)?(\/|$)/i.test(trimmed) ||
      /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(trimmed) ||
      /^\[[0-9a-f:]+\](:\d+)?(\/|$)/i.test(trimmed) ||
      (Boolean(hostMatch) && !trimmed.endsWith(".")));

  if (looksLikeHost) {
    const isLocal =
      /^localhost/i.test(trimmed) || /^\d{1,3}(\.\d{1,3}){3}/.test(trimmed);
    const scheme = isLocal ? "http://" : "https://";
    try {
      return new URL(`${scheme}${trimmed}`).href;
    } catch {
      // Fall through to search
    }
  }

  const engine = SEARCH_ENGINES[engineKey] || SEARCH_ENGINES.ddg_html;
  return engine.template.replace("%s", encodeURIComponent(trimmed));
}

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "gaming.youtube.com",
  "youtu.be",
  "www.youtu.be",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

export function extractYouTubeVideoId(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return null;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const host = parsed.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) return null;

  if (host === "youtu.be" || host === "www.youtu.be") {
    const id = parsed.pathname.replace(/^\/+/, "").split("/")[0];
    return VIDEO_ID_RE.test(id) ? id : null;
  }

  const path = parsed.pathname;
  if (path === "/watch" || path === "/watch/") {
    const id = parsed.searchParams.get("v") || "";
    return VIDEO_ID_RE.test(id) ? id : null;
  }

  const match = path.match(/^\/(?:shorts|live|embed|v)\/([a-zA-Z0-9_-]{11})(?:\/|$)/);
  return match ? match[1] : null;
}

/**
 * Maps a YouTube URL (video, search results, or homepage) to the built-in
 * in-proxy player route (`/yt.html?...`), or `null` for non-YouTube URLs.
 */
export function getYouTubePlayerUrl(rawUrl) {
  const videoId = extractYouTubeVideoId(rawUrl);
  if (videoId) {
    return `/yt.html?v=${encodeURIComponent(videoId)}`;
  }
  if (!rawUrl || typeof rawUrl !== "string") return null;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const host = parsed.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host) || host === "youtu.be" || host === "www.youtu.be") {
    return null;
  }
  if (parsed.pathname === "/results") {
    const q = (parsed.searchParams.get("search_query") || "").trim();
    return q ? `/yt.html?q=${encodeURIComponent(q)}` : "/yt.html";
  }
  if (parsed.pathname === "/" || parsed.pathname === "") {
    return "/yt.html";
  }
  return null;
}
