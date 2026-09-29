/**
 * Groq HTTP adapter (OpenAI-compatible API). Groq's free tier
 * (llama-3.3-70b-versatile) is another chat provider in the cost ladder: it
 * sits behind the same {@link AIProvider} boundary, so the existing
 * availability fallback works unchanged — 429/5xx/timeouts become
 * `ChatRunError("ai_unavailable")` and resolve the turn in guide mode.
 *
 * The adapter speaks OpenAI's chat/completions wire format: the request body
 * mirrors {@link AiRequest} (system message first, OpenAI tool-call message
 * shapes, `max_tokens`, `stream: false`) and the response normalizes
 * `choices[0].message` into the {@link AiResponse} contract. Normalization is
 * deliberately defensive like the rest of the adapters: no field may throw on
 * a weird payload, `tools` is omitted entirely when the request offers none
 * (Groq rejects an empty array the way Workers AI does), there is no
 * reasoning/thinking field (llama family), and response text is capped at
 * MAX_OUTPUT_CHARS.
 *
 * Failures never retry internally: one HTTP call per `generate`. A non-2xx
 * status throws with the status line embedded so `classifyProviderError`
 * routes 429/5xx/quota/timeout to availability; network/timeout errors
 * propagate as-is.
 */
import type { AIProvider, AiRequest, AiResponse } from "./ai";
import { MAX_OUTPUT_CHARS, normalizeToolArguments } from "./ai";

const GROQ_API_BASE_URL = "https://api.groq.com/openai/v1";
const GROQ_CHAT_COMPLETIONS_PATH = "/chat/completions";

/** Bounded snippet of a non-2xx body, so operator-facing errors keep context. */
const ERROR_DETAIL_MAX_CHARS = 300;

export interface GroqOpenAIProviderOptions {
  /** Injectable fetch for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Groq (OpenAI-compatible) chat adapter. Never retries internally; one HTTP
 * call per generate. Non-2xx responses throw an Error carrying the status
 * line (`HTTP <status> <statusText>`), which the existing classification in
 * chat.ts reads as an availability problem for 429/5xx/quota/timeout and
 * falls back to guide mode.
 */
export class GroqOpenAIProvider implements AIProvider {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly apiKey: string,
    private readonly modelId: string,
    options: GroqOpenAIProviderOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async generate(request: AiRequest): Promise<AiResponse> {
    const body: Record<string, unknown> = {
      model: this.modelId,
      // System first, exactly as the loop built the history: user/assistant/
      // tool messages pass through in the OpenAI-compatible shape they already
      // carry (assistant tool_calls with `content: ""`, tool messages with
      // `tool_call_id`).
      messages: [{ role: "system", content: request.system }, ...request.messages],
      max_tokens: request.maxTokens,
      stream: false,
    };
    // Groq rejects an empty `tools` array (like Workers AI), so the field is
    // omitted entirely on turns that offer no tools (settle call).
    if (request.tools.length > 0) body.tools = request.tools;

    const response = await this.fetchImpl(`${GROQ_API_BASE_URL}${GROQ_CHAT_COMPLETIONS_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(formatHttpError(response, await readErrorDetail(response)));
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      // A 2xx with an unreadable body: no usable message, degrade defensively.
      return { text: null, toolCalls: null };
    }
    return normalizeGroqResult(payload);
  }
}

/**
 * Coerces any OpenAI-compatible payload into the AiResponse contract; never
 * throws. Missing `choices`/`message` yields `{ text: null, toolCalls: null }`
 * so malformed payloads degrade instead of breaking the chat loop.
 */
export function normalizeGroqResult(raw: unknown): AiResponse {
  if (!isPlainRecord(raw)) return { text: null, toolCalls: null };
  const choices = raw.choices;
  if (!Array.isArray(choices)) return { text: null, toolCalls: null };
  const firstChoice = choices.find((entry): entry is Record<string, unknown> => isPlainRecord(entry));
  const message: unknown = firstChoice?.message;
  if (!isPlainRecord(message)) return { text: null, toolCalls: null };
  return {
    text: normalizeGroqText(message.content),
    toolCalls: normalizeGroqToolCalls(message.tool_calls),
  };
}

/**
 * Response text rules mirror the Workers AI adapter: only strings count, an
 * empty (or whitespace-only) string is no text (finish_reason `tool_calls`
 * leaves `content` null/empty), and the result is capped at MAX_OUTPUT_CHARS.
 */
function normalizeGroqText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (text === "") return null;
  return raw.slice(0, MAX_OUTPUT_CHARS);
}

/**
 * Normalizes OpenAI-style `message.tool_calls` entries — each one is
 * `{ id, type, function: { name, arguments } }` — into the AiResponse tool
 * shape using the repo-wide defensive argument parsing. Defensive: a
 * non-record entry is dropped, and a malformed arguments string never throws
 * (it degrades to {} or a recovered document_id).
 */
function normalizeGroqToolCalls(raw: unknown): AiResponse["toolCalls"] {
  if (!Array.isArray(raw)) return null;
  return raw
    .filter((entry): entry is Record<string, unknown> => isPlainRecord(entry))
    .map((entry) => {
      // Prefer the OpenAI `.function` wrapper; fall back to the entry itself
      // for providers that mimic the Workers AI flat shape.
      const source = isPlainRecord(entry.function) ? entry.function : entry;
      return {
        name: String(source.name ?? ""),
        arguments: normalizeToolArguments(source.arguments),
      };
    });
}

/**
 * Bounded best-effort extraction of a non-2xx body (Groq surfaces quota and
 * rate-limit details there). Never throws so the availability classification
 * stays honest even when the body is unreadable.
 */
async function readErrorDetail(response: Response): Promise<string> {
  try {
    const detail = (await response.text()).replace(/\s+/g, " ").trim();
    return detail.slice(0, ERROR_DETAIL_MAX_CHARS);
  } catch {
    return "";
  }
}

/**
 * `HTTP <status> <statusText>` with an optional body snippet; the status line
 * is exactly what `classifyProviderError` matches (429, 5xx, quota words).
 */
function formatHttpError(response: Response, detail: string): string {
  const statusLine = `HTTP ${response.status} ${response.statusText}`.trim();
  return detail === "" ? statusLine : `${statusLine}: ${detail}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}