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
