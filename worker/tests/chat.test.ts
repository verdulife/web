import { describe, expect, it } from "vitest";
import { ChatRunError, runChat } from "../src/chat";
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

class ThrowingAIProvider implements AIProvider {
  constructor(private readonly error: Error) {}

  async generate(): Promise<AiResponse> {
    throw this.error;
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

    // Cloudflare documented shape: assistant tool-call verbatim, then tool result.
    const secondTurn = provider.calls[1].messages;
    expect(secondTurn[1]).toEqual({
      role: "assistant",
      content: JSON.stringify({ name: "get_knowledge_document", arguments: { document_id: "about" } }),
    });
    expect(secondTurn[2]?.role).toBe("tool");
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

  it("throws ai_unavailable when the loop exhausts max turns without text", async () => {
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
    expect(provider.calls).toHaveLength(2);
  });

  it("throws ai_unavailable when the provider returns neither text nor tool calls", async () => {
    const provider = new FakeAIProvider([{ text: null, toolCalls: null }]);

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
    expect(provider.calls).toHaveLength(1);
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