import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildHandler } from "../src/index";
import type { HandlerDeps } from "../src/index";
import { SnapshotKnowledgeProvider } from "../src/knowledge";
import type { KnowledgeProvider } from "../src/knowledge";
import { clearLinkMetaCache } from "../src/link-meta";
import { DEFAULT_LIMITS } from "../src/limits";
import { clearProjectCache, resolveProjectCard } from "../src/project";
import type { RateLimit } from "../src/ratelimit";
import type { KnowledgeIndexEntry } from "../src/types";

const BASE_URL = "https://verdu.dev";

const HTML = (html: string): Response => new Response(html, { status: 200 });

/** A fake global fetch that returns queued responses or rejects. */
function makeFetch(
  queue: Array<Response | Error> = [],
): ReturnType<typeof vi.fn> & { __auto?: boolean } {
  const fn = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    const next = queue.shift();
    if (next === undefined) {
      throw new Error("Unexpected fetch call");
    }
    if (next instanceof Error) throw next;
    return next;
  });
  return fn;
}

const ENTRIES: KnowledgeIndexEntry[] = [
  {
    id: "botanic",
    path: "projects/botanic",
    title: "Botanic",
    description: "Vivero y jardinería en Barcelona.",
    url: "https://botanic.example.com/",
  },
  {
    id: "gaplogic",
    path: "projects/gaplogic",
    title: "GAP Logic",
    description: "Lógica de producto para webs.",
    url: "https://gaplogic.example.com/",
  },
  {
    id: "kncelados",
    path: "projects/kncelados",
    title: "Kncelados",
    description: "Cerramientos de obra.",
  },
];

const OG_HTML = `<meta property="og:title" content="Botanic — Vivero">
<meta property="og:description" content="Plantas mediterráneas y asesoría.">
<meta property="og:site_name" content="Botanic Mediterrani">
<meta property="og:image" content="/og/card.jpg">`;

beforeEach(() => {
  clearProjectCache();
  clearLinkMetaCache();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------- resolveProjectCard ------------------------------- */

describe("resolveProjectCard", () => {
  it("returns null for an unknown slug", async () => {
    const card = await resolveProjectCard("nope", { entries: ENTRIES });
    expect(card).toBeNull();
  });

  it("resolves doc fields plus live OG media for an entry with url", async () => {
    const fetchImpl = makeFetch([HTML(OG_HTML)]);
    const card = await resolveProjectCard("botanic", { entries: ENTRIES, fetchImpl });
    expect(card).toEqual({
      slug: "botanic",
      title: "Botanic",
      description: "Vivero y jardinería en Barcelona.",
      url: "https://botanic.example.com/",
      domain: "botanic.example.com",
      image: "https://botanic.example.com/og/card.jpg",
      siteName: "Botanic Mediterrani",
      iconUrl: "https://www.google.com/s2/favicons?domain=botanic.example.com&sz=64",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("falls back siteName to the domain when og:site_name is absent", async () => {
    const fetchImpl = makeFetch([HTML(`<meta property="og:image" content="/a.jpg">`)]);
    const card = await resolveProjectCard("gaplogic", { entries: ENTRIES, fetchImpl });
    expect(card?.domain).toBe("gaplogic.example.com");
    expect(card?.siteName).toBe("gaplogic.example.com");
    expect(card?.image).toBe("https://gaplogic.example.com/a.jpg");
  });

  it("returns a doc-only card when the entry has no url", async () => {
    const fetchImpl = makeFetch([]);
    const card = await resolveProjectCard("kncelados", { entries: ENTRIES, fetchImpl });
    expect(card).toEqual({
      slug: "kncelados",
      title: "Kncelados",
      description: "Cerramientos de obra.",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps the doc-only card when the OG fetch rejects", async () => {
    const fetchImpl = makeFetch([new Error("red caída")]);
    const card = await resolveProjectCard("botanic", { entries: ENTRIES, fetchImpl });
    expect(card).toEqual({
      slug: "botanic",
      title: "Botanic",
      description: "Vivero y jardinería en Barcelona.",
      url: "https://botanic.example.com/",
    });
    expect(console.warn).toHaveBeenCalled();
  });

  it("keeps the doc-only card when the entry url is not fetchable", async () => {
    const entries: KnowledgeIndexEntry[] = [
      {
        id: "botanic",
        path: "projects/botanic",
        title: "Botanic",
        description: "Vivero y jardinería en Barcelona.",
        url: "mailto:hola@example.com",
      },
    ];
    const card = await resolveProjectCard("botanic", { entries });
    expect(card).toEqual({
      slug: "botanic",
      title: "Botanic",
      description: "Vivero y jardinería en Barcelona.",
      url: "mailto:hola@example.com",
    });
  });

  it("serves a cache hit without a second fetch", async () => {
    const fetchImpl = makeFetch([HTML(OG_HTML)]);
    const now = () => 1000;
    const deps = { entries: ENTRIES, fetchImpl, now };
    const first = await resolveProjectCard("botanic", deps);
    const second = await resolveProjectCard("botanic", deps);
    expect(first).toEqual(second);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

/* -------------------------------- the route --------------------------------- */

describe("GET /api/project route", () => {
  function fakeRateLimiter(allowed: boolean): RateLimit {
    return { check: async () => ({ allowed, retryAfterSeconds: allowed ? 0 : 60 }) };
  }

  function knowledgeWith(entries: KnowledgeIndexEntry[]): KnowledgeProvider {
    return { getDocument: async () => null, index: () => entries };
  }

  function makeDeps(overrides: Partial<HandlerDeps> = {}): HandlerDeps {
    return {
      rateLimiter: fakeRateLimiter(true),
      knowledge: new SnapshotKnowledgeProvider(6000),
      ai: {
        generate: async () => ({ text: "Respuesta", toolCalls: null }),
      },
      limits: DEFAULT_LIMITS,
      allowedOrigins: ["http://localhost:4321"],
      fetchImpl: makeFetch([]),
      ...overrides,
    };
  }

  function get(path: string): Request {
    return new Request(`${BASE_URL}${path}`, {
      method: "GET",
      headers: { origin: "http://localhost:4321" },
    });
  }

  it("returns 200 with the card and CORS headers", async () => {
    const fetchImpl = makeFetch([HTML(OG_HTML)]);
    const handler = buildHandler(
      makeDeps({ knowledge: knowledgeWith(ENTRIES), fetchImpl }),
    );
    const response = await handler(get("/api/project?slug=botanic"), {
      ALLOWED_ORIGINS: "http://localhost:4321",
    } as never);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      slug: "botanic",
      title: "Botanic",
      description: "Vivero y jardinería en Barcelona.",
      url: "https://botanic.example.com/",
      domain: "botanic.example.com",
      image: "https://botanic.example.com/og/card.jpg",
      siteName: "Botanic Mediterrani",
      iconUrl: "https://www.google.com/s2/favicons?domain=botanic.example.com&sz=64",
    });
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:4321");
    expect(response.headers.get("vary")).toBe("Origin");
  });

  it("returns 404 project_not_found for an unknown slug", async () => {
    const handler = buildHandler(makeDeps({ knowledge: knowledgeWith(ENTRIES) }));
    const response = await handler(get("/api/project?slug=nope"), {
      ALLOWED_ORIGINS: "http://localhost:4321",
    } as never);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "project_not_found", message: "Proyecto no encontrado.", retryable: false },
    });
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:4321");
  });

  it("returns 404 project_not_found when the slug param is missing or blank", async () => {
    const handler = buildHandler(makeDeps({ knowledge: knowledgeWith(ENTRIES) }));
    for (const path of ["/api/project", "/api/project?slug=", "/api/project?slug=%20%20"]) {
      const response = await handler(get(path), {
        ALLOWED_ORIGINS: "http://localhost:4321",
      } as never);
      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("project_not_found");
    }
  });

  it("returns a doc-only card when the OG fetch fails", async () => {
    const fetchImpl = makeFetch([new Error("boom")]);
    const handler = buildHandler(
      makeDeps({ knowledge: knowledgeWith(ENTRIES), fetchImpl }),
    );
    const response = await handler(get("/api/project?slug=botanic"), {
      ALLOWED_ORIGINS: "http://localhost:4321",
    } as never);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      slug: "botanic",
      title: "Botanic",
      description: "Vivero y jardinería en Barcelona.",
      url: "https://botanic.example.com/",
    });
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:4321");
  });
});