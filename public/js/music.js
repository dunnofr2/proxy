import Hls from "/hls/hls.min.mjs";

const POS_STORAGE_KEY = "simple_music_pos";
const SAVED_TRACKS_KEY = "simple_saved_tracks";
const PLAY_SVG = '<path d="M8 5v14l11-7z" />';
const PAUSE_SVG = '<path d="M6 5h4v14H6zm8 0h4v14h-4z" />';

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export function initMusicPlayer({ onSavedTracksChange } = {}) {
  const toggleBtn = document.getElementById("music-toggle-btn");
  const panel = document.getElementById("music-panel");
  const dragHandle = document.getElementById("music-drag-handle");
  const bgArt = document.getElementById("music-bg-art");
  const closeBtn = document.getElementById("music-close-btn");
  const tabBtns = document.querySelectorAll(".music-tab");
  const searchView = document.getElementById("music-view-search");
  const savedView = document.getElementById("music-view-saved");
  const savedEmpty = document.getElementById("music-saved-empty");
  const savedListEl = document.getElementById("music-saved-list");
  const lyricsView = document.getElementById("music-view-lyrics");
  const lyricsShortcut = document.getElementById("music-lyrics-shortcut");
  const lyricsStatus = document.getElementById("music-lyrics-status");
  const lyricsScroll = document.getElementById("music-lyrics-scroll");
  const lyricsResyncBtn = document.getElementById("music-lyrics-resync");
  const searchForm = document.getElementById("music-form");
  const searchInput = document.getElementById("music-input");
  const statusEl = document.getElementById("music-status");
  const listEl = document.getElementById("music-list");
  const nowTitle = document.getElementById("music-now-title");
  const nowArtist = document.getElementById("music-now-artist");
  const nowArt = document.getElementById("music-now-art");
  const artFallback = document.getElementById("music-art-fallback");
  const prevBtn = document.getElementById("music-prev-btn");
  const playBtn = document.getElementById("music-play-btn");
  const playIcon = document.getElementById("music-play-icon");
  const nextBtn = document.getElementById("music-next-btn");
  const seekBar = document.getElementById("music-seek");
  const timeCurrent = document.getElementById("music-time-current");
  const timeTotal = document.getElementById("music-time-total");
  const volSlider = document.getElementById("music-volume");
  const muteBtn = document.getElementById("music-mute-btn");
  const miniBar = document.getElementById("music-mini");
  const miniArt = document.getElementById("music-mini-art");
  const miniTitle = document.getElementById("music-mini-title");
  const miniPlayBtn = document.getElementById("music-mini-play");
  const miniIcon = document.getElementById("music-mini-icon");

  if (!panel || !toggleBtn) return;

  const audio = new Audio();
  audio.preload = "metadata";
  audio.volume = Number(volSlider?.value ?? 0.85);

  let hls = null;
  let searchTracks = [];
  let savedTracks = (() => {
    try {
      const raw = JSON.parse(localStorage.getItem(SAVED_TRACKS_KEY) || "[]");
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  })();
  let tracks = [];
  let currentTrackId = null;
  let currentIndex = -1;
  let isOpen = false;
  let activeSubTab = "search";
  let isSeeking = false;

  // Lyrics state
  let lyricsData = { synced: false, lines: [] };
  let lyricElements = [];
  let activeLyricIndex = -1;
  let manualScrollUntil = 0;
  let lyricsAbort = null;
  let rafId = null;

  // --- Draggable Moveable Widget ---
  function clampPosition(left, top) {
    const pad = 8;
    const maxLeft = Math.max(pad, window.innerWidth - panel.offsetWidth - pad);
    const maxTop = Math.max(pad, window.innerHeight - panel.offsetHeight - pad);
    return {
      left: Math.min(Math.max(pad, left), maxLeft),
      top: Math.min(Math.max(pad, top), maxTop),
    };
  }

  function applyPosition(left, top, persist = false) {
    const clamped = clampPosition(left, top);
    panel.style.left = `${clamped.left}px`;
    panel.style.top = `${clamped.top}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    if (persist) {
      localStorage.setItem(POS_STORAGE_KEY, JSON.stringify(clamped));
    }
  }

  function restorePosition() {
    try {
      const saved = JSON.parse(localStorage.getItem(POS_STORAGE_KEY) || "null");
      if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
        applyPosition(saved.left, saved.top, false);
      }
    } catch {
      // Default CSS bottom-right
    }
  }

  function resetPosition() {
    panel.style.left = "";
    panel.style.top = "";
    panel.style.right = "";
    panel.style.bottom = "";
    localStorage.removeItem(POS_STORAGE_KEY);
  }

  if (dragHandle) {
    let dragging = false;
    let pointerId = null;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    dragHandle.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return;
      dragging = true;
      pointerId = e.pointerId;
      dragHandle.setPointerCapture(pointerId);
      const rect = panel.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      panel.classList.add("dragging");
      e.preventDefault();
    });

    dragHandle.addEventListener("pointermove", (e) => {
      if (!dragging || e.pointerId !== pointerId) return;
      applyPosition(startLeft + (e.clientX - startX), startTop + (e.clientY - startY), false);
    });

    const endDrag = (e) => {
      if (!dragging || e.pointerId !== pointerId) return;
      dragging = false;
      panel.classList.remove("dragging");
      const rect = panel.getBoundingClientRect();
      applyPosition(rect.left, rect.top, true);
    };

    dragHandle.addEventListener("pointerup", endDrag);
    dragHandle.addEventListener("pointercancel", endDrag);
    dragHandle.addEventListener("dblclick", (e) => {
      if (!e.target.closest("button")) resetPosition();
    });

    window.addEventListener("resize", () => {
      if (!isOpen || !panel.style.left) return;
      const rect = panel.getBoundingClientRect();
      applyPosition(rect.left, rect.top, false);
    });
  }

  // --- Sub-tabs (Search / Saved / Lyrics) ---
  function setSubTab(tabName) {
    activeSubTab = ["lyrics", "saved"].includes(tabName) ? tabName : "search";
    tabBtns.forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.mtab === activeSubTab);
    });
    lyricsShortcut?.classList.toggle("active", activeSubTab === "lyrics");
    searchView.classList.toggle("hidden", activeSubTab !== "search");
    savedView?.classList.toggle("hidden", activeSubTab !== "saved");
    lyricsView.classList.toggle("hidden", activeSubTab !== "lyrics");
    if (activeSubTab === "saved") {
      renderSavedTracks();
    } else if (activeSubTab === "lyrics" && activeLyricIndex >= 0) {
      scrollToLyric(activeLyricIndex, true);
    }
  }

  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => setSubTab(btn.dataset.mtab));
  });
  lyricsShortcut?.addEventListener("click", () => {
    setSubTab(activeSubTab === "lyrics" ? "search" : "lyrics");
  });

  // --- Apple Music-Style Synced Lyrics ---
  function scrollToLyric(index, instant = false) {
    const el = lyricElements[index];
    if (!el || lyricsScroll.classList.contains("hidden")) return;
    const targetTop =
      el.offsetTop - lyricsScroll.clientHeight * 0.42 + el.clientHeight * 0.5;
    lyricsScroll.scrollTo({
      top: Math.max(0, targetTop),
      behavior: instant ? "auto" : "smooth",
    });
  }

  function renderLyrics() {
    lyricsScroll.innerHTML = "";
    lyricElements = [];
    activeLyricIndex = -1;
    lyricsResyncBtn.classList.add("hidden");

    if (!lyricsData.lines || lyricsData.lines.length === 0) {
      lyricsScroll.classList.add("hidden");
      lyricsStatus.classList.remove("hidden");
      return;
    }

    lyricsStatus.classList.add("hidden");
    lyricsScroll.classList.remove("hidden");
    const frag = document.createDocumentFragment();

    lyricsData.lines.forEach((line) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = lyricsData.synced ? "lyric-line" : "lyric-line plain";

      if (!line.text) {
        btn.innerHTML = '<span class="lyric-dots"><span></span><span></span><span></span></span>';
      } else {
        btn.textContent = line.text;
      }

      if (lyricsData.synced && typeof line.time === "number") {
        btn.addEventListener("click", () => {
          audio.currentTime = line.time;
          if (audio.paused) audio.play().catch(() => {});
          manualScrollUntil = 0;
          lyricsResyncBtn.classList.add("hidden");
          syncLyricsFrame();
        });
      }

      lyricElements.push(btn);
      frag.appendChild(btn);
    });

    lyricsScroll.appendChild(frag);
  }

  function syncLyricsFrame() {
    if (!lyricsData.synced || lyricElements.length === 0) return;

    const now = audio.currentTime;
    let newIndex = -1;
    for (let i = 0; i < lyricsData.lines.length; i++) {
      if (lyricsData.lines[i].time <= now + 0.08) {
        newIndex = i;
      } else {
        break;
      }
    }

    if (newIndex !== activeLyricIndex) {
      activeLyricIndex = newIndex;
      for (let i = 0; i < lyricElements.length; i++) {
        const el = lyricElements[i];
        const dist = Math.abs(i - activeLyricIndex);
        el.classList.toggle("active", i === activeLyricIndex);
        el.classList.toggle("near", dist === 1);
        if (i < activeLyricIndex) el.style.setProperty("--p", "100%");
        else if (i > activeLyricIndex) el.style.setProperty("--p", "0%");
      }
      if (activeLyricIndex >= 0 && Date.now() > manualScrollUntil) {
        scrollToLyric(activeLyricIndex, false);
      }
    }

    if (activeLyricIndex >= 0) {
      const curr = lyricsData.lines[activeLyricIndex];
      const next = lyricsData.lines[activeLyricIndex + 1];
      const duration = next
        ? Math.max(0.35, next.time - curr.time)
        : Math.max(1.5, (audio.duration || curr.time + 4) - curr.time);
      const pct = Math.min(100, Math.max(0, ((now - curr.time) / duration) * 100));
      lyricElements[activeLyricIndex].style.setProperty("--p", `${pct.toFixed(1)}%`);
    }
  }

  function startLyricsLoop() {
    if (rafId) return;
    const step = () => {
      syncLyricsFrame();
      if (!audio.paused && !audio.ended) {
        rafId = requestAnimationFrame(step);
      } else {
        rafId = null;
      }
    };
    rafId = requestAnimationFrame(step);
  }

  function stopLyricsLoop() {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  lyricsScroll.addEventListener(
    "wheel",
    () => {
      if (!lyricsData.synced) return;
      manualScrollUntil = Date.now() + 4500;
      lyricsResyncBtn.classList.remove("hidden");
    },
    { passive: true }
  );

  lyricsScroll.addEventListener(
    "touchmove",
    () => {
      if (!lyricsData.synced) return;
      manualScrollUntil = Date.now() + 4500;
      lyricsResyncBtn.classList.remove("hidden");
    },
    { passive: true }
  );

  lyricsResyncBtn.addEventListener("click", () => {
    manualScrollUntil = 0;
    lyricsResyncBtn.classList.add("hidden");
    if (activeLyricIndex >= 0) scrollToLyric(activeLyricIndex, false);
  });

  async function loadTrackLyrics(track) {
    if (lyricsAbort) lyricsAbort.abort();
    lyricsAbort = new AbortController();

    lyricsData = { synced: false, lines: [] };
    lyricElements = [];
    activeLyricIndex = -1;
    lyricsScroll.classList.add("hidden");
    lyricsStatus.textContent = "Fetching lyrics...";
    lyricsStatus.classList.remove("hidden");

    try {
      const qs = new URLSearchParams({
        title: track.title,
        artist: track.artist,
        duration: String(Math.round((track.durationMs || 0) / 1000)),
      });
      const res = await fetch(`/api/music/lyrics?${qs.toString()}`, {
        signal: lyricsAbort.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      lyricsData = {
        synced: Boolean(data?.synced),
        lines: Array.isArray(data?.lines) ? data.lines : [],
      };
      if (lyricsData.lines.length === 0) {
        lyricsStatus.textContent = "No lyrics found for this track.";
      }
      renderLyrics();
      syncLyricsFrame();
    } catch (err) {
      if (err?.name === "AbortError") return;
      lyricsStatus.textContent = "Lyrics unavailable for this track.";
    }
  }

  // --- Playback & Audio Controls ---
  function setStatus(text) {
    statusEl.textContent = text;
    statusEl.classList.toggle("hidden", !text);
  }

  function updatePlayIcons() {
    const playing = !audio.paused && !audio.ended;
    const svg = playing ? PAUSE_SVG : PLAY_SVG;
    playIcon.innerHTML = svg;
    miniIcon.innerHTML = svg;
    playBtn.title = playing ? "Pause" : "Play";
    panel.classList.toggle("is-playing", playing);
  }

  function updatePanelVisibility(open) {
    isOpen = open;
    panel.classList.toggle("hidden", !isOpen);
    toggleBtn.classList.toggle("active", isOpen);
    miniBar.classList.toggle("hidden", isOpen || currentIndex === -1);
    if (isOpen) {
      restorePosition();
      if (tracks.length === 0 && activeSubTab === "search") {
        searchInput.focus();
      }
      if (activeSubTab === "lyrics" && activeLyricIndex >= 0) {
        requestAnimationFrame(() => scrollToLyric(activeLyricIndex, true));
      }
    }
  }

  function destroyStream() {
    stopLyricsLoop();
    if (hls) {
      hls.destroy();
      hls = null;
    }
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  }

  function isTrackSaved(trackId) {
    return savedTracks.some((t) => String(t.id) === String(trackId));
  }

  function toggleSaveTrack(track) {
    if (isTrackSaved(track.id)) {
      savedTracks = savedTracks.filter((t) => String(t.id) !== String(track.id));
    } else {
      savedTracks = [track, ...savedTracks].slice(0, 200);
    }
    localStorage.setItem(SAVED_TRACKS_KEY, JSON.stringify(savedTracks));
    onSavedTracksChange?.(savedTracks);
    renderTracks();
    renderSavedTracks();
  }

  function renderTrackListInto(container, list) {
    if (!container) return;
    container.innerHTML = "";
    const frag = document.createDocumentFragment();

    list.forEach((track, idx) => {
      const row = document.createElement("div");
      row.className = `music-row${String(track.id) === String(currentTrackId) ? " active" : ""}`;
      row.tabIndex = 0;
      row.setAttribute("role", "button");

      if (track.artwork) {
        const img = document.createElement("img");
        img.className = "music-row-art";
        img.src = track.artwork;
        img.alt = "";
        img.loading = "lazy";
        row.appendChild(img);
      } else {
        const ph = document.createElement("div");
        ph.className = "music-row-art music-row-art-empty";
        ph.textContent = "♪";
        row.appendChild(ph);
      }

      const meta = document.createElement("div");
      meta.className = "music-row-meta";
      const tEl = document.createElement("div");
      tEl.className = "music-row-title";
      tEl.textContent = track.title;
      const aEl = document.createElement("div");
      aEl.className = "music-row-artist";
      aEl.textContent = track.artist;
      meta.append(tEl, aEl);
      row.appendChild(meta);

      const dur = document.createElement("span");
      dur.className = "music-row-dur";
      dur.textContent = track.snipped
        ? "0:30"
        : formatTime((track.durationMs || 0) / 1000);
      row.appendChild(dur);

      const saveBtn = document.createElement("button");
      saveBtn.type = "button";
      const saved = isTrackSaved(track.id);
      saveBtn.className = `music-save-btn${saved ? " saved" : ""}`;
      saveBtn.textContent = saved ? "♥" : "♡";
      saveBtn.title = saved ? "Remove from saved" : "Save track";
      saveBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleSaveTrack(track);
      });
      row.appendChild(saveBtn);

      const activate = () => {
        tracks = list;
        playTrackAt(idx);
      };
      row.addEventListener("click", activate);
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          activate();
        }
      });
      frag.appendChild(row);
    });

    container.appendChild(frag);
  }

  function renderTracks() {
    renderTrackListInto(listEl, searchTracks);
  }

  function renderSavedTracks() {
    if (!savedListEl || !savedEmpty) return;
    savedEmpty.classList.toggle("hidden", savedTracks.length > 0);
    renderTrackListInto(savedListEl, savedTracks);
  }

  function playTrackAt(index) {
    if (index < 0 || index >= tracks.length) return;
    currentIndex = index;
    const track = tracks[index];
    currentTrackId = track.id;

    renderTracks();
    renderSavedTracks();
    nowTitle.textContent = track.title;
    nowArtist.textContent = track.snipped ? `${track.artist} · Preview` : track.artist;
    miniTitle.textContent = `${track.title} — ${track.artist}`;

    if (track.artwork) {
      nowArt.src = track.artwork;
      nowArt.classList.remove("hidden");
      artFallback.classList.add("hidden");
      miniArt.src = track.artwork;
      miniArt.classList.remove("hidden");
      const safeBgUrl = track.artwork
        .replace("-t200x200.", "-t500x500.")
        .replace(/["'()\\]/g, "");
      bgArt.style.backgroundImage = `url("${safeBgUrl}")`;
      bgArt.classList.add("active");
    } else {
      nowArt.classList.add("hidden");
      artFallback.classList.remove("hidden");
      miniArt.classList.add("hidden");
      bgArt.style.backgroundImage = "";
      bgArt.classList.remove("active");
    }

    miniBar.classList.toggle("hidden", isOpen);
    seekBar.value = "0";
    timeCurrent.textContent = "0:00";
    timeTotal.textContent = formatTime((track.durationMs || 0) / 1000);

    destroyStream();
    loadTrackLyrics(track);

    if (track.protocol === "progressive") {
      audio.src = `/api/music/stream/${encodeURIComponent(track.id)}`;
      audio.play().catch(() => {});
    } else if (Hls.isSupported()) {
      const playlistUrl = `/api/music/playlist/${encodeURIComponent(track.id)}.m3u8`;
      hls = new Hls({ enableWorker: true });
      hls.loadSource(playlistUrl);
      hls.attachMedia(audio);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        audio.play().catch(() => {});
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data?.fatal) {
          setStatus("Could not stream track — try another.");
        }
      });
    } else if (audio.canPlayType("application/vnd.apple.mpegurl")) {
      audio.src = `/api/music/playlist/${encodeURIComponent(track.id)}.m3u8`;
      audio.play().catch(() => {});
    } else {
      setStatus("HLS playback is not supported in this browser.");
    }
    updatePlayIcons();
  }

  async function search(query) {
    const q = query.trim();
    if (!q) return;
    setStatus("Searching SoundCloud...");
    listEl.innerHTML = "";

    try {
      const res = await fetch(`/api/music/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      searchTracks = Array.isArray(data.tracks) ? data.tracks : [];
      tracks = searchTracks;
      currentIndex = searchTracks.findIndex((t) => String(t.id) === String(currentTrackId));
      if (searchTracks.length === 0) {
        setStatus("No playable tracks found.");
        return;
      }
      setStatus("");
      renderTracks();
    } catch (err) {
      setStatus(`Search failed: ${err?.message || err}`);
    }
  }

  // Events
  toggleBtn.addEventListener("click", () => updatePanelVisibility(!isOpen));
  closeBtn.addEventListener("click", () => updatePanelVisibility(false));
  miniTitle.addEventListener("click", () => updatePanelVisibility(true));

  searchForm.addEventListener("submit", (e) => {
    e.preventDefault();
    search(searchInput.value);
  });

  function togglePlayPause() {
    if (currentIndex === -1 && tracks.length > 0) {
      playTrackAt(0);
      return;
    }
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  }

  playBtn.addEventListener("click", togglePlayPause);
  miniPlayBtn.addEventListener("click", togglePlayPause);

  prevBtn.addEventListener("click", () => {
    if (tracks.length === 0) return;
    const prevIdx = currentIndex > 0 ? currentIndex - 1 : tracks.length - 1;
    playTrackAt(prevIdx);
  });

  nextBtn.addEventListener("click", () => {
    if (tracks.length === 0) return;
    const nextIdx = (currentIndex + 1) % tracks.length;
    playTrackAt(nextIdx);
  });

  volSlider?.addEventListener("input", () => {
    audio.volume = Number(volSlider.value);
    audio.muted = audio.volume === 0;
  });

  muteBtn?.addEventListener("click", () => {
    audio.muted = !audio.muted;
    if (!audio.muted && audio.volume === 0) {
      audio.volume = 0.7;
      if (volSlider) volSlider.value = "0.7";
    }
  });

  seekBar.addEventListener("input", () => {
    isSeeking = true;
    const dur = audio.duration;
    if (Number.isFinite(dur) && dur > 0) {
      timeCurrent.textContent = formatTime((Number(seekBar.value) / 100) * dur);
    }
  });

  seekBar.addEventListener("change", () => {
    const dur = audio.duration;
    if (Number.isFinite(dur) && dur > 0) {
      audio.currentTime = (Number(seekBar.value) / 100) * dur;
      syncLyricsFrame();
    }
    isSeeking = false;
  });

  audio.addEventListener("play", () => {
    updatePlayIcons();
    startLyricsLoop();
  });
  audio.addEventListener("pause", () => {
    updatePlayIcons();
    stopLyricsLoop();
  });
  audio.addEventListener("loadedmetadata", () => {
    if (Number.isFinite(audio.duration)) {
      timeTotal.textContent = formatTime(audio.duration);
    }
  });
  audio.addEventListener("timeupdate", () => {
    if (isSeeking) return;
    const dur = audio.duration;
    if (Number.isFinite(dur) && dur > 0) {
      seekBar.value = String((audio.currentTime / dur) * 100);
      timeCurrent.textContent = formatTime(audio.currentTime);
      timeTotal.textContent = formatTime(dur);
    }
  });
  audio.addEventListener("ended", () => {
    stopLyricsLoop();
    if (tracks.length > 1 && currentIndex + 1 < tracks.length) {
      playTrackAt(currentIndex + 1);
    } else {
      updatePlayIcons();
    }
  });

  renderSavedTracks();

  return {
    setSavedTracks(list) {
      if (!Array.isArray(list)) return;
      savedTracks = list;
      localStorage.setItem(SAVED_TRACKS_KEY, JSON.stringify(savedTracks));
      renderTracks();
      renderSavedTracks();
    },
  };
}
