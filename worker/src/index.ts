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

export default {
  async fetch(request: Request, env: Env, _ctx: unknown): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return handlePreflight(request, env);
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "verdu-chat", model: env.MODEL_ID });
    }
    return json(
      {
        error: {
          code: "not_found",
          message: "Recurso no encontrado.",
          retryable: false,
        },
      },
      { status: 404 },
    );
  },
};