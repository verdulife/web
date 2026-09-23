import type { AIProvider } from "./ai";
import { CloudflareAIProvider, MockAIProvider } from "./ai";
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
import { LinkMetaError, isFetchableUrl, resolveLinkMeta } from "./link-meta";
import { resolveProjectCard } from "./project";
import { listProjectCards } from "./projects";
import { buildSystemPrompt } from "./prompts";
import type { Env } from "./types";
import { normalizeWidgets } from "./widgets";

function json(
  data: unknown,
  init?: ResponseInit,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(data), {
    status: init?.status ?? 200,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

export function allowedOriginsFromEnv(env: Env): string[] {
  return env.ALLOWED_ORIGINS.split(";")
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * CORS headers for an allowed origin. The origin is echoed (never "*") and the
 * response is marked `Vary: Origin` so caches keep per-origin variants. For a
 * missing or disallowed origin the map is empty and no ACAO is emitted.
 */
export function corsHeaders(request: Request, allowedOrigins: string[]): Record<string, string> {
  const origin = request.headers.get("origin");
  if (origin === null || !allowedOrigins.includes(origin)) {
    return {};
  }
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
  };
}

function handlePreflight(request: Request, allowedOrigins: string[]): Response {
  return new Response(null, {
    status: 204,
    headers: { ...corsHeaders(request, allowedOrigins), "Access-Control-Max-Age": "86400" },
  });
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

const INVALID_LINK_ERROR = {
  error: { code: "invalid_url", message: "Enlace inválido.", retryable: false },
};

const LINK_META_UNAVAILABLE = {
  error: {
    code: "link_meta_unavailable",
    message: "No se pudo obtener la información del enlace.",
    retryable: true,
  },
};

const PROJECT_NOT_FOUND_ERROR = {
  error: {
    code: "project_not_found",
    message: "Proyecto no encontrado.",
    retryable: false,
  },
};

export interface HandlerDeps {
  rateLimiter: RateLimit;
  knowledge: KnowledgeProvider;
  ai: AIProvider;
  limits: Limits;
  allowedOrigins: string[];
  /** Injectable fetch for tests; defaults to the global fetch in production. */
  fetchImpl?: typeof fetch;
}

/** Pure request router: every route is reachable through here (tests included). */
export function buildHandler(deps: HandlerDeps): (request: Request, env: Env) => Promise<Response> {
  return async (request: Request, env: Env): Promise<Response> => {
    const url = new URL(request.url);
    const cors = corsHeaders(request, deps.allowedOrigins);

    if (request.method === "OPTIONS") {
      return handlePreflight(request, deps.allowedOrigins);
    }

    if (request.method === "POST" && url.pathname === "/api/chat") {
      return handleChat(request, env, deps, cors);
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "verdu-chat", model: env.MODEL_ID }, undefined, cors);
    }

    if (request.method === "GET" && url.pathname === "/api/link-meta") {
      return handleLinkMeta(url, deps, cors);
    }

    if (request.method === "GET" && url.pathname === "/api/project") {
      return handleProject(url, deps, cors);
    }

    if (request.method === "GET" && url.pathname === "/api/projects") {
      return json({ projects: listProjectCards(deps.knowledge.index()) }, undefined, cors);
    }

    return json(
      { error: { code: "not_found", message: "Recurso no encontrado.", retryable: false } },
      { status: 404 },
      cors,
    );
  };
}

async function handleLinkMeta(
  url: URL,
  deps: HandlerDeps,
  cors: Record<string, string>,
): Promise<Response> {
  const rawUrl = (url.searchParams.get("url") ?? "").trim();
  if (rawUrl === "" || !isFetchableUrl(rawUrl)) {
    return json(INVALID_LINK_ERROR, { status: 400 }, cors);
  }

  try {
    const meta = await resolveLinkMeta(rawUrl, { fetchImpl: deps.fetchImpl });
    return json(meta, undefined, cors);
  } catch (error) {
    if (error instanceof LinkMetaError && error.code === "invalid_url") {
      return json(INVALID_LINK_ERROR, { status: 400 }, cors);
    }
    console.error("[link-meta]", error instanceof Error ? error.message : error);
    return json(LINK_META_UNAVAILABLE, { status: 502 }, cors);
  }
}

async function handleProject(
  url: URL,
  deps: HandlerDeps,
  cors: Record<string, string>,
): Promise<Response> {
  const slug = (url.searchParams.get("slug") ?? "").trim();
  if (slug === "") {
    return json(PROJECT_NOT_FOUND_ERROR, { status: 404 }, cors);
  }

  const card = await resolveProjectCard(slug, {
    entries: deps.knowledge.index(),
    fetchImpl: deps.fetchImpl,
  });
  if (card === null) {
    return json(PROJECT_NOT_FOUND_ERROR, { status: 404 }, cors);
  }
  return json(card, undefined, cors);
}

async function handleChat(
  request: Request,
  env: Env,
  deps: HandlerDeps,
  cors: Record<string, string>,
): Promise<Response> {
  const ip = request.headers.get("cf-connecting-ip") ?? "anonymous";
  const rateLimit = await deps.rateLimiter.check(ip);
  if (!rateLimit.allowed) {
    return json(RATE_LIMITED_ERROR, { status: 429 }, cors);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(INVALID_REQUEST_ERROR, { status: 400 }, cors);
  }

  const validation = validateChatRequest(body, deps.limits);
  if (!validation.ok) {
    return json(INVALID_REQUEST_ERROR, { status: 400 }, cors);
  }

  for (const message of validation.request.messages) {
    if (detectScopeAbuse(message.content)) {
      return json(SCOPE_REFUSED_ERROR, { status: 422 }, cors);
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
    const normalized = normalizeWidgets(result.reply);
    // `widgets` is omitted when empty so the empty case keeps the previous
    // response shape; when widgets exist the contract is `{ reply, widgets, sources }`.
    const widgets = normalized.widgets.length > 0 ? { widgets: normalized.widgets } : {};
    return json(
      { reply: normalized.reply, ...widgets, sources: result.sources },
      undefined,
      cors,
    );
  } catch (error) {
    if (!(error instanceof ChatRunError)) {
      console.error("[chat]", error instanceof Error ? error.message : error);
    }
    return json(AI_UNAVAILABLE_ERROR, { status: 502 }, cors);
  }
}

export default {
  fetch(request: Request, env: Env, _ctx: unknown): Promise<Response> {
    const deps: HandlerDeps = {
      rateLimiter: createRateLimiter(env),
      knowledge: createKnowledgeProvider(env),
      ai: env.AI_PROVIDER === "mock" ? new MockAIProvider() : new CloudflareAIProvider(env.AI, env.MODEL_ID),
      limits: limitsFromEnv(env),
      allowedOrigins: allowedOriginsFromEnv(env),
    };
    return buildHandler(deps)(request, env);
  },
};