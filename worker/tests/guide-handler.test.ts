import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildHandler } from "../src/index";
import type { HandlerDeps } from "../src/index";
import { ChatRunError } from "../src/chat";
import type { AIProvider, AiRequest, AiResponse } from "../src/ai";
import { GUIDE_SUGGESTIONS, GuideAIProvider } from "../src/guide";
import { SnapshotKnowledgeProvider } from "../src/knowledge";
import { limitsFromEnv } from "../src/limits";
import { listProjectCards } from "../src/projects";
import type { RateLimit } from "../src/ratelimit";
import type { Env } from "../src/types";

/**
 * Guide-mode integration through the chat handler (worker/src/index.ts).
 *
 * Two entry points share one response path (guideResponse): the forced
 * selection (AI_PROVIDER=guide -> a GuideAIProvider injected in deps.ai) and
 * the automatic fallback when runChat surfaces ChatRunError("ai_unavailable")
 * mid-turn. Guide replies keep the `reply + widgets` contract and add
 * `mode: "guide"` + `suggestions`; the normal path (mode absent) is unchanged.
 */

const BASE_URL = "https://verdu.dev";

class FakeAIProvider implements AIProvider {
  constructor(private readonly response: AiResponse) {}

  async generate(_request: AiRequest): Promise<AiResponse> {
    return this.response;
  }
}

/**
 * Model that never produces text nor tool calls: runChat exhausts the tool
 * budget and the settle call fails, surfacing ChatRunError("ai_unavailable")
 * mid-turn — the automatic-fallback trigger.
 */
class NoOutputAIProvider implements AIProvider {
  async generate(_request: AiRequest): Promise<AiResponse> {
    return { text: null, toolCalls: null };
  }
}

function fakeRateLimiter(allowed: boolean): RateLimit {
  return { check: async () => ({ allowed, retryAfterSeconds: allowed ? 0 : 60 }) };
}

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

function makeDeps(overrides: Partial<HandlerDeps> = {}): HandlerDeps {
  return {
    rateLimiter: fakeRateLimiter(true),
    knowledge: new SnapshotKnowledgeProvider(6000),
    ai: new FakeAIProvider({ text: "Respuesta", toolCalls: null }),
    limits: limitsFromEnv({}),
    allowedOrigins: ["http://localhost:4321"],
    ...overrides,
  };
}

/** Real snapshot project index (same source the /api/projects route uses). */
function guideDeps(): HandlerDeps {
  const knowledge = new SnapshotKnowledgeProvider(6000);
  return makeDeps({
    knowledge,
    ai: new GuideAIProvider({ projects: listProjectCards(knowledge.index()) }),
  });
}

function chatRequest(body: unknown): Request {
  return new Request(`${BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function jsonBody(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildHandler POST /api/chat — forced guide mode (AI_PROVIDER=guide)", () => {
  it("answers a catalog question with mode guide, suggestions and normalized widgets", async () => {
    const handler = buildHandler(guideDeps());
    const response = await handler(
      chatRequest({ messages: [{ role: "user", content: "¿Qué proyectos tienes?" }] }),
      makeEnv(),
    );

    expect(response.status).toBe(200);
    const body = await jsonBody(response);
    expect(body.mode).toBe("guide");
    expect(body.suggestions).toEqual(GUIDE_SUGGESTIONS);
    expect(body.sources).toEqual([]);
    // normalizeWidgets rewrote the projects token into a canonical placeholder.
    expect(body.reply).toBe("Aquí tienes una selección de mis proyectos:\n\n[[widget:0]]");
    expect(body.widgets).toEqual([{ index: 0, type: "projects" }]);
  });

  it("answers a concrete project question with a project widget (data-driven route)", async () => {
    const handler = buildHandler(guideDeps());
    const response = await handler(
      chatRequest({ messages: [{ role: "user", content: "¿Me cuentas sobre el proyecto botanic?" }] }),
      makeEnv(),
    );

    expect(response.status).toBe(200);
    const body = await jsonBody(response);
    expect(body.mode).toBe("guide");
    expect(body.reply).toContain("Botanic");
    expect(body.widgets).toEqual([{ index: 0, type: "project", slug: "botanic" }]);
  });

  it("falls back honestly on an uncovered question and omits widgets", async () => {
    const handler = buildHandler(guideDeps());
    const response = await handler(
      chatRequest({ messages: [{ role: "user", content: "¿Cuánto cuesta tu casa?" }] }),
      makeEnv(),
    );

    expect(response.status).toBe(200);
    const body = await jsonBody(response);
    expect(body.mode).toBe("guide");
    expect(body.reply).toContain("no está cubierta");
    expect(body.widgets).toBeUndefined();
  });
});

describe("buildHandler POST /api/chat — automatic guide fallback", () => {
  it("resolves the whole turn in guide mode when the provider surfaces ai_unavailable", async () => {
    const handler = buildHandler(makeDeps({ ai: new NoOutputAIProvider() }));
    const response = await handler(
      chatRequest({ messages: [{ role: "user", content: "¿Qué proyectos tienes?" }] }),
      makeEnv(),
    );

    // Turn resolved in guide: no 502, guide reply with mode + suggestions.
    expect(response.status).toBe(200);
    const body = await jsonBody(response);
    expect(body.mode).toBe("guide");
    expect(body.suggestions).toEqual(GUIDE_SUGGESTIONS);
    expect(body.sources).toEqual([]);
    expect(body.reply).toBe("Aquí tienes una selección de mis proyectos:\n\n[[widget:0]]");
    expect(body.widgets).toEqual([{ index: 0, type: "projects" }]);
  });

  it("routes the fallback on the actual last user message (multi-turn)", async () => {
    const handler = buildHandler(makeDeps({ ai: new NoOutputAIProvider() }));
    const response = await handler(
      chatRequest({
        messages: [
          { role: "user", content: "Hola, buenas" },
          { role: "assistant", content: "¡Hola! ¿Qué te gustaría saber?" },
          { role: "user", content: "¿Cuál es tu stack?" },
        ],
      }),
      makeEnv(),
    );

    expect(response.status).toBe(200);
    const body = await jsonBody(response);
    expect(body.mode).toBe("guide");
    expect(body.reply).toContain("SvelteKit");
  });

  it("falls back when the provider throws an availability error (429 quota, the live free-tier case)", async () => {
    class QuotaProvider implements AIProvider {
      async generate(): Promise<AiResponse> {
        throw new Error("HTTP 429 Too Many Requests: daily free quota exhausted");
      }
    }
    const handler = buildHandler(makeDeps({ ai: new QuotaProvider() }));
    const response = await handler(
      chatRequest({ messages: [{ role: "user", content: "¿Qué proyectos tienes?" }] }),
      makeEnv(),
    );

    // chat.ts classifyProviderError maps the 429 to ai_unavailable -> guide.
    expect(response.status).toBe(200);
    const body = await jsonBody(response);
    expect(body.mode).toBe("guide");
    expect(body.reply).toContain("mis proyectos");
    expect(body.widgets).toEqual([{ index: 0, type: "projects" }]);
  });

  it("falls back on upstream 5xx provider failures (unavailable service)", async () => {
    class FiveHundredProvider implements AIProvider {
      async generate(): Promise<AiResponse> {
        throw new Error("Upstream request failed: 503 Service Unavailable");
      }
    }
    const handler = buildHandler(makeDeps({ ai: new FiveHundredProvider() }));
    const response = await handler(
      chatRequest({ messages: [{ role: "user", content: "¿Quién eres?" }] }),
      makeEnv(),
    );

    expect(response.status).toBe(200);
    const body = await jsonBody(response);
    expect(body.mode).toBe("guide");
    expect(body.reply).toContain("Albert Verdu");
  });

  it("never masks rate limiting: a denied turn stays 429 even with an unavailable provider", async () => {
    const handler = buildHandler(
      makeDeps({ ai: new NoOutputAIProvider(), rateLimiter: fakeRateLimiter(false) }),
    );
    const response = await handler(
      chatRequest({ messages: [{ role: "user", content: "¿Quién eres?" }] }),
      makeEnv(),
    );

    expect(response.status).toBe(429);
    const body = await jsonBody(response);
    expect((body.error as { code: string }).code).toBe("rate_limited");
  });
});

describe("buildHandler POST /api/chat — unchanged contract outside guide mode", () => {
  it("keeps the non-retryable ChatRunError(ai_error) as 502 ai_unavailable", async () => {
    class ThrowingProvider implements AIProvider {
      async generate(): Promise<AiResponse> {
        throw new ChatRunError("ai_error", "error no recuperable");
      }
    }
    const handler = buildHandler(makeDeps({ ai: new ThrowingProvider() }));
    const response = await handler(
      chatRequest({ messages: [{ role: "user", content: "¿Quién eres?" }] }),
      makeEnv(),
    );

    expect(response.status).toBe(502);
    const body = await jsonBody(response);
    expect(body.error).toEqual({
      code: "ai_unavailable",
      message: "El servicio de respuestas no está disponible ahora mismo.",
      retryable: true,
    });
  });

  it("keeps a raw non-availability provider error (invalid payload) as 502 ai_unavailable", async () => {
    class InvalidProvider implements AIProvider {
      async generate(): Promise<AiResponse> {
        throw new Error("Malformed tool call: missing arguments json");
      }
    }
    const handler = buildHandler(makeDeps({ ai: new InvalidProvider() }));
    const response = await handler(
      chatRequest({ messages: [{ role: "user", content: "¿Quién eres?" }] }),
      makeEnv(),
    );

    expect(response.status).toBe(502);
    const body = await jsonBody(response);
    expect((body.error as { code: string }).code).toBe("ai_unavailable");
  });

  it("keeps the happy path without mode or suggestions (contract unchanged)", async () => {
    const handler = buildHandler(makeDeps());
    const response = await handler(
      chatRequest({ messages: [{ role: "user", content: "¿Quién eres?" }] }),
      makeEnv(),
    );

    expect(response.status).toBe(200);
    const body = await jsonBody(response);
    expect(body).not.toHaveProperty("mode");
    expect(body).not.toHaveProperty("suggestions");
    expect(body).toEqual({ reply: "Respuesta", sources: [] });
  });
});