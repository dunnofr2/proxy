import crypto from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sendVerificationEmail } from "./mailer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_STORE_PATH = join(__dirname, "..", "data", "accounts.json");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATA_IMAGE_RE = /^data:image\/(png|jpeg|jpg|webp|gif);base64,[a-z0-9+/=]+$/i;
const DEFAULT_OWNERS = ["mr.eggg62@gmail.com"];
const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 30 * 1000;
const MAX_CODE_ATTEMPTS = 5;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_COOKIE_NAME = "simple_session";

export function isOwnerEmail(email) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) return false;
  if (DEFAULT_OWNERS.includes(normalized)) return true;
  const extra = String(process.env.OWNER_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return extra.includes(normalized);
}

export function validateAvatarUrl(raw) {
  if (raw === undefined || raw === null) return undefined;
  const val = String(raw).trim();
  if (!val) return "";
  if (DATA_IMAGE_RE.test(val)) {
    if (val.length > 180_000) {
      throw new AuthError("Profile image is too large (max ~130 KB).", 400);
    }
    return val;
  }
  try {
    const parsed = new URL(val);
    if ((parsed.protocol === "https:" || parsed.protocol === "http:") && val.length <= 500) {
      return parsed.href;
    }
  } catch {
    // Fall through
  }
  throw new AuthError("Use an https:// image URL or upload PNG/JPG/WebP/GIF.", 400);
}

export function normalizeEmail(raw) {
  const email = String(raw || "").trim().toLowerCase();
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    return null;
  }
  return email;
}

function hashCode(code, salt) {
  return crypto.scryptSync(code, salt, 32).toString("hex");
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function emptyStore() {
  return { users: {}, challenges: {}, sessions: {} };
}

function defaultPreferences() {
  return {
    searchEngine: "ddg_html",
    favoriteGames: [],
    savedTracks: [],
  };
}

function sanitizeUser(user) {
  if (!user) return null;
  const isOwner = isOwnerEmail(user.email);
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl || "",
    role: isOwner ? "owner" : "member",
    isOwner,
    createdAt: user.createdAt,
    preferences: {
      searchEngine: user.preferences?.searchEngine || "ddg_html",
      favoriteGames: Array.isArray(user.preferences?.favoriteGames)
        ? user.preferences.favoriteGames
        : [],
      savedTracks: Array.isArray(user.preferences?.savedTracks)
        ? user.preferences.savedTracks
        : [],
    },
  };
}

export function toPublicAuthor(user) {
  if (!user) return null;
  const isOwner = isOwnerEmail(user.email);
  return {
    id: user.id,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl || "",
    role: isOwner ? "owner" : "member",
    isOwner,
  };
}

export class AuthError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export function createAuthService({
  storePath = DEFAULT_STORE_PATH,
  sendEmail = sendVerificationEmail,
} = {}) {
  let cache = null;
  let writeChain = Promise.resolve();

  async function loadStore() {
    if (cache) return cache;
    try {
      const raw = await readFile(storePath, "utf8");
      const parsed = JSON.parse(raw);
      cache = {
        users: parsed?.users && typeof parsed.users === "object" ? parsed.users : {},
        challenges:
          parsed?.challenges && typeof parsed.challenges === "object"
            ? parsed.challenges
            : {},
        sessions:
          parsed?.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {},
      };
    } catch (err) {
      if (err?.code === "ENOENT") {
        cache = emptyStore();
      } else {
        throw err;
      }
    }
    return cache;
  }

  function pruneExpired(store, now = Date.now()) {
    for (const [email, ch] of Object.entries(store.challenges)) {
      if (!ch || now > ch.expiresAt) delete store.challenges[email];
    }
    for (const [hash, sess] of Object.entries(store.sessions)) {
      if (!sess || now > sess.expiresAt) delete store.sessions[hash];
    }
  }

  async function saveStore(store) {
    pruneExpired(store);
    const snapshot = JSON.stringify(store, null, 2);
    writeChain = writeChain.then(async () => {
      await mkdir(dirname(storePath), { recursive: true });
      const tmp = `${storePath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, snapshot, "utf8");
      await rename(tmp, storePath);
    });
    return writeChain;
  }

  async function requestCode(rawEmail) {
    const email = normalizeEmail(rawEmail);
    if (!email) {
      throw new AuthError("Please enter a valid email address.", 400);
    }

    const store = await loadStore();
    const now = Date.now();
    const existing = store.challenges[email];
    if (existing && now - existing.lastSentAt < RESEND_COOLDOWN_MS) {
      const retryAfterSec = Math.ceil(
        (RESEND_COOLDOWN_MS - (now - existing.lastSentAt)) / 1000
      );
      throw new AuthError(
        `Please wait ${retryAfterSec}s before requesting another code.`,
        429,
        { retryAfterSec }
      );
    }

    const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
    const salt = crypto.randomBytes(16).toString("hex");
    const codeHash = hashCode(code, salt);

    const deliveryResult = await sendEmail({
      to: email,
      code,
      expiresMinutes: Math.round(CODE_TTL_MS / 60_000),
    });

    store.challenges[email] = {
      salt,
      codeHash,
      expiresAt: now + CODE_TTL_MS,
      attempts: 0,
      lastSentAt: now,
    };
    await saveStore(store);

    return {
      ok: true,
      email,
      delivery: deliveryResult?.delivery || "smtp",
      expiresInSec: Math.round(CODE_TTL_MS / 1000),
      ...(deliveryResult?.devCode ? { devCode: deliveryResult.devCode } : {}),
    };
  }

  async function verifyCode(rawEmail, rawCode) {
    const email = normalizeEmail(rawEmail);
    if (!email) {
      throw new AuthError("Please enter a valid email address.", 400);
    }

    const code = String(rawCode || "").trim();
    if (!/^\d{6}$/.test(code)) {
      throw new AuthError("Enter the 6-digit verification code.", 400);
    }

    const store = await loadStore();
    const challenge = store.challenges[email];
    const now = Date.now();

    if (!challenge || now > challenge.expiresAt) {
      if (challenge) {
        delete store.challenges[email];
        await saveStore(store);
      }
      throw new AuthError("Verification code expired or not found. Request a new code.", 400);
    }

    if (challenge.attempts >= MAX_CODE_ATTEMPTS) {
      delete store.challenges[email];
      await saveStore(store);
      throw new AuthError("Too many incorrect attempts. Please request a new code.", 429);
    }

    const candidateHash = hashCode(code, challenge.salt);
    const match = crypto.timingSafeEqual(
      Buffer.from(candidateHash, "hex"),
      Buffer.from(challenge.codeHash, "hex")
    );

    if (!match) {
      challenge.attempts += 1;
      const remaining = Math.max(0, MAX_CODE_ATTEMPTS - challenge.attempts);
      if (remaining === 0) {
        delete store.challenges[email];
      }
      await saveStore(store);
      throw new AuthError(
        remaining > 0
          ? `Incorrect code (${remaining} attempt${remaining === 1 ? "" : "s"} left).`
          : "Too many incorrect attempts. Please request a new code.",
        remaining > 0 ? 400 : 429
      );
    }

    delete store.challenges[email];

    let user = Object.values(store.users).find((u) => u.email === email);
    if (!user) {
      const id = crypto.randomUUID();
      const defaultName = email.split("@")[0].slice(0, 32) || "User";
      user = {
        id,
        email,
        displayName: defaultName,
        createdAt: new Date(now).toISOString(),
        preferences: defaultPreferences(),
      };
      store.users[id] = user;
    }

    const token = crypto.randomBytes(32).toString("hex");
    store.sessions[hashToken(token)] = {
      userId: user.id,
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
    };

    await saveStore(store);
    return { token, user: sanitizeUser(user) };
  }

  async function getUserByToken(token) {
    if (!token || typeof token !== "string") return null;
    const store = await loadStore();
    const sess = store.sessions[hashToken(token)];
    if (!sess) return null;
    if (Date.now() > sess.expiresAt) {
      delete store.sessions[hashToken(token)];
      await saveStore(store);
      return null;
    }
    return sanitizeUser(store.users[sess.userId] || null);
  }

  async function logout(token) {
    if (!token || typeof token !== "string") return;
    const store = await loadStore();
    const key = hashToken(token);
    if (store.sessions[key]) {
      delete store.sessions[key];
      await saveStore(store);
    }
  }

  async function updateProfile(token, patch = {}) {
    if (!token || typeof token !== "string") {
      throw new AuthError("Authentication required.", 401);
    }
    const store = await loadStore();
    const sess = store.sessions[hashToken(token)];
    if (!sess || Date.now() > sess.expiresAt) {
      throw new AuthError("Session expired. Please sign in again.", 401);
    }
    const user = store.users[sess.userId];
    if (!user) {
      throw new AuthError("Account not found.", 404);
    }

    if (typeof patch.displayName === "string") {
      const cleaned = patch.displayName.trim().slice(0, 40);
      if (cleaned) user.displayName = cleaned;
    }

    if ("avatarUrl" in patch) {
      const validated = validateAvatarUrl(patch.avatarUrl);
      if (validated !== undefined) {
        user.avatarUrl = validated;
      }
    }

    user.preferences = user.preferences || defaultPreferences();
    const prefs = patch.preferences;
    if (prefs && typeof prefs === "object") {
      if (typeof prefs.searchEngine === "string" && prefs.searchEngine.length <= 24) {
        user.preferences.searchEngine = prefs.searchEngine;
      }
      if (Array.isArray(prefs.favoriteGames)) {
        user.preferences.favoriteGames = prefs.favoriteGames
          .slice(0, 500)
          .map((id) => String(id).slice(0, 80));
      }
      if (Array.isArray(prefs.savedTracks)) {
        user.preferences.savedTracks = prefs.savedTracks
          .slice(0, 200)
          .filter((t) => t && t.id && t.title)
          .map((t) => ({
            id: String(t.id).slice(0, 40),
            title: String(t.title).slice(0, 140),
            artist: String(t.artist || "Unknown Artist").slice(0, 100),
            durationMs: Number(t.durationMs || 0),
            snipped: Boolean(t.snipped),
            artwork: typeof t.artwork === "string" ? t.artwork.slice(0, 400) : "",
            protocol: String(t.protocol || "hls").slice(0, 24),
          }));
      }
    }

    await saveStore(store);
    return sanitizeUser(user);
  }

  async function deleteAccount(token) {
    if (!token || typeof token !== "string") {
      throw new AuthError("Authentication required.", 401);
    }
    const store = await loadStore();
    const key = hashToken(token);
    const sess = store.sessions[key];
    if (!sess || Date.now() > sess.expiresAt) {
      throw new AuthError("Session expired.", 401);
    }
    const userId = sess.userId;
    const user = store.users[userId];
    if (user) {
      delete store.challenges[user.email];
      delete store.users[userId];
    }
    for (const [sessKey, s] of Object.entries(store.sessions)) {
      if (s.userId === userId) delete store.sessions[sessKey];
    }
    await saveStore(store);
  }

  async function getPublicUser(userId) {
    const store = await loadStore();
    return toPublicAuthor(store.users[userId] || null);
  }

  return {
    requestCode,
    verifyCode,
    getUserByToken,
    getPublicUser,
    logout,
    updateProfile,
    deleteAccount,
  };
}

export function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader || typeof cookieHeader !== "string") return out;
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) {
      try {
        out[key] = decodeURIComponent(val);
      } catch {
        out[key] = val;
      }
    }
  }
  return out;
}

export function formatSessionCookie(token, { secure = false, maxAgeSec = 2592000 } = {}) {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSec}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}
