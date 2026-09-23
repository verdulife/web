import { describe, expect, it } from "vitest";
import { MockAIProvider, mockReplyFor } from "../src/ai";
import type { AiRequest } from "../src/ai";
import workerDefault from "../src/index";
import { normalizeWidgets } from "../src/widgets";
import type { ChatResponse, Env } from "../src/types";

/**
 * Mock AI provider contract (dev-only aid, see zero-cost strategy):
 * `AI_PROVIDER === "mock"` selects MockAIProvider; replies are keyword-routed
 * template text with real widget tokens, no tool calls, so runChat returns them
 * on the first turn with an empty `sources` list.
 */

/** Mirrors handler.test.ts; the mock gate keys off AI_PROVIDER. */
function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    AI: undefined,
    MODEL_ID: "test-model",
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

function chatRequest(body: unknown): Request {
  return new Request("https://verdu.dev/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function mockRequest(lastUserContent: string): AiRequest {
  return {
    system: "Eres el asistente del porfolio.",
    messages: [{ role: "user", content: lastUserContent }],
    tools: [],
    maxTokens: 512,
  };
}

describe("mockReplyFor (pure keyword router)", () => {
  it("routes profile/foto/retrato/eres questions to the image widget reply", () => {
    const reply = mockReplyFor("¿quién eres?");
    expect(reply).toContain('[[widget:image src="/verdu.jpg" alt="Retrato de Albert Verdu"]]');
    expect(reply).toContain("/verdu.jpg");
  });

  it("routes contacto/linkedin/github questions to the link widgets reply", () => {
    const reply = mockReplyFor("¿cómo contacto?");
    expect(reply.match(/\[\[widget:link/g)).toHaveLength(2);
    expect(reply).toContain('url="https://www.linkedin.com/in/albert-verdu"');
    expect(reply).toContain('url="https://github.com/verdulife"');
  });

  it("routes proyecto/trabajos questions to the project card widgets", () => {
    const reply = mockReplyFor("muéstrame tus proyectos");
    expect(reply.match(/\[\[widget:project/g)).toHaveLength(2);
    expect(reply).toContain('slug="kncelados"');
    expect(reply).toContain('slug="botanic"');
    const normalized = normalizeWidgets(reply);
    expect(normalized.widgets.map((widget) => widget.type)).toEqual(["project", "project"]);
    expect(normalized.reply).not.toContain("[[widget:project");
  });

  it("falls back to a default reply with a bare URL for any other question", () => {
    const reply = mockReplyFor("¿qué stack usas?");
    expect(reply).toContain("https://");
    expect(reply).toContain("[[widget:link");
  });

  it("default reply auto-converts its bare URL into a link widget (normalization demo)", () => {
    const normalized = normalizeWidgets(mockReplyFor("¿qué stack usas?"));
    expect(normalized.widgets).toHaveLength(2);
    expect(normalized.widgets.map((widget) => widget.type)).toEqual(["link", "link"]);
    expect(normalized.widgets[1]?.url).toBe("https://astro.build");
    expect(normalized.reply).not.toContain("[[widget:link");
  });

  it("matches case-insensitively and accentless keyword variants", () => {
    expect(mockReplyFor("QUIEN ES EL AUTOR DE ESTA WEB")).toContain("[[widget:image");
  });
});

describe("MockAIProvider.generate", () => {
  it("returns final text with no tool calls (runChat short-circuits)", async () => {
    const provider = new MockAIProvider();
    const result = await provider.generate(mockRequest("¿cómo contacto?"));
    expect(result.text).toContain("LinkedIn");
    expect(result.toolCalls).toBeNull();
  });

  it("routes on the LAST user message, ignoring earlier turns", async () => {
    const provider = new MockAIProvider();
    const result = await provider.generate({
      system: "Eres el asistente del porfolio.",
      messages: [
        { role: "user", content: "hola" },
        { role: "assistant", content: "Hola, ¿qué quieres saber?" },
        { role: "user", content: "¿quién eres?" },
      ],
      tools: [],
      maxTokens: 512,
    });
    expect(result.text).toContain("[[widget:image");
  });

  it("falls back to the default reply when there is no user message", async () => {
    const provider = new MockAIProvider();
    const result = await provider.generate({
      system: "Eres el asistente del porfolio.",
      messages: [{ role: "assistant", content: "Hola" }],
      tools: [],
      maxTokens: 512,
    });
    expect(result.text).toContain("https://");
  });
});

describe("mock pipeline (AI_PROVIDER=mock selects MockAIProvider)", () => {
  it("answers a profile question with a normalized image widget and empty sources", async () => {
    const response = await workerDefault.fetch(
      chatRequest({ messages: [{ role: "user", content: "¿quién eres?" }] }),
      makeEnv({ AI_PROVIDER: "mock" }),
      {},
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as ChatResponse;
    expect(body.widgets).toHaveLength(1);
    expect(body.widgets?.[0]).toMatchObject({
      index: 0,
      type: "image",
      src: "/verdu.jpg",
      alt: "Retrato de Albert Verdu",
    });
    expect(body.reply).toContain("[[widget:0]]");
    expect(body.reply).not.toContain("[[widget:image");
    expect(body.reply).not.toContain("[[widget:link");
    expect(body.sources).toEqual([]);
  });

  it("answers a contact question with normalized link widgets and placeholder-only reply", async () => {
    const response = await workerDefault.fetch(
      chatRequest({ messages: [{ role: "user", content: "¿cómo contacto?" }] }),
      makeEnv({ AI_PROVIDER: "mock" }),
      {},
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as ChatResponse;
    expect(body.widgets).toHaveLength(2);
    expect(body.widgets?.[0]).toMatchObject({
      index: 0,
      type: "link",
      url: "https://www.linkedin.com/in/albert-verdu",
      label: "LinkedIn",
    });
    expect(body.widgets?.[1]).toMatchObject({
      index: 1,
      type: "link",
      url: "https://github.com/verdulife",
      label: "GitHub",
    });
    expect(body.reply).not.toContain("[[widget:link");
    expect(body.reply.match(/\[\[widget:\d+\]\]/g)).toHaveLength(2);
    expect(body.sources).toEqual([]);
  });
});