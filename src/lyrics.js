const LRCLIB_SEARCH = "https://lrclib.net/api/search";
const NOISE_TAG_RE =
  /\s*[\[(](?:official(?:\s+(?:music\s+)?(?:video|audio|lyric(?:s)?))?|lyrics?|audio|visualizer|hd|hq|4k|explicit|clean|remaster(?:ed)?|original(?:\s+version)?|sped\s*up|slowed(?:\s*\+\s*reverb)?|bass\s*boosted|prod\.?\s*[^)\]]*|feat\.?\s*[^)\]]*|ft\.?\s*[^)\]]*)[\])]/gi;
const LRC_TIME_RE = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

export function cleanTrackTitle(rawTitle) {
  return String(rawTitle || "")
    .replace(NOISE_TAG_RE, "")
    .replace(/\s+(?:feat\.?|ft\.?)\s+.+$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function parseLrc(lrcText) {
  if (!lrcText || typeof lrcText !== "string") return [];
  const entries = [];

  for (const rawLine of lrcText.split(/\r?\n/)) {
    const times = [];
    let match;
    LRC_TIME_RE.lastIndex = 0;
    while ((match = LRC_TIME_RE.exec(rawLine)) !== null) {
      const mins = Number.parseInt(match[1], 10);
      const secs = Number.parseInt(match[2], 10);
      const fracRaw = match[3] || "0";
      const frac = Number.parseInt(fracRaw, 10) / 10 ** fracRaw.length;
      times.push(mins * 60 + secs + frac);
    }
    if (times.length === 0) continue;

    const text = rawLine.replace(LRC_TIME_RE, "").trim();
    for (const time of times) {
      entries.push({ time, text });
    }
  }

  entries.sort((a, b) => a.time - b.time);

  // Collapse consecutive empty instrumental markers so breaks stay clean.
  const compacted = [];
  for (const entry of entries) {
    const prev = compacted[compacted.length - 1];
    if (!entry.text && prev && !prev.text) continue;
    compacted.push(entry);
  }
  return compacted;
}

function pickBestCandidate(candidates, targetDurationSec) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  const scored = candidates.map((item) => {
    let score = 0;
    if (item.syncedLyrics) score += 100;
    else if (item.plainLyrics) score += 20;
    if (Number.isFinite(targetDurationSec) && targetDurationSec > 0 && item.duration) {
      const diff = Math.abs(item.duration - targetDurationSec);
      score -= Math.min(diff, 60);
    }
    return { item, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.item || null;
}

async function queryLrclib(params) {
  const qs = new URLSearchParams(params);
  const res = await fetch(`${LRCLIB_SEARCH}?${qs.toString()}`, {
    headers: { "User-Agent": "SimpleProxy/1.0" },
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

export async function fetchLyrics({ title, artist = "", durationSec = 0 }) {
  const cleaned = cleanTrackTitle(title);
  if (!cleaned) {
    return { synced: false, lines: [] };
  }

  const attempts = [];
  if (cleaned.includes(" - ")) {
    const [left, ...rest] = cleaned.split(" - ");
    const right = rest.join(" - ").trim();
    if (left.trim() && right) {
      attempts.push({ track_name: right, artist_name: left.trim() });
      attempts.push({ track_name: left.trim(), artist_name: right });
    }
  }

  const strippedAfterDash = cleaned.replace(/\s*-\s*[^-]+$/, "").trim();
  if (artist.trim()) {
    attempts.push({ track_name: strippedAfterDash || cleaned, artist_name: artist.trim() });
  }
  attempts.push({ q: strippedAfterDash || cleaned });

  let best = null;
  for (const params of attempts) {
    const hits = await queryLrclib(params);
    const candidate = pickBestCandidate(hits, durationSec);
    if (candidate?.syncedLyrics) {
      best = candidate;
      break;
    }
    if (!best && candidate?.plainLyrics) {
      best = candidate;
    }
  }

  if (!best) {
    return { synced: false, lines: [] };
  }

  if (best.syncedLyrics) {
    const parsed = parseLrc(best.syncedLyrics);
    return {
      synced: parsed.length > 0,
      trackName: best.trackName || cleaned,
      artistName: best.artistName || artist,
      lines: parsed,
    };
  }

  const plain = String(best.plainLyrics || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((text) => ({ time: null, text }));

  return {
    synced: false,
    trackName: best.trackName || cleaned,
    artistName: best.artistName || artist,
    lines: plain,
  };
}
