import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiRequest, AiTool } from "../src/ai";
import { MAX_OUTPUT_CHARS } from "../src/ai";
import { CloudflareAIProvider, MockAIProvider } from "../src/ai";
import { classifyProviderError } from "../src/chat";
import { GuideAIProvider } from "../src/guide";
import { GroqOpenAIProvider, normalizeGroqResult } from "../src/groq";
import { selectProvider } from "../src/index";
import type { Env } from "../src/types";

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

const TOOL: AiTool = {
  name: "get_knowledge_document",
  description: "Recupera un documento del conocimiento.",
  parameters: { type: "object", properties: {}, required: [] },
};

const REQUEST: AiRequest = {
  system: "Eres el asistente del porfolio.",
  messages: [{ role: "user", content: "¿Quién eres?" }],
  tools: [],
  maxTokens: 512,
};

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    AI: undefined,
    MODEL_ID: "default-model",
    GITHUB_REPO: "",
    GITHUB_REF: "main",
    GITHUB_TOKEN: "",
    ALLOWED_ORIGINS: "http://localhost:4321",
    RATE_LIMIT_PER_MINUTE: "30",
    MAX_MESSAGES: "8",
    MAX_INPUT_CHARS: "2000",
    MAX_OUTPUT_TOKENS: "512",
    MAX_TOOL_CALLS: "3",
    DOC_MAX_CHARS: "6000",
    ...overrides,
  };
}

interface StubResponse {
  status: number;
  statusText?: string;
  body: unknown;
}

interface CapturedRequest {
  url: string;
  method: string | undefined;
  authorization: string | null;
  body: Record<string, unknown>;
}

/**
 * A fake fetch following the link-meta.test.ts convention: the responder
 * supplies the status/body of each call, and the stub captures the last
 * request for payload assertions.
 */
function fetchStubFor(
  responder: () => StubResponse,
): { stub: ReturnType<typeof vi.fn>; captured: () => CapturedRequest } {
  let last: CapturedRequest | undefined;
  const stub = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    last = {
      url: String(_input),
      method: init?.method,
      authorization: headers.Authorization ?? null,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    };
    const response = responder();
    return new Response(
      typeof response.body === "string" ? response.body : JSON.stringify(response.body),
      { status: response.status, statusText: response.statusText },
    );
  });
  return {
    stub,
    captured: () => {
      if (last === undefined) throw new Error("fetch never called");
      return last;
    },
  };
}

function groqPayload(content: string | null, toolCalls?: unknown): Record<string, unknown> {
  return { choices: [{ message: { role: "assistant", content, tool_calls: toolCalls } }] };
}

function capturedError(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (reason: unknown) => reason,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("GroqOpenAIProvider.generate", () => {
  it("posts an OpenAI-compatible request and returns the text content (no tools key when none offered)", async () => {
    const { stub, captured } = fetchStubFor(() => ({
      status: 200,
      body: groqPayload("Soy Albert Verdu."),
    }));
    const provider = new GroqOpenAIProvider("groq-test-key", "groq-model", { fetchImpl: stub });

    const result = await provider.generate(REQUEST);

    expect(result).toEqual({ text: "Soy Albert Verdu.", toolCalls: null });
    const request = captured();
    expect(request.url).toBe(GROQ_ENDPOINT);
    expect(request.method).toBe("POST");
    expect(request.authorization).toBe("Bearer groq-test-key");
    expect(request.body.model).toBe("groq-model");
    expect(request.body.stream).toBe(false);
    expect(request.body.max_tokens).toBe(512);
    expect("tools" in request.body).toBe(false);
    expect(request.body.messages).toEqual([
      { role: "system", content: REQUEST.system },
      { role: "user", content: "¿Quién eres?" },
    ]);
  });

  it("puts the system message first and passes the tool-call history through as-is", async () => {
    const { stub, captured } = fetchStubFor(() => ({ status: 200, body: groqPayload("ok") }));
    const messages: AiRequest["messages"] = [
      { role: "user", content: "busca" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_0",
            type: "function",
            function: { name: "get_knowledge_document", arguments: '{"document_id":"about"}' },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_0",
        name: "get_knowledge_document",
        content: '{"ok":true}',
      },
    ];
    const provider = new GroqOpenAIProvider("k", "m", { fetchImpl: stub });

    await provider.generate({ ...REQUEST, messages });

    const sentMessages = captured().body.messages as Array<{ role: string }>;
    const roles = sentMessages.map((message) => message.role);
    expect(roles).toEqual(["system", "user", "assistant", "tool"]);
    expect(sentMessages[0]).toEqual({ role: "system", content: REQUEST.system });
  });

  it("includes tools in the body when the request offers them", async () => {
    const { stub, captured } = fetchStubFor(() => ({ status: 200, body: groqPayload("ok") }));
    const provider = new GroqOpenAIProvider("k", "m", { fetchImpl: stub });

    await provider.generate({ ...REQUEST, tools: [TOOL] });

    expect(captured().body.tools).toEqual([TOOL]);
  });

  it("normalizes an OpenAI-style tool_calls response into parsed arguments", async () => {
    const { stub } = fetchStubFor(() => ({
      status: 200,
      body: groqPayload(null, [
        {
          id: "call_0",
          type: "function",
          function: {
            name: "get_knowledge_document",
            arguments: '{"document_id": "about"}',
          },
        },
      ]),
    }));
    const provider = new GroqOpenAIProvider("k", "m", { fetchImpl: stub });

    const result = await provider.generate(REQUEST);

    expect(result.text).toBeNull();
    expect(result.toolCalls).toEqual([
      { name: "get_knowledge_document", arguments: { document_id: "about" } },
    ]);
  });

  it("does not throw on a malformed arguments string (degraded to {})", async () => {
    const { stub } = fetchStubFor(() => ({
      status: 200,
      body: groqPayload(null, [
        { id: "call_0", type: "function", function: { name: "tool", arguments: "{not json" } },
      ]),
    }));
    const provider = new GroqOpenAIProvider("k", "m", { fetchImpl: stub });

    const result = await provider.generate(REQUEST);

    expect(result.toolCalls).toEqual([{ name: "tool", arguments: {} }]);
  });

  it("recovers a document_id from a malformed arguments string", async () => {
    const { stub } = fetchStubFor(() => ({
      status: 200,
      body: groqPayload(null, [
        {
          id: "call_0",
          type: "function",
          function: { name: "tool", arguments: 'oops "document_id": "about" trailing' },
        },
      ]),
    }));
    const provider = new GroqOpenAIProvider("k", "m", { fetchImpl: stub });

    const result = await provider.generate(REQUEST);

    expect(result.toolCalls).toEqual([{ name: "tool", arguments: { document_id: "about" } }]);
  });

  it("returns text null when the payload has no choices", async () => {
    const { stub } = fetchStubFor(() => ({ status: 200, body: { error: "odd" } }));
    const provider = new GroqOpenAIProvider("k", "m", { fetchImpl: stub });

    await expect(provider.generate(REQUEST)).resolves.toEqual({ text: null, toolCalls: null });
  });

  it("returns text null when the choice has no message", async () => {
    const { stub } = fetchStubFor(() => ({
      status: 200,
      body: { choices: [{ finish_reason: "stop" }] },
    }));
    const provider = new GroqOpenAIProvider("k", "m", { fetchImpl: stub });

    await expect(provider.generate(REQUEST)).resolves.toEqual({ text: null, toolCalls: null });
  });

  it("treats an empty-string content as no text (tool_calls turn)", async () => {
    const { stub } = fetchStubFor(() => ({ status: 200, body: groqPayload("") }));
    const provider = new GroqOpenAIProvider("k", "m", { fetchImpl: stub });

    const result = await provider.generate(REQUEST);

    expect(result.text).toBeNull();
  });

  it("caps very long text at MAX_OUTPUT_CHARS", async () => {
    const { stub } = fetchStubFor(() => ({
      status: 200,
      body: groqPayload("x".repeat(MAX_OUTPUT_CHARS + 500)),
    }));
    const provider = new GroqOpenAIProvider("k", "m", { fetchImpl: stub });

    const result = await provider.generate(REQUEST);

    expect(result.text?.length).toBe(MAX_OUTPUT_CHARS);
  });

  it("never throws on a 2xx with a non-JSON body", async () => {
    const { stub } = fetchStubFor(() => ({ status: 200, body: "<html>not json</html>" }));
    const provider = new GroqOpenAIProvider("k", "m", { fetchImpl: stub });

    await expect(provider.generate(REQUEST)).resolves.toEqual({ text: null, toolCalls: null });
  });

  it("never throws on a non-record normalizeGroqResult payload", () => {
    expect(normalizeGroqResult("not a payload")).toEqual({ text: null, toolCalls: null });
  });
});

describe("GroqOpenAIProvider failure mapping", () => {
  it("throws with the status line on 429 so classifyProviderError routes to ai_unavailable", async () => {
    const { stub } = fetchStubFor(() => ({
      status: 429,
      statusText: "Too Many Requests",
      body: { error: { message: "rate limited" } },
    }));
    const provider = new GroqOpenAIProvider("k", "m", { fetchImpl: stub });

    await expect(provider.generate(REQUEST)).rejects.toThrow(/^HTTP 429 Too Many Requests/);
    const error = await capturedError(provider.generate(REQUEST));
    expect(classifyProviderError(error)).toBe("ai_unavailable");
  });

  it("throws with the status line on 5xx so classifyProviderError routes to ai_unavailable", async () => {
    const { stub } = fetchStubFor(() => ({
      status: 503,
      statusText: "Service Unavailable",
      body: "Backend is overloaded",
    }));
    const provider = new GroqOpenAIProvider("k", "m", { fetchImpl: stub });

    await expect(provider.generate(REQUEST)).rejects.toThrow(/^HTTP 503 Service Unavailable/);
    const error = await capturedError(provider.generate(REQUEST));
    expect(classifyProviderError(error)).toBe("ai_unavailable");
  });

  it("propagates network/timeout errors as-is", async () => {
    const { stub } = fetchStubFor(() => {
      throw new Error("fetch failed: connection refused");
    });
    const provider = new GroqOpenAIProvider("k", "m", { fetchImpl: stub });

    const error = await capturedError(provider.generate(REQUEST));

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("fetch failed: connection refused");
    expect(classifyProviderError(error)).toBe("ai_unavailable");
  });
});

describe("selectProvider", () => {
  it("selects MockAIProvider for AI_PROVIDER=mock", () => {
    expect(selectProvider(makeEnv({ AI_PROVIDER: "mock" }))).toBeInstanceOf(MockAIProvider);
  });

  it("selects GuideAIProvider for AI_PROVIDER=guide", () => {
    expect(selectProvider(makeEnv({ AI_PROVIDER: "guide" }))).toBeInstanceOf(GuideAIProvider);
  });

  it("selects GroqOpenAIProvider for AI_PROVIDER=groq and uses GROQ_MODEL_ID", async () => {
    const { stub, captured } = fetchStubFor(() => ({ status: 200, body: groqPayload("ok") }));
    vi.stubGlobal("fetch", stub);
    const env = makeEnv({
      AI_PROVIDER: "groq",
      GROQ_API_KEY: "env-groq-key",
      GROQ_MODEL_ID: "llama-3.3-70b-versatile",
    });

    const provider = selectProvider(env);

    expect(provider).toBeInstanceOf(GroqOpenAIProvider);
    await expect(provider.generate(REQUEST)).resolves.toEqual({ text: "ok", toolCalls: null });
    const request = captured();
    expect(request.body.model).toBe("llama-3.3-70b-versatile");
    expect(request.authorization).toBe("Bearer env-groq-key");
  });

  it("falls back to MODEL_ID when GROQ_MODEL_ID is absent", async () => {
    const { stub, captured } = fetchStubFor(() => ({ status: 200, body: groqPayload("ok") }));
    vi.stubGlobal("fetch", stub);

    const provider = selectProvider(makeEnv({ AI_PROVIDER: "groq", GROQ_API_KEY: "env-groq-key" }));

    await provider.generate(REQUEST);
    expect(captured().body.model).toBe("default-model");
  });

  it("keeps CloudflareAIProvider as the default selection", () => {
    expect(selectProvider(makeEnv())).toBeInstanceOf(CloudflareAIProvider);
  });

  it("keeps CloudflareAIProvider for an unknown AI_PROVIDER value", () => {
    expect(selectProvider(makeEnv({ AI_PROVIDER: "openai" }))).toBeInstanceOf(
      CloudflareAIProvider,
    );
  });
});