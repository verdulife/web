/**
 * Gemini provider adapter through its OpenAI-compatible REST endpoint
 * (https://ai.google.dev/gemini-api/docs/openai): POST chat/completions with
 * the OpenAI wire format, so the provider-agnostic loop needs no changes.
 *
 * Two boundary rules live here, never in the loop:
 * - OpenAI rejects an empty `tools` array, so the field is omitted entirely
 *   on the settle turn (same defensive invariant as CloudflareAIProvider).
 * - The loop records assistant tool-call turns with `content: ""` (its own
 *   schema rejects null content), while OpenAI expects `content: null` on
 *   messages that carry `tool_calls`; that mapping happens at this boundary.
 *
 * Normalization is deliberately defensive, mirroring ai.ts: a weird provider
 * payload must never throw — it falls back to safe nulls. Only network or
 * HTTP failures surface, as ChatRunError("ai_error") with a clean message.
 */
import type { AIProvider, AiRequest, AiResponse, AiTool } from "./ai";
import { normalizeResponseText, normalizeToolArguments } from "./ai";
import { ChatRunError } from "./chat";

/** OpenAI-compatible Gemini API root (v1beta OpenAI-compat surface). */
const GEMINI_OPENAI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";
const CHAT_COMPLETIONS_URL = `${GEMINI_OPENAI_BASE_URL}chat/completions`;

/**
 * Gemini through the OpenAI-compatible chat/completions surface. Uses the
 * provider's model id as-is, never streams, and normalizes every success body
 * into the internal AiResponse contract.
 *
 * `reasoningEffort` defaults to "minimal": Gemini 3 models think before
 * answering and the thinking consumes the SAME output budget as the final
 * text (verified live 2026-02: without it, short max_tokens responses come
 * back empty and function calls get truncated into MALFORMED_FUNCTION_CALL;
 * with "minimal" the budget stays capped, latency drops to ~1s and tool calls
 * come out complete).
 */
export class GeminiOpenAIProvider implements AIProvider {
  constructor(
    private readonly apiKey: string,
    private readonly modelId: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly reasoningEffort = "minimal",
  ) {}

  async generate(request: AiRequest): Promise<AiResponse> {
    let response: Response;
    try {
      response = await this.fetchImpl(CHAT_COMPLETIONS_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(this.buildPayload(request)),
      });
    } catch (error) {
      throw new ChatRunError("ai_error", toErrorMessage(error));
    }

    if (!response.ok) {
      // 429 maps to ai_error on purpose: the handler turns any AI failure into
      // the retryable 502 contract, so Gemini keeps the same path as the rest.
      throw new ChatRunError("ai_error", await errorMessageFrom(response));
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      // Non-JSON success body: safe nulls, never an error (same as normalizeAiResult).
      return { text: null, toolCalls: null };
    }
    return normalizeOpenAIResult(body);
  }

  private buildPayload(request: AiRequest): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      model: this.modelId,
      stream: false,
      reasoning_effort: this.reasoningEffort,
      max_tokens: request.maxTokens,
      // System message first, same pattern as CloudflareAIProvider.
      messages: [{ role: "system", content: request.system }, ...request.messages.map(mapMessage)],
    };
    // OpenAI rejects an empty tools array; the settle turn offers no tools and
    // the field is omitted entirely.
    if (request.tools.length > 0) {
      payload.tools = request.tools.map(mapTool);
    }
    return payload;
  }
}

/** Wraps one internal AiTool into the OpenAI function-calling wire shape. */
function mapTool(tool: AiTool): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

/**
 * Passes a history message through to the OpenAI shape, applying the single
 * boundary rule: assistant messages that carry tool_calls go out with
 * `content: null` (OpenAI rejects `""` there). Every other message, including
 * plain assistant replies with an empty string, is sent unchanged.
 */
function mapMessage(
  message: AiRequest["messages"][number],
): Record<string, unknown> {
  const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  const mapped: Record<string, unknown> = {
    role: message.role,
    content:
      message.role === "assistant" && hasToolCalls && message.content === "" ? null : message.content,
  };
  // OpenAI tool messages carry tool_call_id + content only; `name` (present in
  // the loop's history, a Workers-AI-ism) is dropped at the boundary for the
  // tool role to avoid a 400 on the Gemini compat surface.
  if (message.role !== "tool" && message.name !== undefined) mapped.name = message.name;
  if (message.tool_calls !== undefined) mapped.tool_calls = message.tool_calls;
  if (message.tool_call_id !== undefined) mapped.tool_call_id = message.tool_call_id;
  return mapped;
}

/**
 * Coerces any OpenAI chat/completions payload into the AiResponse contract.
 * Only choices[0].message is read; missing or odd shapes fall back to safe
 * nulls exactly like normalizeAiResult, never throwing.
 */
function normalizeOpenAIResult(result: unknown): AiResponse {
  const raw = isPlainRecord(result) ? result : {};
  const firstChoice = Array.isArray(raw.choices) ? raw.choices[0] : undefined;
  const message =
    isPlainRecord(firstChoice) && isPlainRecord(firstChoice.message) ? firstChoice.message : {};
  return {
    text: normalizeResponseText(message.content),
    toolCalls: normalizeGeminiToolCalls(message.tool_calls),
  };
}

/**
 * OpenAI tool_calls entries are { id, type, function: { name, arguments } };
 * the internal contract stores { name, arguments } pairs, so the wrapper is
 * unwrapped and the arguments go through the same defensive normalizer.
 */
function normalizeGeminiToolCalls(
  raw: unknown,
): { name: string; arguments: Record<string, unknown> }[] | null {
  if (!Array.isArray(raw)) return null;
  return raw
    .filter((entry) => isPlainRecord(entry))
    .map((entry) => {
      const fn = isPlainRecord(entry.function) ? entry.function : {};
      return {
        name: String(fn.name ?? ""),
        arguments: normalizeToolArguments(fn.arguments),
      };
    });
}

/** Derives the failure message from the body `error.message` when parseable. */
async function errorMessageFrom(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as unknown;
    if (isPlainRecord(body) && isPlainRecord(body.error) && typeof body.error.message === "string") {
      const message = body.error.message.trim();
      if (message !== "") return message;
    }
  } catch {
    // Fall through to the HTTP status text.
  }
  const statusText = response.statusText.trim();
  return statusText === "" ? `HTTP ${response.status}` : statusText;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
