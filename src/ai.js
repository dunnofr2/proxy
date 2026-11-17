const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash";
const MAX_MESSAGES = 40;
const MAX_CHARS = 8000;
const RATE_LIMIT = 20; // requests per user per minute
// Without a cap OpenRouter reserves the model's maximum (131k tokens) and rejects the
// request when the account balance is lower than that reservation.
const MAX_REPLY_TOKENS = 8192;

// Models users can pick. Add entries here to extend the switcher.
export const MODELS = [{ id: DEFAULT_MODEL, label: "DeepSeek V4.1 Flash" }];

export function resolveModel(requested) {
  if (requested == null || requested === "") return process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
  const match = MODELS.find((m) => m.id === requested);
  if (!match) throw new AiError("Unknown model.");
  return match.id;
}

export class AiError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function isAiConfigured() {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

export function sanitizeMessages(input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new AiError("messages must be a non-empty array.");
  }
  return input.slice(-MAX_MESSAGES).map((m) => {
    const role = m?.role === "assistant" ? "assistant" : "user";
    const content = typeof m?.content === "string" ? m.content.trim() : "";
    if (!content) throw new AiError("Each message needs text content.");
    // Only the user's typed messages are capped at MAX_CHARS; earlier AI replies can be longer.
    const limit = role === "assistant" ? MAX_CHARS * 4 : MAX_CHARS;
    if (content.length > limit) {
      throw new AiError(`Messages are limited to ${limit} characters.`);
    }
    return { role, content };
  });
}

const hits = new Map();
export function checkRateLimit(userId, now = Date.now()) {
  const recent = (hits.get(userId) || []).filter((t) => now - t < 60_000);
  if (recent.length >= RATE_LIMIT) {
    throw new AiError("Slow down a little and try again in a minute.", 429);
  }
  recent.push(now);
  hits.set(userId, recent);
}

/**
 * Streams assistant text from OpenRouter. Yields plain text deltas.
 * The API key stays on the server; callers only see generated text.
 */
export async function* streamChat(messages, { model, signal } = {}) {
  if (!isAiConfigured()) throw new AiError("AI is not configured on this server.", 503);

  const upstream = await fetch(OPENROUTER_URL, {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "X-Title": "Simple",
    },
    body: JSON.stringify({
      model: model || process.env.OPENROUTER_MODEL || DEFAULT_MODEL,
      stream: true,
      max_tokens: MAX_REPLY_TOKENS,
      messages,
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    console.error(`[ai] OpenRouter ${upstream.status}: ${detail.slice(0, 300)}`);
    throw new AiError(`AI provider error (${upstream.status}).`, 502);
  }

  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of upstream.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue; // skips ": OPENROUTER PROCESSING" keep-alives
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") return;
      try {
        const delta = JSON.parse(data).choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        // Ignore partial or non-JSON lines
      }
    }
  }
}
