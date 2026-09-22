import type { AIProvider } from "./ai";
import { CloudflareAIProvider } from "./ai";
import { ChatRunError, runChat } from "./chat";
import { createKnowledgeProvider } from "./knowledge";
import type { KnowledgeProvider } from "./knowledge";
import { createRateLimiter } from "./ratelimit";
import type { RateLimit } from "./ratelimit";
import {
  detectScopeAbuse,
  limitsFromEnv,
  trimMessages,
  validateChatRequest,
} from "./limits";
import type { Limits } from "./limits";
import { buildSystemPrompt } from "./prompts";
import type { Env } from "./types";

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    status: init?.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

function handlePreflight(request: Request, env: Env): Response {
  const origin = request.headers.get("origin");
  const allowedOrigins = env.ALLOWED_ORIGINS.split(";")
    .map((value) => value.trim())
    .filter(Boolean);
  const headers = new Headers({
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "86400",
  });
  if (origin !== null && allowedOrigins.includes(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
  }
  return new Response(null, { status: 204, headers });
}

const RATE_LIMITED_ERROR = {
  error: {
    code: "rate_limited",
    message: "Demasiadas preguntas en poco tiempo. Espera un momento y vuelve a intentarlo.",
    retryable: true,
  },
};

const INVALID_REQUEST_ERROR = {
  error: { code: "invalid_request", message: "Solicitud inválida.", retryable: false },
};

const SCOPE_REFUSED_ERROR = {
  error: {
    code: "scope_refused",
    message: "Esa pregunta está fuera del ámbito de este porfolio.",
    retryable: false,
  },
};

const AI_UNAVAILABLE_ERROR = {
  error: {
    code: "ai_unavailable",
    message: "El servicio de respuestas no está disponible ahora mismo.",
    retryable: true,
  },
};

export interface HandlerDeps {
  rateLimiter: RateLimit;
  knowledge: KnowledgeProvider;
  ai: AIProvider;
  limits: Limits;
}

/** Pure request router: every route is reachable through here (tests included). */
export function buildHandler(deps: HandlerDeps): (request: Request, env: Env) => Promise<Response> {
  return async (request: Request, env: Env): Promise<Response> => {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return handlePreflight(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/chat") {
      return handleChat(request, env, deps);
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "verdu-chat", model: env.MODEL_ID });
    }

    return json(
      { error: { code: "not_found", message: "Recurso no encontrado.", retryable: false } },
      { status: 404 },
    );
  };
}

async function handleChat(request: Request, env: Env, deps: HandlerDeps): Promise<Response> {
  const ip = request.headers.get("cf-connecting-ip") ?? "anonymous";
  const rateLimit = await deps.rateLimiter.check(ip);
  if (!rateLimit.allowed) {
    return json(RATE_LIMITED_ERROR, { status: 429 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(INVALID_REQUEST_ERROR, { status: 400 });
  }

  const validation = validateChatRequest(body, deps.limits);
  if (!validation.ok) {
    return json(INVALID_REQUEST_ERROR, { status: 400 });
  }

  for (const message of validation.request.messages) {
    if (detectScopeAbuse(message.content)) {
      return json(SCOPE_REFUSED_ERROR, { status: 422 });
    }
  }

  const system = buildSystemPrompt(deps.knowledge.index());
  const messages = trimMessages(validation.request.messages, deps.limits.maxMessages);

  try {
    const result = await runChat(
      { limits: deps.limits },
      system,
      messages,
      deps.ai,
      deps.knowledge,
    );
    return json({ reply: result.reply, sources: result.sources });
  } catch (error) {
    if (!(error instanceof ChatRunError)) {
      console.error("[chat]", error instanceof Error ? error.message : error);
    }
    return json(AI_UNAVAILABLE_ERROR, { status: 502 });
  }
}

export default {
  fetch(request: Request, env: Env, _ctx: unknown): Promise<Response> {
    const deps: HandlerDeps = {
      rateLimiter: createRateLimiter(env),
      knowledge: createKnowledgeProvider(env),
      ai: new CloudflareAIProvider(env.AI, env.MODEL_ID),
      limits: limitsFromEnv(env),
    };
    return buildHandler(deps)(request, env);
  },
};