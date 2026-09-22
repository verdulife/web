/**
 * AI provider boundary. The worker talks to the model through this narrow
 * interface: production uses Cloudflare Workers AI, tests plug in fakes.
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

export interface AiRequest {
  system: string;
  messages: {
    role: "user" | "assistant" | "tool";
    content: string | null;
    name?: string;
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

interface CloudflareToolCall {
  name?: unknown;
  arguments?: unknown;
}

interface CloudflareRunResult {
  response?: unknown;
  tool_calls?: CloudflareToolCall[] | null;
}

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
    const result = (await binding.run(this.modelId, {
      messages: [{ role: "system", content: request.system }, ...request.messages],
      tools: request.tools,
      max_tokens: request.maxTokens,
      stream: false,
    })) as CloudflareRunResult;

    const text =
      typeof result?.response === "string" ? result.response.slice(0, MAX_OUTPUT_CHARS) : null;

    const toolCalls = Array.isArray(result?.tool_calls)
      ? result.tool_calls
          .filter((call) => call !== null && typeof call === "object")
          .map((call) => ({
            name: typeof call.name === "string" ? call.name : "",
            arguments: parseToolArguments(call.arguments),
          }))
      : null;

    return { text, toolCalls };
  }
}

/** CF providers may serialize arguments as a JSON string or as an object. */
function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      return isPlainRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isPlainRecord(raw) ? raw : {};
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}