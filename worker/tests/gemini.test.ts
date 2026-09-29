import { describe, expect, it, vi } from "vitest";
import { MAX_OUTPUT_CHARS } from "../src/ai";
import type { AiRequest, AiTool } from "../src/ai";
import { ChatRunError } from "../src/chat";
import { GeminiOpenAIProvider } from "../src/gemini";

/**
 * GeminiOpenAIProvider contract: the adapter speaks OpenAI's chat/completions
 * wire format to Gemini's OpenAI-compatible endpoint, with two boundary rules:
 * empty tools are omitted entirely (OpenAI rejects empty arrays), and
 * assistant tool-call messages go out with `content: null` (the loop's
 * internal `""` is OpenAI-invalid there). Success bodies run through the
 * shared ai.ts normalizers, so provider quirks stay defensive and the adapter
 * never throws on a weird payload.
 */

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

type FetchMock = ReturnType<typeof vi.fn>;

/** A fake global fetch that returns queued responses or rejects. */
function makeFetch(queue: Array<Response | Error> = []): FetchMock {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    const next = queue.shift();
    if (next === undefined) throw new Error("Unexpected fetch call");
    if (next instanceof Error) throw next;
    return next;
  });
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const sampleRequest = (overrides: Partial<AiRequest> = {}): AiRequest => ({
  system: "Eres el asistente del porfolio.",
  messages: [{ role: "user", content: "hola" }],
  tools: [],
  maxTokens: 128,
  ...overrides,
});

const KNOWLEDGE_TOOL: AiTool = {
  name: "get_knowledge_document",
  description: "Recupera un documento del conocimiento.",
  parameters: {
    type: "object",
    properties: { document_id: { type: "string" } },
    required: ["document_id"],
  },
};

/** The first fetch call, already parsed: url, init and JSON body. */
function captured(fetchImpl: FetchMock): {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
} {
  const call = fetchImpl.mock.calls[0];
  const init = call[1] ?? {};
  return { url: String(call[0]), init, body: JSON.parse(String(init.body)) as Record<string, unknown> };
}

/** Asserts the promise rejects with ChatRunError("ai_error") and returns it. */
async function expectChatRunError(
  promise: Promise<unknown>,
  message?: RegExp,
): Promise<ChatRunError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ChatRunError);
    expect((error as ChatRunError).code).toBe("ai_error");
    if (message !== undefined) expect((error as ChatRunError).message).toMatch(message);
    return error as ChatRunError;
  }
  throw new Error("Se esperaba ChatRunError(ai_error) pero la llamada resolvió");
}

describe("GeminiOpenAIProvider request payload", () => {
  it("posts the OpenAI-compatible payload to the Gemini endpoint with Bearer auth", async () => {
    const fetchImpl = makeFetch([
      jsonResponse({ choices: [{ message: { content: "Hola, ¿qué quieres saber?" } }] }),
    ]);
    const provider = new GeminiOpenAIProvider("sk-test", "gemini-2.0-flash", fetchImpl);

    const result = await provider.generate(
      sampleRequest({
        messages: [
          { role: "user", content: "hola" },
          { role: "assistant", content: "Hola" },
        ],
        tools: [KNOWLEDGE_TOOL],
      }),
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = captured(fetchImpl);
    expect(call.url).toBe(BASE_URL);
    expect(call.init.method).toBe("POST");
    expect(call.init.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer sk-test",
    });
    expect(call.body.model).toBe("gemini-2.0-flash");
    expect(call.body.stream).toBe(false);
    // Thinking budget capped by default (Gemini 3 thinking shares the output
    // budget; verified live — without it replies come back empty and tool calls
    // truncate into MALFORMED_FUNCTION_CALL).
    expect(call.body.reasoning_effort).toBe("minimal");
    expect(call.body.max_tokens).toBe(128);

    // System message first, then the history untouched.
    expect(call.body.messages).toEqual([
      { role: "system", content: "Eres el asistente del porfolio." },
      { role: "user", content: "hola" },
      { role: "assistant", content: "Hola" },
    ]);
    // Tools wrapped in the OpenAI function-calling shape.
    expect(call.body.tools).toEqual([
      {
        type: "function",
        function: {
          name: KNOWLEDGE_TOOL.name,
          description: KNOWLEDGE_TOOL.description,
          parameters: KNOWLEDGE_TOOL.parameters,
        },
      },
    ]);

    expect(result.text).toBe("Hola, ¿qué quieres saber?");
    expect(result.toolCalls).toBeNull();
  });

  it("accepts a custom reasoning_effort via the constructor", async () => {
    const fetchImpl = makeFetch([jsonResponse({ choices: [{ message: { content: "Final" } }] })]);
    const provider = new GeminiOpenAIProvider("sk-test", "gemini-2.0-flash", fetchImpl, "low");

    await provider.generate(sampleRequest());

    expect(captured(fetchImpl).body.reasoning_effort).toBe("low");
  });

  it("omits the tools field entirely when no tools are offered (settle turn)", async () => {
    const fetchImpl = makeFetch([jsonResponse({ choices: [{ message: { content: "Final" } }] })]);
    const provider = new GeminiOpenAIProvider("sk-test", "gemini-2.0-flash", fetchImpl);

    await provider.generate(sampleRequest({ tools: [] }));

    const call = captured(fetchImpl);
    expect(call.body).not.toHaveProperty("tools");
    expect(call.body.messages).toHaveLength(2);
  });

  it("sends assistant tool-call content as null but keeps plain messages untouched", async () => {
    const fetchImpl = makeFetch([jsonResponse({ choices: [{ message: { content: "Final" } }] })]);
    const provider = new GeminiOpenAIProvider("sk-test", "gemini-2.0-flash", fetchImpl);

    await provider.generate(
      sampleRequest({
        messages: [
          { role: "user", content: "Dame el documento about" },
          { role: "assistant", content: "¿Cuál quieres?" },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_0",
                type: "function",
                function: {
                  name: "get_knowledge_document",
                  arguments: '{"document_id":"about"}',
                },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_0", name: "get_knowledge_document", content: '{"ok":true}' },
        ],
      }),
    );

    const messages = captured(fetchImpl).body.messages as Record<string, unknown>[];
    // Plain assistant message: content left as-is, no null mapping.
    expect(messages[2]).toEqual({ role: "assistant", content: "¿Cuál quieres?" });
    // Assistant message carrying tool_calls: "" becomes null at the boundary.
    expect(messages[3]).toMatchObject({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_0",
          type: "function",
          function: {
            name: "get_knowledge_document",
            arguments: '{"document_id":"about"}',
          },
        },
      ],
    });
    // Tool result message: stays paired with its call id, but the Workers-AI
    // `name` field is dropped at the boundary (OpenAI tool messages carry only
    // tool_call_id + content; the Gemini compat surface rejects the extra field).
    expect(messages[4]).toEqual({
      role: "tool",
      tool_call_id: "call_0",
      content: '{"ok":true}',
    });
  });
});

describe("GeminiOpenAIProvider response normalization", () => {
  it("unwraps choices[0].message into text and parses function.arguments", async () => {
    const fetchImpl = makeFetch([
      jsonResponse({
        choices: [
          {
            message: {
              content: "Tengo la documentación.",
              tool_calls: [
                {
                  id: "call_0",
                  type: "function",
                  function: {
                    name: "get_knowledge_document",
                    arguments: '{"document_id":"about"}',
                  },
                },
              ],
            },
          },
        ],
      }),
    ]);
    const provider = new GeminiOpenAIProvider("sk-test", "gemini-2.0-flash", fetchImpl);

    const result = await provider.generate(sampleRequest());

    expect(result.text).toBe("Tengo la documentación.");
    expect(result.toolCalls).toEqual([
      { name: "get_knowledge_document", arguments: { document_id: "about" } },
    ]);
  });

  it("runs tool arguments through the shared normalizer (JSON-encoded pairs array quirk)", async () => {
    const fetchImpl = makeFetch([
      jsonResponse({
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call_0",
                  type: "function",
                  function: {
                    name: "get_knowledge_document",
                    arguments: '[["document_id","gaplogic"]]',
                  },
                },
              ],
            },
          },
        ],
      }),
    ]);
    const provider = new GeminiOpenAIProvider("sk-test", "gemini-2.0-flash", fetchImpl);

    const result = await provider.generate(sampleRequest());

    expect(result.text).toBeNull();
    expect(result.toolCalls).toEqual([
      { name: "get_knowledge_document", arguments: { document_id: "gaplogic" } },
    ]);
  });

  it("caps the response text at MAX_OUTPUT_CHARS via the shared normalizer", async () => {
    const fetchImpl = makeFetch([
      jsonResponse({ choices: [{ message: { content: "x".repeat(MAX_OUTPUT_CHARS + 100) } }] }),
    ]);
    const provider = new GeminiOpenAIProvider("sk-test", "gemini-2.0-flash", fetchImpl);

    const result = await provider.generate(sampleRequest());

    expect(result.text).toHaveLength(MAX_OUTPUT_CHARS);
  });
});

describe("GeminiOpenAIProvider error mapping", () => {
  it("maps HTTP 429 to ChatRunError ai_error with a clean derived message", async () => {
    const fetchImpl = makeFetch([new Response(null, { status: 429 })]);
    const provider = new GeminiOpenAIProvider("sk-test", "gemini-2.0-flash", fetchImpl);

    const error = await expectChatRunError(provider.generate(sampleRequest()));
    // Derived from the HTTP status text (or a status fallback), never a stack.
    expect(error.message.length).toBeGreaterThan(0);
    expect(error.message).not.toContain("\n");
  });

  it("uses the body error.message for a non-2xx response", async () => {
    const fetchImpl = makeFetch([jsonResponse({ error: { message: "API key no válida" } }, 401)]);
    const provider = new GeminiOpenAIProvider("sk-test", "gemini-2.0-flash", fetchImpl);

    await expectChatRunError(provider.generate(sampleRequest()), /API key no válida/);
  });

  it("falls back to the HTTP status text when the error body is not parseable", async () => {
    const fetchImpl = makeFetch([
      new Response("upstream blew up", { status: 500, statusText: "Internal Server Error" }),
    ]);
    const provider = new GeminiOpenAIProvider("sk-test", "gemini-2.0-flash", fetchImpl);

    await expectChatRunError(provider.generate(sampleRequest()), /Internal Server Error/);
  });

  it("wraps a network rejection as ChatRunError ai_error", async () => {
    const fetchImpl = makeFetch([new Error("fetch roto")]);
    const provider = new GeminiOpenAIProvider("sk-test", "gemini-2.0-flash", fetchImpl);

    await expectChatRunError(provider.generate(sampleRequest()), /fetch roto/);
  });
});

describe("GeminiOpenAIProvider wild payloads", () => {
  it("falls back to safe nulls for missing or odd choices and never throws", async () => {
    const fetchImpl = makeFetch([
      jsonResponse({}),
      jsonResponse({ choices: [] }),
      jsonResponse({ choices: [{ message: null }] }),
      jsonResponse({ choices: "nope" }),
      jsonResponse("just a string"),
    ]);
    const provider = new GeminiOpenAIProvider("sk-test", "gemini-2.0-flash", fetchImpl);

    for (let index = 0; index < 5; index += 1) {
      const result = await provider.generate(sampleRequest());
      expect(result.text).toBeNull();
      expect(result.toolCalls).toBeNull();
    }
  });

  it("returns safe nulls on a non-JSON success body instead of throwing", async () => {
    const fetchImpl = makeFetch([new Response("<html>proxy error</html>", { status: 200 })]);
    const provider = new GeminiOpenAIProvider("sk-test", "gemini-2.0-flash", fetchImpl);

    const result = await provider.generate(sampleRequest());

    expect(result.text).toBeNull();
    expect(result.toolCalls).toBeNull();
  });

  it("ignores malformed tool_calls entries while keeping the valid ones", async () => {
    const fetchImpl = makeFetch([
      jsonResponse({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call_0",
                  type: "function",
                  function: {
                    name: "get_knowledge_document",
                    arguments: '{"document_id":"about"}',
                  },
                },
                null,
                { function: null },
                { type: "function", function: { name: 7, arguments: null } },
              ],
            },
          },
        ],
      }),
    ]);
    const provider = new GeminiOpenAIProvider("sk-test", "gemini-2.0-flash", fetchImpl);

    const result = await provider.generate(sampleRequest());

    expect(result.text).toBeNull();
    expect(result.toolCalls).toEqual([
      { name: "get_knowledge_document", arguments: { document_id: "about" } },
      { name: "", arguments: {} },
      { name: "7", arguments: {} },
    ]);
  });
});