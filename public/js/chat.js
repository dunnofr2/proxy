const QUICK_EMOJIS = [
  "😂", "🔥", "💀", "👍", "❤️", "😭", "👀", "🎵",
  "🎮", "✨", "💯", "😎", "🤝", "⚡", "👏", "🙌",
];

function formatTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function getDayKey(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function formatDayLabel(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const todayKey = getDayKey(now.toISOString());
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const yestKey = getDayKey(yesterday.toISOString());
  const key = getDayKey(iso);
  if (key === todayKey) return "Today";
  if (key === yestKey) return "Yesterday";
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

function appendLinkedText(container, text) {
  const urlRe = /(https?:\/\/[^\s<]+)/gi;
  let lastIndex = 0;
  let match;
  while ((match = urlRe.exec(text)) !== null) {
    if (match.index > lastIndex) {
      container.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
    }
    const a = document.createElement("a");
    a.href = match[0];
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.className = "chat-link";
    a.textContent = match[0];
    container.appendChild(a);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    container.appendChild(document.createTextNode(text.slice(lastIndex)));
  }
}

export function createChatController({ onRequestSignIn } = {}) {
  const lockedEl = document.getElementById("chat-locked");
  const signinBtn = document.getElementById("chat-signin-btn");
  const roomEl = document.getElementById("chat-room");
  const onlineEl = document.getElementById("chat-online");
  const railEl = document.getElementById("chat-members-rail");
  const railToggleBtn = document.getElementById("chat-members-toggle");
  const railCountEl = document.getElementById("chat-rail-count");
  const membersListEl = document.getElementById("chat-members-list");
  const clearBtn = document.getElementById("chat-clear-btn");
  const statusEl = document.getElementById("chat-status");
  const messagesEl = document.getElementById("chat-messages");
  const typingEl = document.getElementById("chat-typing");
  const typingTextEl = document.getElementById("chat-typing-text");
  const replyBarEl = document.getElementById("chat-reply-bar");
  const replyAuthorEl = document.getElementById("chat-reply-author");
  const replySnippetEl = document.getElementById("chat-reply-snippet");
  const replyCancelBtn = document.getElementById("chat-reply-cancel");
  const emojiBtn = document.getElementById("chat-emoji-btn");
  const emojiPicker = document.getElementById("chat-emoji-picker");
  const formEl = document.getElementById("chat-form");
  const inputEl = document.getElementById("chat-input");
  const charCountEl = document.getElementById("chat-char-count");

  let currentUser = null;
  let ws = null;
  let reconnectTimer = null;
  let messages = [];
  let onlineUsers = [];
  let isActiveView = false;
  let replyTarget = null;
  let lastTypingSentAt = 0;
  const typingMap = new Map();

  function setStatus(text) {
    if (!statusEl) return;
    statusEl.textContent = text || "";
    statusEl.classList.toggle("hidden", !text);
  }

  function createAvatarNode(author, sizeClass = "chat-avatar") {
    if (author?.avatarUrl) {
      const img = document.createElement("img");
      img.className = `${sizeClass}-img`;
      img.src = author.avatarUrl;
      img.alt = author.displayName || "User";
      img.addEventListener("error", () => {
        const fallback = document.createElement("div");
        fallback.className = `${sizeClass}-fallback`;
        fallback.textContent = (author.displayName?.[0] || "U").toUpperCase();
        img.replaceWith(fallback);
      });
      return img;
    }
    const fallback = document.createElement("div");
    fallback.className = `${sizeClass}-fallback`;
    fallback.textContent = (author?.displayName?.[0] || "U").toUpperCase();
    return fallback;
  }

  function renderOnlineMembers() {
    if (!membersListEl) return;
    if (railCountEl) railCountEl.textContent = String(onlineUsers.length);
    if (onlineEl) onlineEl.textContent = `${onlineUsers.length} online`;

    membersListEl.innerHTML = "";
    const frag = document.createDocumentFragment();
    for (const user of onlineUsers) {
      const item = document.createElement("div");
      item.className = "chat-member-row";
      item.appendChild(createAvatarNode(user, "chat-member-avatar"));

      const meta = document.createElement("div");
      meta.className = "chat-member-name-wrap";
      const name = document.createElement("span");
      name.className = "chat-member-name";
      name.textContent = user.displayName || "User";
      meta.appendChild(name);

      if (user.isOwner || user.role === "owner") {
        const badge = document.createElement("span");
        badge.className = "owner-badge";
        badge.textContent = "OWNER";
        meta.appendChild(badge);
      }

      item.appendChild(meta);
      frag.appendChild(item);
    }
    membersListEl.appendChild(frag);
  }

  function renderTyping() {
    if (!typingEl || !typingTextEl) return;
    const now = Date.now();
    const activeNames = [];
    for (const [id, info] of typingMap.entries()) {
      if (now > info.expiresAt) typingMap.delete(id);
      else if (id !== currentUser?.id) activeNames.push(info.name);
    }

    if (activeNames.length === 0) {
      typingEl.classList.add("hidden");
      return;
    }

    if (activeNames.length === 1) {
      typingTextEl.textContent = `${activeNames[0]} is typing...`;
    } else if (activeNames.length === 2) {
      typingTextEl.textContent = `${activeNames[0]} and ${activeNames[1]} are typing...`;
    } else {
      typingTextEl.textContent = "Several people are typing...";
    }
    typingEl.classList.remove("hidden");
  }

  setInterval(renderTyping, 1000);

  function setReplyTarget(msg) {
    replyTarget = msg || null;
    if (!replyBarEl) return;
    if (!replyTarget) {
      replyBarEl.classList.add("hidden");
      return;
    }
    replyAuthorEl.textContent = replyTarget.author?.displayName || "User";
    replySnippetEl.textContent = replyTarget.text.slice(0, 80);
    replyBarEl.classList.remove("hidden");
    inputEl?.focus();
  }

  function autoResizeInput() {
    if (!inputEl) return;
    inputEl.style.height = "auto";
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, 120)}px`;
    const len = inputEl.value.length;
    if (charCountEl) {
      charCountEl.textContent = `${len}/500`;
      charCountEl.classList.toggle("hidden", len < 350);
    }
  }

  function scrollToMessage(id) {
    const target = messagesEl?.querySelector(`[data-msg-id="${CSS.escape(id)}"]`);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add("highlight");
    setTimeout(() => target.classList.remove("highlight"), 1400);
  }

  function renderMessages({ scrollToBottom = true, animateLast = false } = {}) {
    if (!messagesEl) return;
    const wasNearBottom =
      messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 100;

    messagesEl.innerHTML = "";
    if (messages.length === 0) {
      const empty = document.createElement("div");
      empty.className = "chat-empty";
      empty.innerHTML =
        '<div class="chat-empty-title">Welcome to Simple Chat</div><div class="chat-empty-sub">No messages yet. Start the conversation below.</div>';
      messagesEl.appendChild(empty);
      return;
    }

    const frag = document.createDocumentFragment();
    let prevDay = "";
    let prevMsg = null;

    messages.forEach((msg, index) => {
      const author = msg.author || {};
      const dayKey = getDayKey(msg.createdAt);
      if (dayKey && dayKey !== prevDay) {
        prevDay = dayKey;
        prevMsg = null;
        const divider = document.createElement("div");
        divider.className = "chat-date-divider";
        const span = document.createElement("span");
        span.textContent = formatDayLabel(msg.createdAt);
        divider.appendChild(span);
        frag.appendChild(divider);
      }

      const prevTime = prevMsg ? new Date(prevMsg.createdAt).getTime() : 0;
      const currTime = new Date(msg.createdAt).getTime();
      const grouped =
        Boolean(prevMsg) &&
        !msg.replyTo &&
        prevMsg.author?.id === author.id &&
        currTime - prevTime < 5 * 60 * 1000;

      const isSelf = author.id === currentUser?.id;
      const row = document.createElement("div");
      row.dataset.msgId = msg.id;
      row.className = `chat-msg${isSelf ? " self" : ""}${grouped ? " grouped" : ""}${
        animateLast && index === messages.length - 1 ? " msg-enter" : ""
      }`;

      if (!grouped) {
        row.appendChild(createAvatarNode(author, "chat-avatar"));
      } else {
        const spacer = document.createElement("div");
        spacer.className = "chat-grouped-time";
        spacer.textContent = formatTime(msg.createdAt);
        row.appendChild(spacer);
      }

      const body = document.createElement("div");
      body.className = "chat-msg-body";

      if (!grouped) {
        const meta = document.createElement("div");
        meta.className = "chat-msg-meta";

        const name = document.createElement("span");
        name.className = "chat-msg-name";
        name.textContent = author.displayName || "User";
        meta.appendChild(name);

        if (author.isOwner || author.role === "owner") {
          const badge = document.createElement("span");
          badge.className = "owner-badge";
          badge.textContent = "OWNER";
          meta.appendChild(badge);
        }

        const time = document.createElement("span");
        time.className = "chat-msg-time";
        time.textContent = formatTime(msg.createdAt);
        meta.appendChild(time);

        body.appendChild(meta);
      }

      if (msg.replyTo) {
        const quote = document.createElement("button");
        quote.type = "button";
        quote.className = "chat-reply-quote";
        const qAuthor = document.createElement("strong");
        qAuthor.textContent = `@${msg.replyTo.authorName}: `;
        const qText = document.createElement("span");
        qText.textContent = msg.replyTo.textSnippet;
        quote.append(qAuthor, qText);
        quote.addEventListener("click", () => scrollToMessage(msg.replyTo.id));
        body.appendChild(quote);
      }

      const bubble = document.createElement("div");
      bubble.className = "chat-bubble";
      appendLinkedText(bubble, msg.text);
      body.appendChild(bubble);

      // Hover actions pill
      const actions = document.createElement("div");
      actions.className = "chat-msg-actions";

      const replyBtn = document.createElement("button");
      replyBtn.type = "button";
      replyBtn.className = "chat-action-btn";
      replyBtn.textContent = "↩";
      replyBtn.title = "Reply";
      replyBtn.addEventListener("click", () => setReplyTarget(msg));
      actions.appendChild(replyBtn);

      if (currentUser && (isSelf || currentUser.isOwner)) {
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "chat-action-btn danger";
        delBtn.textContent = "×";
        delBtn.title = "Delete message";
        delBtn.addEventListener("click", () => deleteMessage(msg.id));
        actions.appendChild(delBtn);
      }

      row.append(body, actions);
      frag.appendChild(row);
      prevMsg = msg;
    });

    messagesEl.appendChild(frag);
    if (scrollToBottom || wasNearBottom) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }

  function disconnectSocket() {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (ws) {
      ws.onclose = null;
      ws.close();
      ws = null;
    }
  }

  function connectSocket() {
    if (!currentUser || ws) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${proto}//${location.host}/ws/chat`);
    ws = socket;
    setStatus("Connecting to chat...");

    socket.addEventListener("open", () => {
      setStatus("");
    });

    socket.addEventListener("message", (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === "history") {
          messages = Array.isArray(payload.messages) ? payload.messages : [];
          onlineUsers = Array.isArray(payload.onlineUsers) ? payload.onlineUsers : [];
          renderOnlineMembers();
          renderMessages({ scrollToBottom: true });
        } else if (payload.type === "message" && payload.message) {
          messages.push(payload.message);
          if (messages.length > 200) messages = messages.slice(-200);
          if (payload.message.author?.id) {
            typingMap.delete(payload.message.author.id);
            renderTyping();
          }
          renderMessages({ scrollToBottom: false, animateLast: true });
        } else if (payload.type === "delete" && payload.id) {
          messages = messages.filter((m) => m.id !== payload.id);
          renderMessages({ scrollToBottom: false });
        } else if (payload.type === "clear") {
          messages = [];
          setReplyTarget(null);
          renderMessages({ scrollToBottom: true });
        } else if (payload.type === "presence") {
          if (Array.isArray(payload.onlineUsers)) {
            onlineUsers = payload.onlineUsers;
          }
          renderOnlineMembers();
        } else if (payload.type === "user_update" && payload.user) {
          messages = messages.map((m) =>
            m.author?.id === payload.user.id ? { ...m, author: payload.user } : m
          );
          onlineUsers = onlineUsers.map((u) =>
            u.id === payload.user.id ? payload.user : u
          );
          renderOnlineMembers();
          renderMessages({ scrollToBottom: false });
        } else if (payload.type === "typing" && payload.user) {
          typingMap.set(payload.user.id, {
            name: payload.user.displayName || "Someone",
            expiresAt: Date.now() + 3000,
          });
          renderTyping();
        } else if (payload.type === "error" && payload.error) {
          setStatus(payload.error);
        }
      } catch {
        // Ignore malformed frame
      }
    });

    socket.onclose = () => {
      if (ws === socket) ws = null;
      if (currentUser) {
        setStatus("Reconnecting...");
        reconnectTimer = setTimeout(connectSocket, 2000);
      }
    };
  }

  async function deleteMessage(id) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "delete", id }));
      return;
    }
    await fetch(`/api/chat/messages/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  async function sendMessage(rawText) {
    const text = rawText.trim();
    if (!text || !currentUser) return;
    setStatus("");
    const replyId = replyTarget?.id || null;

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "send", text, replyTo: replyId }));
      inputEl.value = "";
      autoResizeInput();
      setReplyTarget(null);
      return;
    }

    const res = await fetch("/api/chat/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, replyTo: replyId }),
    });
    const data = await res.json();
    if (!res.ok) {
      setStatus(data?.error || "Failed to send message.");
      return;
    }
    inputEl.value = "";
    autoResizeInput();
    setReplyTarget(null);
  }

  function setUser(user) {
    const prevId = currentUser?.id;
    currentUser = user || null;

    lockedEl?.classList.toggle("hidden", Boolean(currentUser));
    roomEl?.classList.toggle("hidden", !currentUser);
    clearBtn?.classList.toggle("hidden", !currentUser?.isOwner);

    if (!currentUser) {
      disconnectSocket();
      messages = [];
      onlineUsers = [];
      setReplyTarget(null);
      renderMessages({ scrollToBottom: true });
      setStatus("");
      return;
    }

    if (prevId !== currentUser.id) {
      disconnectSocket();
    }
    if (isActiveView || ws) {
      connectSocket();
    }
    renderMessages({ scrollToBottom: false });
  }

  function setActive(active) {
    isActiveView = active;
    if (active && currentUser) {
      connectSocket();
      inputEl?.focus();
    }
  }

  // Build quick emoji picker
  if (emojiPicker) {
    for (const emoji of QUICK_EMOJIS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "emoji-choice";
      btn.textContent = emoji;
      btn.addEventListener("click", () => {
        if (!inputEl) return;
        const start = inputEl.selectionStart ?? inputEl.value.length;
        const end = inputEl.selectionEnd ?? inputEl.value.length;
        inputEl.value =
          inputEl.value.slice(0, start) + emoji + inputEl.value.slice(end);
        inputEl.focus();
        inputEl.setSelectionRange(start + emoji.length, start + emoji.length);
        autoResizeInput();
        emojiPicker.classList.add("hidden");
      });
      emojiPicker.appendChild(btn);
    }
  }

  emojiBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    emojiPicker?.classList.toggle("hidden");
  });

  document.addEventListener("click", (e) => {
    if (
      emojiPicker &&
      !emojiPicker.classList.contains("hidden") &&
      !emojiPicker.contains(e.target) &&
      e.target !== emojiBtn
    ) {
      emojiPicker.classList.add("hidden");
    }
  });

  railToggleBtn?.addEventListener("click", () => {
    railEl?.classList.toggle("open");
  });

  replyCancelBtn?.addEventListener("click", () => setReplyTarget(null));
  signinBtn?.addEventListener("click", () => onRequestSignIn?.());

  inputEl?.addEventListener("input", () => {
    autoResizeInput();
    if (ws && ws.readyState === WebSocket.OPEN && inputEl.value.trim()) {
      const now = Date.now();
      if (now - lastTypingSentAt > 1500) {
        lastTypingSentAt = now;
        ws.send(JSON.stringify({ type: "typing" }));
      }
    }
  });

  inputEl?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(inputEl.value);
    } else if (e.key === "Escape" && replyTarget) {
      setReplyTarget(null);
    }
  });

  formEl?.addEventListener("submit", (e) => {
    e.preventDefault();
    sendMessage(inputEl.value);
  });

  clearBtn?.addEventListener("click", async () => {
    if (!currentUser?.isOwner) return;
    if (!confirm("Clear all messages in the chat room?")) return;
    const res = await fetch("/api/chat/messages", { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setStatus(data?.error || "Failed to clear chat.");
    }
  });

  return {
    setUser,
    setActive,
  };
}
