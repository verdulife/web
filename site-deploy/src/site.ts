/**
 * Single-worker verdu.dev: serves the portfolio static build from R2 and runs
 * the chat worker code in-process for /api/* — one worker, one URL
 * (verdu.verdu-3a3.workers.dev today, custom domain later), zero CORS.
 *
 * R2-backed instead of the Workers static-assets resolver because, on this
 * account's current (migrating) platform state, the assets resolver answers
 * /api/* before the worker no matter the run_worker_first setting.
 */
import chatWorker from "../../worker/src/index";
import type { Env as ChatEnv } from "../../worker/src/types";

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  ico: "image/x-icon",
  xml: "application/xml",
  txt: "text/plain",
  json: "application/json",
};

function contentTypeFor(key: string): string {
  const ext = key.includes(".") ? key.split(".").pop() ?? "" : "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

interface Env extends ChatEnv {
  /** R2 bucket with the Astro build (dist/), uploaded by the deploy script. */
  ASSETS_BUCKET: {
    get(
      key: string,
    ): Promise<{ body: ReadableStream | null; httpMetadata?: { contentType?: string } } | null>;
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const pathname = decodeURIComponent(url.pathname);

    if (pathname.startsWith("/api/")) {
      // The chat worker runs in-process with the same env (AI_PROVIDER=groq,
      // GROQ_API_KEY secret, GROQ_MODEL_ID, ALLOWED_ORIGINS…).
      return chatWorker.fetch(request, env, { waitUntil: () => Promise.resolve() });
    }

    // Static assets from R2. Trailing slash / bare root resolve to index.html
    // (the Astro build writes /index.html for the home page).
    let key = pathname === "/" ? "index.html" : pathname.slice(1);
    const object = await env.ASSETS_BUCKET.get(key);
    if (object !== null && object.body !== null) {
      const contentType = object.httpMetadata?.contentType ?? contentTypeFor(key);
      // Hashed _astro assets are immutable; everything else gets a short TTL.
      const cacheControl = key.startsWith("_astro/")
        ? "public, max-age=31536000, immutable"
        : "public, max-age=60";
      return new Response(object.body, {
        headers: { "Content-Type": contentType, "Cache-Control": cacheControl },
      });
    }

    // 404 or SPA-friendly: pages are real files (index.html per route), so a
    // missing key is a real 404.
    return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
  },
};