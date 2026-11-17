// AI chat view. Talks to /api/ai/*; the API key never reaches the browser.
// Conversations are saved to the signed-in account, so they follow you across devices.

const MODEL_STORAGE_KEY = "simple_ai_model";

const escapeHtml = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const newId = () =>
  globalThis.crypto?.randomUUID?.() ||
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

// DeepSeek often answers math in LaTeX. There is no renderer here, so turn the common
// pieces into readable plain text instead of showing raw backslashes.
function simplifyLatex(text) {
  let out = text
    .replace(/\\\[|\\\]|\\\(|\\\)/g, "")
    .replace(/\$\$/g, "")
    .replace(/\$([^$\n]{1,200})\$/g, "$1");
  for (let i = 0; i < 3; i++) {
    out = out
      .replace(/\\d?frac\{([^{}]*)\}\{([^{}]*)\}/g, "($1)/($2)")
      .replace(/\\sqrt\{([^{}]*)\}/g, "√($1)")
      .replace(/\\text\{([^{}]*)\}/g, "$1")
      .replace(/\^\{([^{}]*)\}/g, (_, e) => toSuperscript(e));
  }
  const symbols = {
    times: "×", cdot: "·", div: "÷", pm: "±", leq: "≤", geq: "≥", neq: "≠",
    approx: "≈", pi: "π", infty: "∞", Rightarrow: "⇒", rightarrow: "→", to: "→",
    left: "", right: "", quad: " ", sqrt: "√",
  };
  return out.replace(/\\([A-Za-z]+)/g, (m, name) => (name in symbols ? symbols[name] : m));
}

function toSuperscript(exp) {
  const map = { 0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸", 9: "⁹", "-": "⁻", "+": "⁺", n: "ⁿ" };
  return [...exp].every((c) => c in map) ? [...exp].map((c) => map[c]).join("") : `^(${exp})`;
}

// Minimal Markdown. Everything is escaped first, then a few safe tags are added.
function renderMarkdown(text) {
  return text
    .split(/```/)
    .map((part, i) => {
      if (i % 2 === 1) {
        const lang = (part.match(/^([\w+#-]*)\n/) || [])[1] || "";
        const body = part.replace(/^[\w+#-]*\n/, "").replace(/\n$/, "");
        return (
          `<div class="ai-code-wrap"><div class="ai-code-head"><span>${escapeHtml(lang || "code")}</span>` +
          `<button class="ai-copy" type="button">Copy</button></div>` +
          `<pre class="ai-code"><code>${escapeHtml(body)}</code></pre></div>`
        );
      }
      let html = escapeHtml(simplifyLatex(part));
      html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");
      html = html.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
      html = html.replace(/^\s*[-*] (.+)$/gm, "• $1");
      html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
      html = html.replace(/^#{1,3} (.+)$/gm, '<strong class="ai-h">$1</strong>');
      html = html.replace(/^---+$/gm, '<hr class="ai-hr">');
      return html.replace(/\n/g, "<br>");
    })
    .join("");
}

export function createAiController({ onRequestSignIn } = {}) {
  const $ = (id) => document.getElementById(id);
  const els = {
    view: $("ai-view"),
    sidebar: $("ai-sidebar"),
    sidebarToggle: $("ai-sidebar-toggle"),
    list: $("ai-convo-list"),
    title: $("ai-title"),
    messages: $("ai-messages"),
    locked: $("ai-locked"),
    signinBtn: $("ai-signin-btn"),
    form: $("ai-form"),
    input: $("ai-input"),
    sendBtn: $("ai-send-btn"),
    newBtn: $("ai-new-btn"),
    modelSelect: $("ai-model-select"),
  };

  let user = null;
  let conversations = [];
  let currentId = null;
  let history = [];
  let busy = false;
  let abort = null;
  let userStopped = false;

  const api = async (path, options = {}) => {
    const res = await fetch(`/api/ai/${path}`, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  };

  const autosize = () => {
    els.input.style.height = "auto";
    els.input.style.height = `${Math.min(els.input.scrollHeight, 180)}px`;
  };

  const scrollDown = () => {
    els.messages.scrollTop = els.messages.scrollHeight;
  };

  function addBubble(role, text = "") {
    const row = document.createElement("div");
    row.className = `ai-msg ai-msg-${role}`;
    const bubble = document.createElement("div");
    bubble.className = "ai-bubble";
    if (role === "user") bubble.textContent = text;
    else if (text) bubble.innerHTML = renderMarkdown(text);
    else bubble.innerHTML = '<span class="ai-thinking"><span></span><span></span><span></span></span>';
    row.appendChild(bubble);
    els.messages.appendChild(row);
    scrollDown();
    return bubble;
  }

  function clearMessages() {
    els.messages.querySelectorAll(".ai-msg").forEach((n) => n.remove());
  }

  function showConversation(messages) {
    clearMessages();
    for (const m of messages) addBubble(m.role, m.content);
    scrollDown();
  }

  function setBusy(value) {
    busy = value;
    els.sendBtn.classList.toggle("busy", value);
    els.sendBtn.setAttribute("aria-label", value ? "Stop generating" : "Send message");
  }

  function renderList() {
    els.list.replaceChildren();
    if (!user) return;
    if (!conversations.length) {
      const hint = document.createElement("div");
      hint.className = "ai-convo-empty";
      hint.textContent = "Your chats will show up here.";
      els.list.appendChild(hint);
      return;
    }
    for (const c of conversations) {
      const row = document.createElement("div");
      row.className = `ai-convo${c.id === currentId ? " active" : ""}`;
      const open = document.createElement("button");
      open.type = "button";
      open.className = "ai-convo-open";
      open.textContent = c.title;
      open.title = c.title;
      open.addEventListener("click", () => openConversation(c.id));
      const del = document.createElement("button");
      del.type = "button";
      del.className = "ai-convo-del";
      del.title = "Delete chat";
      del.setAttribute("aria-label", `Delete chat ${c.title}`);
      del.textContent = "✕";
      del.addEventListener("click", () => deleteConversation(c));
      row.append(open, del);
      els.list.appendChild(row);
    }
  }

  function setTitle() {
    const current = conversations.find((c) => c.id === currentId);
    els.title.textContent = current ? current.title : "New chat";
  }

  function updateLock() {
    const signedIn = Boolean(user);
    els.locked.classList.toggle("hidden", signedIn);
    els.form.classList.toggle("hidden", !signedIn);
    els.newBtn.disabled = !signedIn;
  }

  async function loadList() {
    try {
      conversations = (await api("conversations")).conversations;
    } catch {
      conversations = [];
    }
    renderList();
    setTitle();
  }

  function resetView() {
    abort?.abort();
    currentId = null;
    history = [];
    clearMessages();
    setBusy(false);
    renderList();
    setTitle();
  }

  async function openConversation(id) {
    if (id === currentId) {
      els.sidebar.classList.remove("open");
      return;
    }
    abort?.abort();
    try {
      const { conversation } = await api(`conversations/${encodeURIComponent(id)}`);
      currentId = conversation.id;
      history = conversation.messages.map((m) => ({ role: m.role, content: m.content }));
      showConversation(history);
      renderList();
      setTitle();
      els.sidebar.classList.remove("open");
    } catch (err) {
      await loadList(); // the chat may have been deleted elsewhere
      alert(err.message);
    }
  }

  async function deleteConversation(convo) {
    if (!window.confirm(`Delete "${convo.title}"? This can't be undone.`)) return;
    try {
      await api(`conversations/${encodeURIComponent(convo.id)}`, { method: "DELETE" });
    } catch (err) {
      alert(err.message);
      return;
    }
    conversations = conversations.filter((c) => c.id !== convo.id);
    if (convo.id === currentId) resetView();
    else renderList();
  }

  async function saveConversation() {
    if (!user || !currentId || !history.length) return;
    try {
      const { conversation } = await api(`conversations/${encodeURIComponent(currentId)}`, {
        method: "PUT",
        body: JSON.stringify({ messages: history, model: els.modelSelect.value }),
      });
      conversations = [conversation, ...conversations.filter((c) => c.id !== conversation.id)];
      renderList();
      setTitle();
    } catch {
      // Saving is best effort. The chat still works if it fails.
    }
  }

  async function send(text) {
    const content = text.trim();
    if (!content || busy) return;
    if (!user) {
      onRequestSignIn?.();
      return;
    }
    if (!currentId) currentId = newId();
    els.input.value = "";
    autosize();
    history.push({ role: "user", content });
    addBubble("user", content);
    const bubble = addBubble("assistant");
    setBusy(true);
    userStopped = false;
    abort = new AbortController();
    const myConversation = currentId;
    let reply = "";
    try {
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history, model: els.modelSelect.value }),
        signal: abort.signal,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Request failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        reply += decoder.decode(value, { stream: true });
        bubble.innerHTML = renderMarkdown(reply);
        scrollDown();
      }
      history.push({ role: "assistant", content: reply || "(no response)" });
      await saveConversation();
    } catch (err) {
      if (err.name === "AbortError") {
        // Stop button: keep what was generated. New chat or switching chats: just drop it.
        if (userStopped && myConversation === currentId && reply.trim()) {
          history.push({ role: "assistant", content: reply });
          await saveConversation();
        } else if (userStopped && myConversation === currentId) {
          history.pop();
          bubble.closest(".ai-msg")?.remove();
        }
        return;
      }
      history.pop(); // drop the unanswered question so it can be retried
      bubble.classList.add("ai-error");
      bubble.textContent = err.message || "Something went wrong.";
    } finally {
      abort = null;
      setBusy(false);
    }
  }

  // Events
  els.form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (busy) {
      userStopped = true;
      abort?.abort();
      return;
    }
    send(els.input.value);
  });
  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!busy) send(els.input.value);
    }
  });
  els.input.addEventListener("input", autosize);
  els.newBtn.addEventListener("click", () => {
    resetView();
    els.sidebar.classList.remove("open");
    els.input.focus();
  });
  els.sidebarToggle.addEventListener("click", () => els.sidebar.classList.toggle("open"));
  els.signinBtn.addEventListener("click", () => onRequestSignIn?.());

  // Copy buttons inside code blocks
  els.messages.addEventListener("click", async (e) => {
    const btn = e.target.closest(".ai-copy");
    if (!btn) return;
    const code = btn.closest(".ai-code-wrap")?.querySelector("code")?.textContent || "";
    try {
      await navigator.clipboard.writeText(code);
      btn.textContent = "Copied";
    } catch {
      btn.textContent = "Press Ctrl+C";
    }
    setTimeout(() => (btn.textContent = "Copy"), 1500);
  });

  // Fill the model switcher from the server so it always matches what the backend allows.
  fetch("/api/ai/status")
    .then((r) => r.json())
    .then((data) => {
      if (!Array.isArray(data.models) || !data.models.length) return;
      const saved = localStorage.getItem(MODEL_STORAGE_KEY);
      els.modelSelect.replaceChildren(
        ...data.models.map((m) => {
          const opt = document.createElement("option");
          opt.value = m.id;
          opt.textContent = m.label;
          return opt;
        })
      );
      if (data.models.some((m) => m.id === saved)) els.modelSelect.value = saved;
    })
    .catch(() => {});
  els.modelSelect.addEventListener("change", () =>
    localStorage.setItem(MODEL_STORAGE_KEY, els.modelSelect.value)
  );

  updateLock();
  return {
    setUser(next) {
      const changed = (next?.id || null) !== (user?.id || null);
      user = next || null;
      updateLock();
      if (changed) {
        resetView();
        conversations = [];
        if (user) loadList();
        else renderList();
      }
    },
    focus() {
      if (user) els.input.focus();
    },
  };
}
