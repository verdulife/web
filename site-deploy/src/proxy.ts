/**
 * Site worker (verdu-dev): serves the Astro static build (dist/) through the
 * Workers assets system and forwards every /api/* request server-side to the
 * chat worker (verdu-chat). The site and its chat share ONE origin — no CORS
 * preflight, one URL for the visitor. With a custom domain later, nothing in
 * this worker changes.
 */
interface Env {
  CHAT_WORKER_URL: string;
  ASSETS: { fetch(request: Request): Promise<Response> };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      const target = `${env.CHAT_WORKER_URL}${url.pathname}${url.search}`;
      try {
        return await fetch(new Request(target, request));
      } catch {
        return new Response(
          JSON.stringify({
            error: { code: "chat_unavailable", message: "El chat no está disponible ahora mismo.", retryable: true },
          }),
          { status: 502, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    return env.ASSETS.fetch(request);
  },
} as ExportedHandler<Env>;