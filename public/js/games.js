export const ASSETS_BASES = [
  "https://cdn.jsdelivr.net/gh/gn-math/assets@master",
  "https://cdn.jsdelivr.net/gh/gn-math/assets@main",
  "https://raw.githubusercontent.com/gn-math/assets/main",
];

export const COVERS_BASES = [
  "https://cdn.jsdelivr.net/gh/gn-math/covers@main",
  "https://raw.githubusercontent.com/gn-math/covers/main",
];

export const HTML_BASES = [
  "https://cdn.jsdelivr.net/gh/gn-math/html@main",
  "https://raw.githubusercontent.com/gn-math/html/main",
];

export function filterPlayableZones(zones) {
  if (!Array.isArray(zones)) return [];
  return zones.filter(
    (z) =>
      z &&
      typeof z.name === "string" &&
      (typeof z.id !== "number" || z.id >= 0) &&
      typeof z.url === "string" &&
      (z.url.includes("{HTML_URL}") || /\.html?$/i.test(z.url))
  );
}

export function resolveCoverUrl(zone, coverBase = COVERS_BASES[0]) {
  const raw = zone?.cover || "";
  if (!raw) return "";
  if (raw.includes("{COVER_URL}")) {
    return raw.replaceAll("{COVER_URL}", coverBase);
  }
  if (/^https?:\/\//i.test(raw)) return raw;
  return `${coverBase}/${raw.replace(/^\/+/, "")}`;
}

export function getHtmlCandidates(zone, preferredHtmlBase = HTML_BASES[0]) {
  const orderedBases = [
    preferredHtmlBase,
    ...HTML_BASES.filter((b) => b !== preferredHtmlBase),
  ];
  const rawUrl = String(zone?.url || "").trim();
  const candidates = [];

  for (const base of orderedBases) {
    if (rawUrl.includes("{HTML_URL}")) {
      candidates.push(rawUrl.replaceAll("{HTML_URL}", base));
    } else if (/^https?:\/\//i.test(rawUrl)) {
      if (!candidates.includes(rawUrl)) candidates.push(rawUrl);
    } else if (rawUrl) {
      candidates.push(`${base}/${rawUrl.replace(/^\/+/, "")}`);
    }
    if (zone?.name) {
      const byName = `${base}/${encodeURIComponent(zone.name)}.html`;
      if (!candidates.includes(byName)) candidates.push(byName);
    }
  }
  return candidates;
}

export async function fetchZonesCatalog() {
  let lastError = null;

  for (let i = 0; i < ASSETS_BASES.length; i++) {
    const base = ASSETS_BASES[i];
    try {
      const res = await fetch(`${base}/zones.json`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      const usingJsdelivr = base.includes("cdn.jsdelivr.net");
      return {
        zones: filterPlayableZones(data),
        coverBase: usingJsdelivr ? COVERS_BASES[0] : COVERS_BASES[1],
        htmlBase: usingJsdelivr ? HTML_BASES[0] : HTML_BASES[1],
        source: base,
      };
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error("Failed to fetch games catalog.");
}

export async function fetchGameHtml(zone, { htmlBase = HTML_BASES[0], coverBase = COVERS_BASES[0] } = {}) {
  const candidates = getHtmlCandidates(zone, htmlBase);
  let lastError = null;

  for (const url of candidates) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const rawHtml = await res.text();
      return rawHtml
        .replaceAll("{HTML_URL}", htmlBase)
        .replaceAll("{COVER_URL}", coverBase);
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error(`Failed to fetch HTML for ${zone?.name || "game"}.`);
}

export function writeGameHtmlToFrame(container, html, title = "Game") {
  // Delete any existing iframe in the game loading area first.
  container.querySelectorAll("iframe").forEach((frame) => frame.remove());

  // Create a new iframe without src or srcdoc, then write HTML via contentDocument.
  const iframe = document.createElement("iframe");
  iframe.className = "game-frame";
  iframe.title = title;
  container.appendChild(iframe);

  const doc = iframe.contentDocument;
  if (!doc) {
    throw new Error("Unable to access iframe contentDocument.");
  }
  doc.open();
  doc.write(html);
  doc.close();
  return iframe;
}
