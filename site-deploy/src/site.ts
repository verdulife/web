/**
 * Single-worker verdu.dev: serves the Astro static build through the Workers
 * assets system AND runs the chat worker code in-process for /api/* — one
 * worker, one URL (verdu.verdu-3a3.workers.dev today, custom domain later),
 * zero CORS, no second worker to manage.
 *
 * run_worker_first = ["/api/*"] in wrangler.toml ensures /api/* reaches this
 * handler before the assets resolver.
 */
import chatWorker from "../../worker/src/index";
import type { Env as ChatEnv } from "../../worker/src/types";

interface Env extends ChatEnv {
  /** Provided by the Workers static-assets runtime. */
  ASSETS: { fetch(request: Request): Promise<Response> };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname.startsWith("/api/")) {
      // The chat worker runs in-process with the same env (AI_PROVIDER=groq,
      // GROQ_API_KEY secret, GROQ_MODEL_ID, ALLOWED_ORIGINS…); its CORS echo
      // applies trivially because the browser talks to the same origin.
      return chatWorker.fetch(request, env, { waitUntil: () => Promise.resolve() });
    }

    // Everything else: the static build (index, pages, _astro assets, 404).
    return env.ASSETS.fetch(request);
  },
};