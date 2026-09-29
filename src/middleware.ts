import { defineMiddleware } from "astro:middleware";

/**
 * Site worker proxy (verdu-dev): forwards every /api/* request server-side to
 * the chat worker (verdu-chat), so the site and its chat share ONE origin —
 * no CORS preflight, one URL for the visitor. When the site owns a custom
 * domain, this same proxy keeps working unchanged.
 */
const CHAT_WORKER_URL =
  import.meta.env.PUBLIC_CHAT_WORKER_URL ?? "https://verdu-chat.verdu-3a3.workers.dev";

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname, search } = context.url;

  if (pathname.startsWith("/api/")) {
    const target = `${CHAT_WORKER_URL}${pathname}${search}`;
    try {
      const upstream = await fetch(new Request(target, context.request));
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: upstream.headers,
      });
    } catch {
      return new Response(
        JSON.stringify({
          error: { code: "chat_unavailable", message: "El chat no está disponible ahora mismo.", retryable: true },
        }),
        { status: 502, headers: { "Content-Type": "application/json" } },
      );
    }
  }

  return next();
});