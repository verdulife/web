import { describe, expect, it } from "vitest";
import { ChatRunError, runChat } from "../src/chat";
import { CloudflareAIProvider, MAX_OUTPUT_CHARS } from "../src/ai";
import type { AIProvider, AiRequest, AiResponse } from "../src/ai";
import { SnapshotKnowledgeProvider } from "../src/knowledge";
import type { KnowledgeProvider } from "../src/knowledge";
import { limitsFromEnv } from "../src/limits";
import type { ChatMessage } from "../src/types";

const SYSTEM = "system prompt de prueba";

const userMessage = (content: string): ChatMessage => ({ role: "user", content });

const toolCall = (documentId: unknown) => ({
  name: "get_knowledge_document",
  arguments: { document_id: documentId },
});

class FakeAIProvider implements AIProvider {
  readonly calls: AiRequest[] = [];
  private lastResponse: AiResponse | undefined;

  constructor(
    private readonly responses: AiResponse[],
    private readonly repeatLast = false,
  ) {}

  async generate(request: AiRequest): Promise<AiResponse> {
    this.calls.push(request);
    const response = this.responses.shift() ?? (this.repeatLast ? this.lastResponse : undefined);
    if (response === undefined) throw new Error("FakeAIProvider: no hay respuestas encoladas");
    this.lastResponse = response;
    return response;
  }
}

/**
 * Emits provider-shaped (not yet normalized) tool arguments on the first turn.
 * Cloudflare models may serialize `arguments` as a JSON string, an array of
 * [key, value] pairs, or an object; the loop must cope with all of them.
 */
class RawArgumentsAIProvider implements AIProvider {
  readonly calls: AiRequest[] = [];

  constructor(private readonly raw: unknown) {}

  async generate(request: AiRequest): Promise<AiResponse> {
    this.calls.push(request);
    if (this.calls.length === 1) {
      return {
        text: null,
        toolCalls: [{ name: "get_knowledge_document", arguments: this.raw }],
      } as unknown as AiResponse;
    }
    return { text: "Respuesta final", toolCalls: null };
  }
}

class ThrowingAIProvider implements AIProvider {
  constructor(private readonly error: Error) {}

  async generate(): Promise<AiResponse> {
    throw this.error;
  }
}

/** Scripted Workers AI binding: returns raw provider payloads in order. */
class ScriptedBinding {
  readonly calls: Record<string, unknown>[] = [];

  constructor(private readonly results: unknown[]) {}

  async run(_model: string, options: Record<string, unknown>): Promise<unknown> {
    this.calls.push(options);
    const result = this.results.shift();
    if (result === undefined) throw new Error("ScriptedBinding: no hay resultados encolados");
    return result;
  }
}

function trackedKnowledge(inner: KnowledgeProvider): {
  provider: KnowledgeProvider;
  getDocumentCalls: string[];
} {
  const getDocumentCalls: string[] = [];
  return {
    getDocumentCalls,
    provider: {
      async getDocument(id: string) {
        getDocumentCalls.push(id);
        return inner.getDocument(id);
      },
      index: () => inner.index(),
    },
  };
}

async function expectChatRunError(
  code: "ai_unavailable" | "ai_error",
  promise: Promise<unknown>,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ChatRunError);
    expect((error as ChatRunError).code).toBe(code);
    return;
  }
  throw new Error(`Se esperaba ChatRunError(${code}) pero la llamada resolvió`);
}

function toolPayload(raw: string | null | undefined): Record<string, unknown> {
  return JSON.parse(String(raw)) as Record<string, unknown>;
}

describe("runChat", () => {
  it("executes a tool call and returns the final text with the fetched sources", async () => {
    const provider = new FakeAIProvider([
      { text: null, toolCalls: [toolCall("about")] },
      { text: "Respuesta final", toolCalls: null },
    ]);
    const tracked = trackedKnowledge(new SnapshotKnowledgeProvider(6000));
    const deps = { limits: limitsFromEnv({}) };

    const result = await runChat(deps, SYSTEM, [userMessage("Cuéntame quién eres")], provider, tracked.provider);

    expect(result.reply).toBe("Respuesta final");
    expect(result.sources).toEqual(["about"]);
    expect(provider.calls).toHaveLength(2);
    expect(tracked.getDocumentCalls).toEqual(["about"]);

    // Each generate passes the full history, the only tool and maxTokens.
    expect(provider.calls[0].tools).toHaveLength(1);
    expect(provider.calls[0].tools[0].name).toBe("get_knowledge_document");
    expect(provider.calls[0].maxTokens).toBe(512);
    expect(provider.calls[0].messages[0]).toEqual({ role: "user", content: "Cuéntame quién eres" });

    // OpenAI-compatible function-calling shape that llama-family models expect:
    // one assistant message carrying tool_calls (content must be a string, the
    // Workers AI schema rejects null content), then one tool result per call.
    const secondTurn = provider.calls[1].messages;
    expect(secondTurn[1]).toEqual({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_0",
          type: "function",
          function: {
            name: "get_knowledge_document",
            arguments: JSON.stringify({ document_id: "about" }),
          },
        },
      ],
    });
    expect(secondTurn[2]?.role).toBe("tool");
    expect(secondTurn[2]?.tool_call_id).toBe("call_0");
    expect(secondTurn[2]?.name).toBe("get_knowledge_document");
    const payload = toolPayload(secondTurn[2]?.content);
    expect(payload.ok).toBe(true);
    expect(payload.content).toContain("Albert Verdu");
  });

  it("returns a direct text answer with no sources and a single call", async () => {
    const provider = new FakeAIProvider([{ text: "Hola, ¿en qué te ayudo?", toolCalls: null }]);

    const result = await runChat(
      { limits: limitsFromEnv({}) },
      SYSTEM,
      [userMessage("Hola")],
      provider,
      new SnapshotKnowledgeProvider(6000),
    );

    expect(result.reply).toBe("Hola, ¿en qué te ayudo?");
    expect(result.sources).toEqual([]);
    expect(provider.calls).toHaveLength(1);
  });

  it("treats a non-string document_id as invalid without fetching", async () => {
    const provider = new FakeAIProvider([
      { text: null, toolCalls: [toolCall(42)] },
      { text: "Continúo", toolCalls: null },
    ]);
    const tracked = trackedKnowledge(new SnapshotKnowledgeProvider(6000));

    const result = await runChat(
      { limits: limitsFromEnv({}) },
      SYSTEM,
      [userMessage("Hazme una pregunta rara")],
      provider,
      tracked.provider,
    );

    expect(result.reply).toBe("Continúo");
    expect(result.sources).toEqual([]);
    expect(tracked.getDocumentCalls).toEqual([]);
    expect(provider.calls).toHaveLength(2);
    const payload = toolPayload(provider.calls[1].messages.at(-1)?.content);
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("document_id invalido");
    expect(payload.valid_ids).toEqual(expect.arrayContaining(["about"]));
  });

  it("treats an empty document_id as invalid without fetching", async () => {
    const provider = new FakeAIProvider([
      { text: null, toolCalls: [toolCall("")] },
      { text: "Continúo", toolCalls: null },
    ]);
    const tracked = trackedKnowledge(new SnapshotKnowledgeProvider(6000));

    const result = await runChat(
      { limits: limitsFromEnv({}) },
      SYSTEM,
      [userMessage("Pregunta")],
      provider,
      tracked.provider,
    );

    expect(result.reply).toBe("Continúo");
    expect(result.sources).toEqual([]);
    expect(tracked.getDocumentCalls).toEqual([]);
  });

  it("reports an unknown document id as an error result without adding sources", async () => {
    const provider = new FakeAIProvider([
      { text: null, toolCalls: [toolCall("ghost")] },
      { text: "Final", toolCalls: null },
    ]);
    const tracked = trackedKnowledge(new SnapshotKnowledgeProvider(6000));

    const result = await runChat(
      { limits: limitsFromEnv({}) },
      SYSTEM,
      [userMessage("Pregunta")],
      provider,
      tracked.provider,
    );

    expect(result.reply).toBe("Final");
    expect(result.sources).toEqual([]);
    expect(tracked.getDocumentCalls).toEqual(["ghost"]);
    const payload = toolPayload(provider.calls[1].messages.at(-1)?.content);
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("documento no encontrado");
    expect(payload.valid_ids).toEqual(expect.arrayContaining(["about", "gaplogic", "skills"]));
  });

  it("survives a knowledge fetch failure as an error result and keeps the loop going", async () => {
    const failing: KnowledgeProvider = {
      async getDocument() {
        throw new Error("fetch roto");
      },
      index: () => [],
    };
    const provider = new FakeAIProvider([
      { text: null, toolCalls: [toolCall("about")] },
      { text: "Final", toolCalls: null },
    ]);

    const result = await runChat(
      { limits: limitsFromEnv({}) },
      SYSTEM,
      [userMessage("Pregunta")],
      provider,
      failing,
    );

    expect(result.reply).toBe("Final");
    expect(result.sources).toEqual([]);
    const payload = toolPayload(provider.calls[1].messages.at(-1)?.content);
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("error al recuperar el documento");
  });

  it("throws ai_unavailable when the loop budget is exhausted and the settle call yields no text", async () => {
    // Every turn asks for a document; the settle call is the 3rd and last one
    // (maxToolCalls + 1) and still returns tool calls, so the run gives up.
    const provider = new FakeAIProvider([{ text: null, toolCalls: [toolCall("about")] }], true);

    await expectChatRunError(
      "ai_unavailable",
      runChat(
        { limits: limitsFromEnv({ MAX_TOOL_CALLS: "2" }) },
        SYSTEM,
        [userMessage("Pregunta")],
        provider,
        new SnapshotKnowledgeProvider(6000),
      ),
    );
    expect(provider.calls).toHaveLength(3);
  });

  it("settles with a final text once the tool budget is spent", async () => {
    // maxToolCalls = 2: the loop spends both turns on documents, then the settle
    // call answers from what was already retrieved.
    const provider = new FakeAIProvider([
      { text: null, toolCalls: [toolCall("about")] },
      { text: null, toolCalls: [toolCall("gaplogic")] },
      { text: "Tengo gaplogic en marcha.", toolCalls: null },
    ]);
    const tracked = trackedKnowledge(new SnapshotKnowledgeProvider(6000));

    const result = await runChat(
      { limits: limitsFromEnv({ MAX_TOOL_CALLS: "2" }) },
      SYSTEM,
      [userMessage("¿Qué proyectos tienes en marcha?")],
      provider,
      tracked.provider,
    );

    expect(result.reply).toBe("Tengo gaplogic en marcha.");
    expect(result.sources).toEqual(["about", "gaplogic"]);
    expect(tracked.getDocumentCalls).toEqual(["about", "gaplogic"]);

    // The settle call offers NO tools (cf. the Cloudflare empty-array rule) and
    // carries the closing instruction as the last user message.
    const settle = provider.calls.at(-1);
    expect(provider.calls).toHaveLength(3);
    expect(settle?.tools).toEqual([]);
    const closing = settle?.messages.at(-1);
    expect(closing?.role).toBe("user");
    expect(closing?.content).toContain("No pidas más documentos");
  });

  it("keeps the settle text and sources when the settle response also carries tool calls", async () => {
    const provider = new FakeAIProvider([
      { text: null, toolCalls: [toolCall("about")] },
      { text: "Resumen del porfolio.", toolCalls: [toolCall("alter")] },
    ]);
    const tracked = trackedKnowledge(new SnapshotKnowledgeProvider(6000));

    const result = await runChat(
      { limits: limitsFromEnv({ MAX_TOOL_CALLS: "1" }) },
      SYSTEM,
      [userMessage("¿Qué proyectos tienes en marcha?")],
      provider,
      tracked.provider,
    );

    expect(result.reply).toBe("Resumen del porfolio.");
    // Stray tool calls on the settle turn are never executed: no extra fetch.
    expect(result.sources).toEqual(["about"]);
    expect(tracked.getDocumentCalls).toEqual(["about"]);
    expect(provider.calls).toHaveLength(2);
  });

  it("throws ai_unavailable when the provider returns neither text nor tool calls", async () => {
    // One loop turn (no text, no tool calls) plus the mandatory settle call.
    const provider = new FakeAIProvider([
      { text: null, toolCalls: null },
      { text: "   ", toolCalls: null },
    ]);

    await expectChatRunError(
      "ai_unavailable",
      runChat(
        { limits: limitsFromEnv({}) },
        SYSTEM,
        [userMessage("Pregunta")],
        provider,
        new SnapshotKnowledgeProvider(6000),
      ),
    );
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls.at(-1)?.tools).toEqual([]);
  });

  it("wraps a provider failure as ChatRunError ai_error", async () => {
    const provider = new ThrowingAIProvider(new Error("modelo caído"));

    await expectChatRunError(
      "ai_error",
      runChat(
        { limits: limitsFromEnv({}) },
        SYSTEM,
        [userMessage("Pregunta")],
        provider,
        new SnapshotKnowledgeProvider(6000),
      ),
    );
  });
});

describe("runChat tool argument normalization", () => {
  const SHAPES: { label: string; raw: unknown; expectedId: string }[] = [
    { label: "a JSON string", raw: '{"document_id":"about"}', expectedId: "about" },
    { label: "an array of [key, value] pairs", raw: [["document_id", "gaplogic"]], expectedId: "gaplogic" },
    { label: "a JSON string holding an array of pairs", raw: '[["document_id","alter"]]', expectedId: "alter" },
    { label: "a plain object", raw: { document_id: "skills" }, expectedId: "skills" },
    { label: "a truncated JSON string", raw: '{"document_id": "mando"', expectedId: "mando" },
  ];

  for (const shape of SHAPES) {
    it(`normalizes arguments given as ${shape.label} and fetches the right id`, async () => {
      const provider = new RawArgumentsAIProvider(shape.raw);
      const tracked = trackedKnowledge(new SnapshotKnowledgeProvider(6000));

      const result = await runChat(
        { limits: limitsFromEnv({}) },
        SYSTEM,
        [userMessage("¿Qué proyectos hay?")],
        provider,
        tracked.provider,
      );

      expect(result.reply).toBe("Respuesta final");
      expect(result.sources).toEqual([shape.expectedId]);
      expect(tracked.getDocumentCalls).toEqual([shape.expectedId]);

      // The tool message pairs with the assistant tool_call id so llama keeps
      // the conversation valid on the following turn.
      const toolMessage = provider.calls[1].messages.at(-1);
      expect(toolMessage?.role).toBe("tool");
      expect(toolMessage?.tool_call_id).toBe("call_0");
      expect(toolMessage?.name).toBe("get_knowledge_document");
      expect(toolPayload(toolMessage?.content).id).toBe(shape.expectedId);
    });
  }

  it("turns unusable arguments into an error result without aborting the loop", async () => {
    const provider = new RawArgumentsAIProvider({ unexpected: true });
    const tracked = trackedKnowledge(new SnapshotKnowledgeProvider(6000));

    const result = await runChat(
      { limits: limitsFromEnv({}) },
      SYSTEM,
      [userMessage("Pregunta")],
      provider,
      tracked.provider,
    );

    expect(result.reply).toBe("Respuesta final");
    expect(result.sources).toEqual([]);
    expect(tracked.getDocumentCalls).toEqual([]);
    const payload = toolPayload(provider.calls[1].messages.at(-1)?.content);
    expect(payload.ok).toBe(false);
    expect(typeof payload.error).toBe("string");
  });

  it("turns an unparseable arguments string into an error result without aborting the loop", async () => {
    const provider = new RawArgumentsAIProvider("{{{ no json }}}");

    const result = await runChat(
      { limits: limitsFromEnv({}) },
      SYSTEM,
      [userMessage("Pregunta")],
      provider,
      new SnapshotKnowledgeProvider(6000),
    );

    expect(result.reply).toBe("Respuesta final");
    expect(result.sources).toEqual([]);
  });

  it("keeps a repeated tool call from aborting the loop when the budget allows it", async () => {
    const provider = new RawArgumentsAIProvider([["document_id", "gaplogic"]]);
    const tracked = trackedKnowledge(new SnapshotKnowledgeProvider(6000));

    const result = await runChat(
      { limits: limitsFromEnv({ MAX_TOOL_CALLS: "2" }) },
      SYSTEM,
      [userMessage("Pregunta")],
      provider,
      tracked.provider,
    );

    expect(result.reply).toBe("Respuesta final");
    expect(result.sources).toEqual(["gaplogic"]);
  });
});

describe("CloudflareAIProvider normalization", () => {
  const generateWith = (payload: unknown) =>
    new CloudflareAIProvider(new ScriptedBinding([payload]), "test-model").generate({
      system: "s",
      messages: [{ role: "user", content: "hola" }],
      tools: [],
      maxTokens: 128,
    });

  it("normalizes arguments given as a JSON string", async () => {
    const response = await generateWith({
      response: "",
      tool_calls: [{ name: "get_knowledge_document", arguments: '{"document_id":"about"}' }],
    });

    expect(response.text).toBeNull();
    expect(response.toolCalls).toEqual([
      { name: "get_knowledge_document", arguments: { document_id: "about" } },
    ]);
  });

  it("normalizes arguments given as an array of [key, value] pairs", async () => {
    const response = await generateWith({
      response: "",
      tool_calls: [{ name: "get_knowledge_document", arguments: [["document_id", "gaplogic"]] }],
    });

    expect(response.toolCalls).toEqual([
      { name: "get_knowledge_document", arguments: { document_id: "gaplogic" } },
    ]);
  });

  it("keeps arguments given as an object", async () => {
    const response = await generateWith({
      response: "",
      tool_calls: [{ name: "get_knowledge_document", arguments: { document_id: "skills" } }],
    });

    expect(response.toolCalls).toEqual([
      { name: "get_knowledge_document", arguments: { document_id: "skills" } },
    ]);
  });

  it("extracts a document_id from a malformed arguments string and never throws", async () => {
    const response = await generateWith({
      response: "",
      tool_calls: [
        { name: "get_knowledge_document", arguments: '{"document_id": "mando"' },
        { arguments: null },
        null,
      ],
    });

    expect(response.toolCalls).toEqual([
      { name: "get_knowledge_document", arguments: { document_id: "mando" } },
      { name: "", arguments: {} },
    ]);
  });

  it("never throws on unknown shapes and coerces non-string names with empty arguments", async () => {
    const response = await generateWith({
      response: "",
      tool_calls: [{ name: 123, arguments: "not json at all" }],
    });

    expect(response.toolCalls).toEqual([{ name: "123", arguments: {} }]);
  });

  it("treats an empty response string as no text and keeps tool calls", async () => {
    const response = await generateWith({
      response: "",
      tool_calls: [{ name: "get_knowledge_document", arguments: { document_id: "about" } }],
    });

    expect(response.text).toBeNull();
    expect(response.toolCalls).toHaveLength(1);
  });

  it("returns null tool calls when the provider sends none", async () => {
    const response = await generateWith({ response: "Hola", tool_calls: undefined });

    expect(response.toolCalls).toBeNull();
    expect(response.text).toBe("Hola");
  });

  it("returns null text when the provider omits the response field", async () => {
    const response = await generateWith({ tool_calls: [] });

    expect(response.text).toBeNull();
    expect(response.toolCalls).toEqual([]);
  });

  it("caps the output text at MAX_OUTPUT_CHARS", async () => {
    const response = await generateWith({ response: "x".repeat(MAX_OUTPUT_CHARS + 500) });

    expect(response.text).toHaveLength(MAX_OUTPUT_CHARS);
  });

  it("drives the loop to the final text when an empty response string comes with tool calls", async () => {
    const provider = new CloudflareAIProvider(
      new ScriptedBinding([
        {
          response: "",
          tool_calls: [{ name: "get_knowledge_document", arguments: '{"document_id":"gaplogic"}' }],
        },
        { response: "Gaplogic es un proyecto de Albert Verdu.", tool_calls: [] },
      ]),
      "test-model",
    );
    const tracked = trackedKnowledge(new SnapshotKnowledgeProvider(6000));

    const result = await runChat(
      { limits: limitsFromEnv({}) },
      SYSTEM,
      [userMessage("¿Háblame de gaplogic?")],
      provider,
      tracked.provider,
    );

    expect(result.reply).toContain("Gaplogic");
    expect(result.sources).toEqual(["gaplogic"]);
    expect(tracked.getDocumentCalls).toEqual(["gaplogic"]);
  });
});
