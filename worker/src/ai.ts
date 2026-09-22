/**
 * AI provider boundary. The worker talks to the model through this narrow
 * interface: production uses Cloudflare Workers AI, tests plug in fakes.
 *
 * Normalization is deliberately defensive: llama-family models on Workers AI
 * serialize tool arguments in several shapes (JSON string, array of [key,value]
 * pairs, object) and can mix an empty `response` string with `tool_calls`. The
 * adapter must never throw on a weird provider payload.
 */

export interface AiTool {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** One assistant tool call in the OpenAI-compatible message shape. */
export interface AiToolCallMessage {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface AiRequest {
  system: string;
  messages: {
    role: "user" | "assistant" | "tool";
    content: string | null;
    name?: string;
    /** Present on assistant messages that request tools. */
    tool_calls?: AiToolCallMessage[];
    /** Present on tool messages, pairing them with the assistant call id. */
    tool_call_id?: string;
  }[];
  tools: AiTool[];
  maxTokens: number;
}

export interface AiResponse {
  text: string | null;
  toolCalls: { name: string; arguments: Record<string, unknown> }[] | null;
}

export interface AIProvider {
  generate(request: AiRequest): Promise<AiResponse>;
}

/** Hard cap on assistant output characters (sanitization, provider-agnostic). */
export const MAX_OUTPUT_CHARS = 4000;

/** Matches a document_id embedded in a malformed (non-JSON) arguments string. */
const DOCUMENT_ID_PATTERN = /"document_id"\s*:\s*"([^"]+)"/;

interface CloudflareAIRun {
  run(model: string, options: Record<string, unknown>): Promise<unknown>;
}

/**
 * Cloudflare Workers AI binding adapter. Invokes ai.run(modelId, ...) with the
 * traditional function-calling shape: system message first, tools, max_tokens,
 * stream off. Normalizes the provider result into the AiResponse contract.
 */
export class CloudflareAIProvider implements AIProvider {
  constructor(
    private readonly ai: unknown,
    private readonly modelId: string,
  ) {}

  async generate(request: AiRequest): Promise<AiResponse> {
    const binding = this.ai as CloudflareAIRun;
    // CF rejects an empty `tools` array ("tools must not be an empty array");
    // on the final unwind turn the field is omitted entirely instead.
    const options: Record<string, unknown> = {
      messages: [{ role: "system", content: request.system }, ...request.messages],
      max_tokens: request.maxTokens,
      stream: false,
    };
    if (request.tools.length > 0) options.tools = request.tools;
    const result = (await binding.run(this.modelId, options)) as unknown;

    return normalizeAiResult(result);
  }
}

/** Coerces any provider payload into the AiResponse contract; never throws. */
export function normalizeAiResult(result: unknown): AiResponse {
  if (typeof result === "string") {
    return { text: normalizeResponseText(result), toolCalls: null };
  }
  const raw = isPlainRecord(result) ? result : {};
  return {
    text: normalizeResponseText(raw.response),
    toolCalls: normalizeToolCalls(raw.tool_calls),
  };
}

/**
 * Response text rules: only strings count, an empty (or whitespace-only) string
 * is treated as no text so the tool-call branch can drive the loop, and the
 * result is capped at MAX_OUTPUT_CHARS.
 */
function normalizeResponseText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (text === "") return null;
  return raw.slice(0, MAX_OUTPUT_CHARS);
}

/** Normalizes `tool_calls`: an array yields entries, anything else yields null. */
export function normalizeToolCalls(
  raw: unknown,
): { name: string; arguments: Record<string, unknown> }[] | null {
  if (!Array.isArray(raw)) return null;
  return raw
    .filter((entry) => isPlainRecord(entry))
    .map((entry) => {
      const call = entry as { name?: unknown; arguments?: unknown };
      return {
        name: String(call.name ?? ""),
        arguments: normalizeToolArguments(call.arguments),
      };
    });
}

/**
 * Normalizes tool arguments into a plain record without ever throwing.
 *
 * Accepted shapes:
 * - JSON string -> parsed; on parse failure a document_id is recovered by regex.
 * - array of [key, value] pairs (llama quirk) -> Object.fromEntries.
 * - plain object -> used as-is.
 * - null/undefined/anything else -> {}.
 */
export function normalizeToolArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    const source = raw.trim();
    if (source === "") return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch {
      return recoverDocumentId(source);
    }
    // A JSON-encoded string is re-parsed once (double-encoded payloads).
    if (typeof parsed === "string") return normalizeToolArguments(parsed);
    const normalized = normalizeToolArguments(parsed);
    return normalized.document_id === undefined ? recoverDocumentId(source) : normalized;
  }

  if (Array.isArray(raw)) {
    const pairs = raw.filter((entry) => Array.isArray(entry));
    if (pairs.length > 0) {
      try {
        return Object.fromEntries(
          pairs.map((entry) => [String((entry as unknown[])[0] ?? ""), (entry as unknown[])[1]]),
        );
      } catch {
        return {};
      }
    }
    // Flat [key, value] pair seen in the wild.
    if (raw.length === 2 && typeof raw[0] === "string" && typeof raw[1] === "string") {
      return { [raw[0]]: raw[1] };
    }
    return {};
  }

  return isPlainRecord(raw) ? raw : {};
}

/** Last-resort extraction of a document_id from a non-JSON arguments string. */
function recoverDocumentId(source: string): Record<string, unknown> {
  const match = DOCUMENT_ID_PATTERN.exec(source);
  return match ? { document_id: match[1] } : {};
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
