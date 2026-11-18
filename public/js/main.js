// Load transport connection dynamically
const loadTransport = async () => {
  const mod = await import("/bm/index.mjs");
  return mod.BareMuxConnection;
};
let TransportConnection = null;
import { getDirectYouTubeVideoUrl, resolveInputToUrl } from "./url.js";
import {
  COVERS_BASES,
  fetchGameHtml,
  fetchZonesCatalog,
  resolveCoverUrl,
  writeGameHtmlToFrame,
} from "./games.js";
import { initMusicPlayer } from "./music.js";
import { createAccountController } from "./account.js";
import { createAiController } from "./ai.js";

const ENGINE_STORAGE_KEY = "simple_search_engine";
const FAV_GAMES_STORAGE_KEY = "simple_favorite_games";

const els = {
  bgCanvas: document.getElementById("bg-canvas"),
  topNav: document.getElementById("top-nav"),
  modeButtons: document.querySelectorAll(".mode-btn[data-view]"),
  homeView: document.getElementById("home-view"),
  homeForm: document.getElementById("home-form"),
  searchInput: document.getElementById("search-input"),
  engineButtons: document.querySelectorAll(".engine-btn"),
  statusDot: document.getElementById("status-dot"),
  statusText: document.getElementById("status-text"),
  gamesView: document.getElementById("games-view"),
  gamesCount: document.getElementById("games-count"),
  gamesFavFilter: document.getElementById("games-fav-filter"),
  gamesFilter: document.getElementById("games-filter"),
  gamesStatus: document.getElementById("games-status"),
  gamesGrid: document.getElementById("games-grid"),
  aiView: document.getElementById("ai-view"),
  browserView: document.getElementById("browser-view"),
  barForm: document.getElementById("bar-form"),
  addressBar: document.getElementById("address-bar"),
  backBtn: document.getElementById("back-btn"),
  forwardBtn: document.getElementById("forward-btn"),
  reloadBtn: document.getElementById("reload-btn"),
  popoutBtn: document.getElementById("popout-btn"),
  homeBtn: document.getElementById("home-btn"),
  loadingLine: document.getElementById("loading-line"),
  proxyFrame: document.getElementById("proxy-frame"),
  gamePlayerView: document.getElementById("game-player-view"),
  gameBackBtn: document.getElementById("game-back-btn"),
  gameTitleLabel: document.getElementById("game-title-label"),
  gameReloadBtn: document.getElementById("game-reload-btn"),
  gameFullscreenBtn: document.getElementById("game-fullscreen-btn"),
  gameFrameWrap: document.getElementById("game-frame-wrap"),
  gameLoading: document.getElementById("game-loading"),
};

let activeEngine = localStorage.getItem(ENGINE_STORAGE_KEY) || "ddg_html";
let favoriteGames = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem(FAV_GAMES_STORAGE_KEY) || "[]");
    return new Set(Array.isArray(raw) ? raw.map(String) : []);
  } catch {
    return new Set();
  }
})();
let showFavoritesOnly = false;
let readyPromise = null;
let connection = null;
let account = null;
let musicApi = null;
let aiApi = null;

let catalogLoaded = false;
let catalogLoading = false;
let catalogState = {
  zones: [],
  coverBase: COVERS_BASES[0],
  htmlBase: undefined,
};
let activeGameZone = null;

// --- Animated Black Background Canvas ---
function initBackgroundAnimation() {
  const canvas = els.bgCanvas;
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const prefersReduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  let width = 0;
  let height = 0;
  let dpr = 1;
  const motes = [];

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  resize();
  window.addEventListener("resize", resize);

  for (let i = 0; i < 40; i++) {
    motes.push({
      x: Math.random() * width,
      y: Math.random() * height,
      r: Math.random() * 1.4 + 0.6,
      vx: (Math.random() - 0.5) * 14,
      vy: -(Math.random() * 18 + 6),
      phase: Math.random() * Math.PI * 2,
      baseAlpha: Math.random() * 0.18 + 0.06,
    });
  }

  if (prefersReduced) return;

  let lastTime = performance.now();
  function tick(now) {
    const dt = Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;

    ctx.clearRect(0, 0, width, height);
    for (const m of motes) {
      m.x += (m.vx + Math.sin(now * 0.0005 + m.phase) * 5) * dt;
      m.y += m.vy * dt;

      if (m.y < -6) {
        m.y = height + 6;
        m.x = Math.random() * width;
      }
      if (m.x < -6) m.x = width + 6;
      else if (m.x > width + 6) m.x = -6;

      const alpha = m.baseAlpha * (0.75 + 0.25 * Math.sin(now * 0.0012 + m.phase));
      ctx.beginPath();
      ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 255, 255, ${alpha.toFixed(3)})`;
      ctx.fill();
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// --- Ultraviolet Proxy Engine ---
function setStatus(state, text) {
  els.statusDot.className = `status-dot${state === "ready" ? " ready" : state === "error" ? " error" : ""}`;
  els.statusText.textContent = text;
}

function setEngine(engine, syncAccount = true) {
  activeEngine = engine;
  localStorage.setItem(ENGINE_STORAGE_KEY, engine);
  els.engineButtons.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.engine === engine);
  });
  if (syncAccount) {
    account?.updatePreferences({ searchEngine: engine });
  }
}

function toggleFavoriteGame(gameId) {
  const key = String(gameId);
  if (favoriteGames.has(key)) favoriteGames.delete(key);
  else favoriteGames.add(key);
  const arr = [...favoriteGames];
  localStorage.setItem(FAV_GAMES_STORAGE_KEY, JSON.stringify(arr));
  account?.updatePreferences({ favoriteGames: arr });
  if (catalogLoaded) {
    renderGamesGrid(els.gamesFilter.value);
  }
}

async function ensureProxyReady() {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    if (!("serviceWorker" in navigator)) {
      throw new Error("Service Workers require http://localhost or HTTPS.");
    }
    const uvCfg = self['__uv' + '$config'];
    if (!uvCfg) {
      throw new Error("Ultraviolet config failed to load.");
    }

    setStatus("connecting", "Connecting...");

    const reg = await navigator.serviceWorker.register("/sw.js", {
      scope: uvCfg.prefix,
    });

    if (!reg.active) {
      const sw = reg.installing || reg.waiting;
      if (sw) {
        await new Promise((resolve, reject) => {
          const cleanup = () => sw.removeEventListener("statechange", onChange);
          const onChange = () => {
            if (sw.state === "activated") {
              cleanup();
              resolve();
            } else if (sw.state === "redundant") {
              cleanup();
              reject(new Error("Service worker failed to activate."));
            }
          };
          sw.addEventListener("statechange", onChange);
          onChange();
        });
      }
    }

    if (!connection) {
      if (!TransportConnection) {
        TransportConnection = await loadTransport();
      }
      connection = new TransportConnection("/bm/worker.js");
    }

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const wispUrl = `${proto}//${location.host}/wisp/`;
    await connection.setTransport("/net/client.mjs", [{ wisp: wispUrl }]);

    setStatus("ready", "Ready");
  })().catch((err) => {
    readyPromise = null;
    setStatus("error", err?.message || "Proxy error");
    throw err;
  });
  return readyPromise;
}

function encodeUrl(targetUrl) {
  const cfg = self['__uv' + '$config'];
  return cfg.prefix + cfg.encodeUrl(targetUrl);
}

function decodeFrameUrl() {
  try {
    const fw = els.proxyFrame.contentWindow;
    if (!fw) return "";
    const uvHref = fw.__uv?.location?.href;
    if (uvHref && uvHref !== "about:blank" && uvHref !== "about:srcdoc") {
      return uvHref;
    }
    const loc = fw.location;
    const cfg = self['__uv' + '$config'];
    if (loc?.pathname?.startsWith(cfg.prefix)) {
      const rest = loc.pathname.slice(cfg.prefix.length) + (loc.search || "");
      return cfg.decodeUrl(rest) + (loc.hash || "");
    }
  } catch {
    // Ignore transient navigation state
  }
  return "";
}

const hookedFrameDocs = new WeakSet();
let lastDirectYouTubeUrl = "";
let lastDirectYouTubeAt = 0;

function openDirectYouTubeUrl(url) {
  lastDirectYouTubeUrl = url;
  lastDirectYouTubeAt = Date.now();
  const popup = window.open(url, "_blank", "noopener");
  if (!popup) {
    window.location.assign(url);
  }
}

function decodeProxiedOrRelativeUrl(rawHref, baseUrl) {
  if (!rawHref || typeof rawHref !== "string") return "";
  const trimmed = rawHref.trim();
  if (!trimmed || trimmed.startsWith("#") || /^(javascript|data|blob|mailto):/i.test(trimmed)) {
    return "";
  }
  const cfg = self['__uv' + '$config'];
  try {
    const resolved = new URL(trimmed, location.origin);
    if (cfg && resolved.origin === location.origin && resolved.pathname.startsWith(cfg.prefix)) {
      const rest = resolved.pathname.slice(cfg.prefix.length) + (resolved.search || "");
      return cfg.decodeUrl(rest) + (resolved.hash || "");
    }
  } catch {
    // Ignore URL parse error and fall through to relative resolution
  }
  try {
    return baseUrl ? new URL(trimmed, baseUrl).href : new URL(trimmed).href;
  } catch {
    return "";
  }
}

function extractAnchorRealUrl(anchor, frameWindow) {
  const baseUrl = decodeFrameUrl() || frameWindow?.__uv?.location?.href || "";
  const candidates = [];
  try {
    const attrHref = anchor.getAttribute?.("href");
    if (attrHref) candidates.push(attrHref);
  } catch {
    // Ignore
  }
  try {
    if (anchor.href) candidates.push(anchor.href);
  } catch {
    // Ignore
  }
  for (const raw of candidates) {
    const resolved = decodeProxiedOrRelativeUrl(raw, baseUrl);
    if (resolved) return resolved;
  }
  return "";
}

function attachFrameLinkInterceptor() {
  try {
    const frameDoc = els.proxyFrame.contentDocument;
    const frameWin = els.proxyFrame.contentWindow;
    if (!frameDoc || hookedFrameDocs.has(frameDoc)) return;
    hookedFrameDocs.add(frameDoc);

    frameDoc.addEventListener(
      "click",
      (e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        const path = typeof e.composedPath === "function" ? e.composedPath() : [e.target];
        const anchor =
          path.find((el) => el?.tagName === "A" && (el.hasAttribute?.("href") || el.href)) ||
          e.target?.closest?.("a[href]");
        if (!anchor) return;

        const targetUrl = extractAnchorRealUrl(anchor, frameWin);
        const directYtUrl = getDirectYouTubeVideoUrl(targetUrl);
        if (!directYtUrl) return;

        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        openDirectYouTubeUrl(directYtUrl);
      },
      true
    );
  } catch {
    // Ignore transient or non-same-origin document access
  }
}

function syncToolbarFromFrame() {
  if (els.browserView.classList.contains("hidden")) return;
  attachFrameLinkInterceptor();
  const decoded = decodeFrameUrl();
  const directYtUrl = getDirectYouTubeVideoUrl(decoded);
  if (
    directYtUrl &&
    (directYtUrl !== lastDirectYouTubeUrl || Date.now() - lastDirectYouTubeAt > 3000)
  ) {
    openDirectYouTubeUrl(directYtUrl);
    try {
      els.proxyFrame.contentWindow?.history.back();
    } catch {
      // Ignore
    }
    return;
  }
  if (decoded && document.activeElement !== els.addressBar) {
    els.addressBar.value = decoded;
  }
  try {
    const title = els.proxyFrame.contentDocument?.title?.trim();
    document.title = title ? `${title} - Simple` : "Simple";
  } catch {
    // Ignore
  }
}

function switchTopView(viewName) {
  els.modeButtons.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === viewName);
  });

  els.homeView.classList.toggle("hidden", viewName !== "home");
  els.gamesView.classList.toggle("hidden", viewName !== "games");
  els.aiView.classList.toggle("hidden", viewName !== "ai");
  els.browserView.classList.add("hidden");
  els.gamePlayerView.classList.add("hidden");
  els.topNav.classList.remove("hidden");

  if (viewName === "home") {
    document.title = "Simple";
    els.searchInput.focus();
  } else if (viewName === "games") {
    document.title = "Games - Simple";
    ensureGamesLoaded();
    els.gamesFilter.focus();
  } else if (viewName === "ai") {
    document.title = "AI - Simple";
    aiApi?.focus();
  }
}

async function navigate(rawInput) {
  const target = resolveInputToUrl(rawInput, activeEngine);
  if (!target) return;

  const directYtUrl = getDirectYouTubeVideoUrl(target);
  if (directYtUrl) {
    openDirectYouTubeUrl(directYtUrl);
    return;
  }

  els.addressBar.value = target;
  els.topNav.classList.add("hidden");
  els.homeView.classList.add("hidden");
  els.gamesView.classList.add("hidden");
  els.aiView.classList.add("hidden");
  els.gamePlayerView.classList.add("hidden");
  els.browserView.classList.remove("hidden");
  els.loadingLine.classList.remove("hidden");

  try {
    await ensureProxyReady();
    els.proxyFrame.src = encodeUrl(target);
  } catch (err) {
    console.error("[proxy] navigate failed:", err);
    els.loadingLine.classList.add("hidden");
    showHome();
  }
}

function showHome() {
  els.proxyFrame.src = "about:blank";
  els.loadingLine.classList.add("hidden");
  switchTopView("home");
}

// --- gn-math Games Integration ---
function renderGamesGrid(filterText = "") {
  const query = filterText.trim().toLowerCase();
  const list = catalogState.zones.filter((z) => {
    if (showFavoritesOnly && !favoriteGames.has(String(z.id))) return false;
    if (query && !z.name.toLowerCase().includes(query)) return false;
    return true;
  });

  els.gamesCount.textContent = `${list.length} of ${catalogState.zones.length} games`;
  els.gamesGrid.innerHTML = "";

  if (list.length === 0) {
    els.gamesStatus.textContent = showFavoritesOnly
      ? "No favorite games yet. Click ★ on a game card to save it."
      : "No matching games found.";
    els.gamesStatus.classList.remove("hidden");
    return;
  }

  els.gamesStatus.classList.add("hidden");
  const frag = document.createDocumentFragment();

  for (const zone of list) {
    const card = document.createElement("div");
    card.className = "game-card";
    card.title = zone.name;
    card.tabIndex = 0;
    card.setAttribute("role", "button");

    const favBtn = document.createElement("button");
    favBtn.type = "button";
    const isFav = favoriteGames.has(String(zone.id));
    favBtn.className = `game-fav-btn${isFav ? " active" : ""}`;
    favBtn.textContent = isFav ? "★" : "☆";
    favBtn.title = isFav ? "Remove from favorites" : "Add to favorites";
    favBtn.setAttribute("aria-label", favBtn.title);
    favBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleFavoriteGame(zone.id);
    });
    card.appendChild(favBtn);

    const thumbWrap = document.createElement("div");
    thumbWrap.className = "game-thumb-wrap";

    const primaryCover = resolveCoverUrl(zone, catalogState.coverBase);
    const fallbackCover = resolveCoverUrl(zone, COVERS_BASES[1]);

    if (primaryCover) {
      const img = document.createElement("img");
      img.className = "game-thumb";
      img.loading = "lazy";
      img.alt = zone.name;
      img.addEventListener("load", () => img.classList.add("loaded"));
      img.src = primaryCover;
      if (img.complete) img.classList.add("loaded");
      img.addEventListener("error", () => {
        if (img.dataset.retried !== "1" && fallbackCover && fallbackCover !== img.src) {
          img.dataset.retried = "1";
          img.src = fallbackCover;
        } else {
          img.remove();
          const fb = document.createElement("span");
          fb.className = "game-thumb-fallback";
          fb.textContent = "GAME";
          thumbWrap.appendChild(fb);
        }
      });
      thumbWrap.appendChild(img);
    }

    const body = document.createElement("div");
    body.className = "game-card-body";

    const title = document.createElement("div");
    title.className = "game-card-title";
    title.textContent = zone.name;
    body.appendChild(title);

    if (zone.author) {
      const author = document.createElement("div");
      author.className = "game-card-author";
      author.textContent = zone.author;
      body.appendChild(author);
    }

    card.append(thumbWrap, body);
    card.addEventListener("click", () => openGameZone(zone));
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openGameZone(zone);
      }
    });
    frag.appendChild(card);
  }

  els.gamesGrid.appendChild(frag);
}

async function ensureGamesLoaded() {
  if (catalogLoaded || catalogLoading) return;
  catalogLoading = true;
  els.gamesStatus.textContent = "Fetching games catalog...";
  els.gamesStatus.classList.remove("hidden");

  try {
    catalogState = await fetchZonesCatalog();
    catalogLoaded = true;
    renderGamesGrid(els.gamesFilter.value);
  } catch (err) {
    els.gamesStatus.textContent = `Failed to load games catalog: ${err?.message || err}`;
    els.gamesStatus.classList.remove("hidden");
  } finally {
    catalogLoading = false;
  }
}

async function openGameZone(zone) {
  activeGameZone = zone;
  els.topNav.classList.add("hidden");
  els.homeView.classList.add("hidden");
  els.gamesView.classList.add("hidden");
  els.aiView.classList.add("hidden");
  els.browserView.classList.add("hidden");
  els.gamePlayerView.classList.remove("hidden");

  els.gameTitleLabel.textContent = zone.name;
  document.title = `${zone.name} - Simple`;
  els.gameLoading.textContent = `Loading ${zone.name}...`;
  els.gameLoading.classList.remove("hidden");

  try {
    const html = await fetchGameHtml(zone, {
      htmlBase: catalogState.htmlBase,
      coverBase: catalogState.coverBase,
    });
    writeGameHtmlToFrame(els.gameFrameWrap, html, zone.name);
    els.gameLoading.classList.add("hidden");
  } catch (err) {
    els.gameLoading.textContent = `Failed to load ${zone.name}: ${err?.message || err}`;
  }
}

function closeGamePlayer() {
  activeGameZone = null;
  els.gameFrameWrap.querySelectorAll("iframe").forEach((f) => f.remove());
  els.gameLoading.classList.add("hidden");
  switchTopView("games");
}

// --- Event Listeners ---
els.modeButtons.forEach((btn) => {
  btn.addEventListener("click", () => switchTopView(btn.dataset.view));
});

els.homeForm.addEventListener("submit", (e) => {
  e.preventDefault();
  navigate(els.searchInput.value);
});

els.barForm.addEventListener("submit", (e) => {
  e.preventDefault();
  navigate(els.addressBar.value);
  els.addressBar.blur();
});

els.engineButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    setEngine(btn.dataset.engine);
    els.searchInput.focus();
  });
});

els.gamesFilter.addEventListener("input", () => {
  if (catalogLoaded) {
    renderGamesGrid(els.gamesFilter.value);
  }
});

els.gamesFavFilter?.addEventListener("click", () => {
  showFavoritesOnly = !showFavoritesOnly;
  els.gamesFavFilter.classList.toggle("active", showFavoritesOnly);
  if (catalogLoaded) {
    renderGamesGrid(els.gamesFilter.value);
  }
});

els.proxyFrame.addEventListener("load", () => {
  els.loadingLine.classList.add("hidden");
  attachFrameLinkInterceptor();
  syncToolbarFromFrame();
});

els.backBtn.addEventListener("click", () => {
  try {
    els.proxyFrame.contentWindow?.history.back();
  } catch {
    // Ignore
  }
});

els.forwardBtn.addEventListener("click", () => {
  try {
    els.proxyFrame.contentWindow?.history.forward();
  } catch {
    // Ignore
  }
});

els.reloadBtn.addEventListener("click", () => {
  els.loadingLine.classList.remove("hidden");
  try {
    els.proxyFrame.contentWindow?.location.reload();
  } catch {
    els.proxyFrame.src = els.proxyFrame.src;
  }
});

els.popoutBtn.addEventListener("click", () => {
  const url = els.proxyFrame.src;
  if (url && url !== "about:blank") {
    window.open(url, "_blank", "noopener");
  }
});

els.homeBtn.addEventListener("click", showHome);

els.gameBackBtn.addEventListener("click", closeGamePlayer);
els.gameReloadBtn.addEventListener("click", () => {
  if (activeGameZone) openGameZone(activeGameZone);
});
els.gameFullscreenBtn.addEventListener("click", () => {
  if (!document.fullscreenElement) {
    els.gameFrameWrap.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen();
  }
});

setInterval(syncToolbarFromFrame, 750);

// Init
initBackgroundAnimation();
aiApi = createAiController({
  onRequestSignIn: () => account?.openModal(),
});
account = createAccountController({
  onUserChange: (user) => {
    aiApi?.setUser(user);
    const prefs = user?.preferences;
    if (prefs) {
      if (prefs.searchEngine) setEngine(prefs.searchEngine, false);
      if (Array.isArray(prefs.favoriteGames)) {
        favoriteGames = new Set(prefs.favoriteGames.map(String));
        localStorage.setItem(FAV_GAMES_STORAGE_KEY, JSON.stringify([...favoriteGames]));
        if (catalogLoaded) renderGamesGrid(els.gamesFilter.value);
      }
      if (Array.isArray(prefs.savedTracks)) {
        musicApi?.setSavedTracks(prefs.savedTracks);
      }
    }
  },
});
musicApi = initMusicPlayer({
  onSavedTracksChange: (saved) => {
    account?.updatePreferences({ savedTracks: saved });
  },
});
setEngine(activeEngine, false);
els.searchInput.focus();
account.refreshSession();
ensureProxyReady().catch(() => {});
