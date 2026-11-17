import crypto from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { AuthError, SESSION_COOKIE_NAME, parseCookies, toPublicAuthor } from "./auth.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CHAT_STORE = join(__dirname, "..", "data", "chat.json");
const MAX_STORED_MESSAGES = 200;
const MAX_MESSAGE_LENGTH = 500;

export function createChatService({
  storePath = DEFAULT_CHAT_STORE,
  authService,
} = {}) {
  let cache = null;
  let writeChain = Promise.resolve();
  const lastPostByUser = new Map();
  const wss = new WebSocketServer({ noServer: true });

  async function loadStore() {
    if (cache) return cache;
    try {
      const raw = await readFile(storePath, "utf8");
      const parsed = JSON.parse(raw);
      cache = {
        messages: Array.isArray(parsed?.messages) ? parsed.messages : [],
      };
    } catch (err) {
      if (err?.code === "ENOENT") {
        cache = { messages: [] };
      } else {
        throw err;
      }
    }
    return cache;
  }

  async function saveStore(store) {
    if (store.messages.length > MAX_STORED_MESSAGES) {
      store.messages = store.messages.slice(-MAX_STORED_MESSAGES);
    }
    const snapshot = JSON.stringify(store, null, 2);
    writeChain = writeChain.then(async () => {
      await mkdir(dirname(storePath), { recursive: true });
      const tmp = `${storePath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, snapshot, "utf8");
      await rename(tmp, storePath);
    });
    return writeChain;
  }

  async function hydrateMessage(msg) {
    const liveAuthor = authService ? await authService.getPublicUser(msg.userId) : null;
    return {
      id: msg.id,
      text: msg.text,
      createdAt: msg.createdAt,
      replyTo: msg.replyTo || null,
      author: liveAuthor || msg.authorSnapshot || {
        id: msg.userId,
        displayName: "Deleted User",
        avatarUrl: "",
        role: "member",
        isOwner: false,
      },
    };
  }

  function broadcast(payload, excludeSocket = null) {
    const raw = JSON.stringify(payload);
    for (const client of wss.clients) {
      if (client !== excludeSocket && client.readyState === WebSocket.OPEN) {
        client.send(raw);
      }
    }
  }

  function getOnlineUsers() {
    const byId = new Map();
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN && client.user?.id) {
        byId.set(client.user.id, toPublicAuthor(client.user));
      }
    }
    return [...byId.values()].sort((a, b) => {
      if (a.isOwner !== b.isOwner) return a.isOwner ? -1 : 1;
      return a.displayName.localeCompare(b.displayName);
    });
  }

  async function getMessages(limit = 100) {
    const store = await loadStore();
    const slice = store.messages.slice(-Math.min(limit, MAX_STORED_MESSAGES));
    return Promise.all(slice.map(hydrateMessage));
  }

  async function postMessage(user, rawText, replyToId = null) {
    if (!user) throw new AuthError("Sign in to send messages.", 401);
    const text = String(rawText || "").trim();
    if (!text) throw new AuthError("Message cannot be empty.", 400);
    if (text.length > MAX_MESSAGE_LENGTH) {
      throw new AuthError(`Message is too long (max ${MAX_MESSAGE_LENGTH} characters).`, 400);
    }

    const now = Date.now();
    const prev = lastPostByUser.get(user.id) || 0;
    if (now - prev < 350) {
      throw new AuthError("Slow down slightly before sending another message.", 429);
    }
    lastPostByUser.set(user.id, now);

    const store = await loadStore();
    let replyTo = null;
    if (replyToId) {
      const target = store.messages.find((m) => m.id === String(replyToId));
      if (target) {
        const targetAuthor = authService
          ? await authService.getPublicUser(target.userId)
          : null;
        replyTo = {
          id: target.id,
          authorName:
            targetAuthor?.displayName || target.authorSnapshot?.displayName || "User",
          textSnippet: target.text.slice(0, 100),
        };
      }
    }

    const entry = {
      id: crypto.randomUUID(),
      userId: user.id,
      authorSnapshot: toPublicAuthor(user),
      text,
      replyTo,
      createdAt: new Date(now).toISOString(),
    };
    store.messages.push(entry);
    await saveStore(store);

    const hydrated = await hydrateMessage(entry);
    broadcast({ type: "message", message: hydrated });
    return hydrated;
  }

  async function deleteMessage(user, messageId) {
    if (!user) throw new AuthError("Authentication required.", 401);
    const store = await loadStore();
    const idx = store.messages.findIndex((m) => m.id === messageId);
    if (idx === -1) throw new AuthError("Message not found.", 404);

    const target = store.messages[idx];
    if (target.userId !== user.id && !user.isOwner) {
      throw new AuthError("Only the author or owner can delete this message.", 403);
    }

    store.messages.splice(idx, 1);
    await saveStore(store);
    broadcast({ type: "delete", id: messageId });
  }

  async function clearMessages(user) {
    if (!user) throw new AuthError("Authentication required.", 401);
    if (!user.isOwner) {
      throw new AuthError("Only the owner can clear the chat.", 403);
    }
    const store = await loadStore();
    store.messages = [];
    await saveStore(store);
    broadcast({ type: "clear" });
  }

  function broadcastUserUpdate(user) {
    if (!user) return;
    const pub = toPublicAuthor(user);
    for (const client of wss.clients) {
      if (client.user?.id === user.id) {
        client.user = user;
      }
    }
    broadcast({ type: "user_update", user: pub });
    const onlineUsers = getOnlineUsers();
    broadcast({ type: "presence", onlineCount: onlineUsers.length, onlineUsers });
  }

  async function handleUpgrade(req, socket, head) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME] || "";
    const user = authService ? await authService.getUserByToken(token) : null;
    if (!user) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, async (ws) => {
      ws.user = user;
      try {
        const messages = await getMessages(100);
        const onlineUsers = getOnlineUsers();
        ws.send(
          JSON.stringify({
            type: "history",
            messages,
            onlineCount: onlineUsers.length,
            onlineUsers,
          })
        );
        broadcast({
          type: "presence",
          onlineCount: onlineUsers.length,
          onlineUsers,
        });
      } catch {
        ws.close();
        return;
      }

      ws.on("message", async (raw) => {
        try {
          const payload = JSON.parse(String(raw || "{}"));
          const freshPublic = await authService.getPublicUser(ws.user.id);
          const freshUser = freshPublic ? { ...ws.user, ...freshPublic } : null;
          if (!freshUser) {
            ws.send(JSON.stringify({ type: "error", error: "Session expired." }));
            ws.close();
            return;
          }
          if (payload.type === "send") {
            await postMessage(freshUser, payload.text, payload.replyTo || null);
          } else if (payload.type === "delete" && payload.id) {
            await deleteMessage(freshUser, String(payload.id));
          } else if (payload.type === "typing") {
            broadcast({ type: "typing", user: toPublicAuthor(freshUser) }, ws);
          }
        } catch (err) {
          ws.send(
            JSON.stringify({
              type: "error",
              error: err?.message || "Chat error",
            })
          );
        }
      });

      ws.on("close", () => {
        const onlineUsers = getOnlineUsers();
        broadcast({
          type: "presence",
          onlineCount: onlineUsers.length,
          onlineUsers,
        });
      });
    });
  }

  function close() {
    for (const client of wss.clients) {
      client.close();
    }
    wss.close();
  }

  return {
    getMessages,
    postMessage,
    deleteMessage,
    clearMessages,
    broadcastUserUpdate,
    handleUpgrade,
    close,
  };
}
