import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_STORE_PATH = join(__dirname, "..", "data", "ai-chats.json");

const ID_RE = /^[a-zA-Z0-9-]{8,64}$/;
const MAX_CONVERSATIONS = 50;
const MAX_MESSAGES = 200;
const MAX_CONTENT = 32_000;

export class AiStoreError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function isValidConversationId(id) {
  return typeof id === "string" && ID_RE.test(id);
}

function cleanMessages(input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new AiStoreError("A conversation needs at least one message.");
  }
  return input.slice(-MAX_MESSAGES).map((m) => {
    const content = typeof m?.content === "string" ? m.content.slice(0, MAX_CONTENT) : "";
    if (!content.trim()) throw new AiStoreError("Messages cannot be empty.");
    return { role: m?.role === "assistant" ? "assistant" : "user", content };
  });
}

function makeTitle(messages) {
  const first = messages.find((m) => m.role === "user")?.content || "New chat";
  const flat = first.replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 57)}...` : flat;
}

/**
 * Per-user AI conversation storage in a single JSON file, written atomically.
 * Every read and write is keyed by user id, so one account can never reach another's chats.
 */
export function createAiStore({ storePath = DEFAULT_STORE_PATH } = {}) {
  let cache = null;
  let writeChain = Promise.resolve();

  async function load() {
    if (cache) return cache;
    try {
      const parsed = JSON.parse(await readFile(storePath, "utf8"));
      cache = { users: parsed?.users && typeof parsed.users === "object" ? parsed.users : {} };
    } catch {
      cache = { users: {} };
    }
    return cache;
  }

  function persist() {
    const snapshot = JSON.stringify(cache);
    writeChain = writeChain
      .then(async () => {
        await mkdir(dirname(storePath), { recursive: true });
        const tmp = `${storePath}.${process.pid}.${Date.now()}.tmp`;
        await writeFile(tmp, snapshot, "utf8");
        await rename(tmp, storePath);
      })
      .catch((err) => console.error("[ai-store] write failed:", err?.message || err));
    return writeChain;
  }

  const summary = (c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt });

  return {
    async list(userId) {
      const store = await load();
      return Object.values(store.users[userId] || {})
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(summary);
    },

    async get(userId, id) {
      if (!isValidConversationId(id)) throw new AiStoreError("Invalid conversation id.");
      const store = await load();
      const convo = store.users[userId]?.[id];
      if (!convo) throw new AiStoreError("Conversation not found.", 404);
      return convo;
    },

    async save(userId, id, { messages, model }) {
      if (!isValidConversationId(id)) throw new AiStoreError("Invalid conversation id.");
      const clean = cleanMessages(messages);
      const store = await load();
      const mine = (store.users[userId] ||= {});
      const existing = mine[id];
      const now = Date.now();

      if (!existing && Object.keys(mine).length >= MAX_CONVERSATIONS) {
        const oldest = Object.values(mine).sort((a, b) => a.updatedAt - b.updatedAt)[0];
        delete mine[oldest.id];
      }

      mine[id] = {
        id,
        title: existing?.title || makeTitle(clean),
        model: typeof model === "string" ? model.slice(0, 100) : existing?.model || "",
        messages: clean,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
      };
      await persist();
      return summary(mine[id]);
    },

    async remove(userId, id) {
      if (!isValidConversationId(id)) throw new AiStoreError("Invalid conversation id.");
      const store = await load();
      if (store.users[userId]?.[id]) {
        delete store.users[userId][id];
        await persist();
      }
    },

    async removeUser(userId) {
      const store = await load();
      if (store.users[userId]) {
        delete store.users[userId];
        await persist();
      }
    },
  };
}
