import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LinkMetaError,
  clearLinkMetaCache,
  decodeHtmlEntities,
  extractIconHref,
  extractManifestHref,
  extractMetaDescription,
  extractOgProperty,
  extractOgTitle,
  extractTitle,
  isFetchableUrl,
  resolveHref,
  resolveLinkMeta,
} from "../src/link-meta";
import { buildHandler } from "../src/index";
import type { HandlerDeps } from "../src/index";
import type { RateLimit } from "../src/ratelimit";
import { SnapshotKnowledgeProvider } from "../src/knowledge";
import { DEFAULT_LIMITS } from "../src/limits";

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

beforeEach(() => {
  clearLinkMetaCache();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------- parsing helpers ------------------------------- */

describe("extraction helpers", () => {
  it("extracts og:title regardless of attribute order", () => {
    const html = `<meta name="viewport" content="width=1"><meta content="Mi &amp; Portafolio" property="og:title">`;
    expect(extractOgTitle(html)).toBe("Mi &amp; Portafolio");
  });

  it("extracts the raw <title> text", () => {
    expect(extractTitle("<html><title>  Título   </title></html>")).toBe("  Título   ");
  });

  it("extracts the manifest href from a link rel=manifest tag", () => {
    const html = `<link rel="icon" href="/favicon.ico"><link rel="manifest" href="/site.webmanifest">`;
    expect(extractManifestHref(html)).toBe("/site.webmanifest");
  });

  it("extracts icon href from rel=icon, shortcut icon and apple-touch-icon", () => {
    expect(extractIconHref(`<link rel="shortcut icon" href="/a.ico">`)).toBe("/a.ico");
    expect(extractIconHref(`<link rel="apple-touch-icon" href="/b.png">`)).toBe("/b.png");
  });

  it("decodes named and numeric entities", () => {
    expect(decodeHtmlEntities("a &amp; b &lt;c&gt; &#169; &#x1F600;")).toBe(
      "a & b <c> © 😀",
    );
  });

  it("extracts any og property with entity decode and whitespace collapse", () => {
    const html = `<meta content="  Mi &amp;  Web  " property="og:site_name">`;
    expect(extractOgProperty(html, "og:site_name")).toBe("Mi & Web");
    expect(extractOgProperty(html, "og:OG_TITLE")).toBeNull();
  });

  it("extracts the meta description as og:description fallback", () => {
    const html = `<meta name="description" content="  Resumen  &nbsp;  del sitio ">`;
    expect(extractMetaDescription(html)).toBe("Resumen del sitio");
  });

  it("resolves relative hrefs against the base URL", () => {
    expect(resolveHref("/favicon.ico", "https://ex.com/a/b")!.toString()).toBe(
      "https://ex.com/favicon.ico",
    );
    expect(resolveHref("https://abs.example/x", "https://base.example/")!.toString()).toBe(
      "https://abs.example/x",
    );
  });
});

/* ------------------------------- isFetchableUrl ------------------------------- */

describe("isFetchableUrl", () => {
  it("accepts public absolute http/https URLs", () => {
    expect(isFetchableUrl("https://example.com/path?q=1")).toBe(true);
    expect(isFetchableUrl("http://verdu.dev")).toBe(true);
  });

  it("rejects non-http(s) schemes", () => {
    expect(isFetchableUrl("javascript:alert(1)")).toBe(false);
    expect(isFetchableUrl("file:///etc/passwd")).toBe(false);
    expect(isFetchableUrl("ftp://example.com/f")).toBe(false);
    expect(isFetchableUrl("not-a-url")).toBe(false);
  });

  it("rejects URLs with embedded credentials", () => {
    expect(isFetchableUrl("https://usuario:clave@example.com/")).toBe(false);
    expect(isFetchableUrl("https://solo@example.com/")).toBe(false);
  });

  it("rejects loopback, private and link-local hosts", () => {
    expect(isFetchableUrl("http://localhost:8080/x")).toBe(false);
    expect(isFetchableUrl("http://foo.localhost/")).toBe(false);
    expect(isFetchableUrl("http://127.0.0.1/")).toBe(false);
    expect(isFetchableUrl("http://127.9.9.9/")).toBe(false);
    expect(isFetchableUrl("http://10.0.0.5/")).toBe(false);
    expect(isFetchableUrl("http://172.16.0.1/")).toBe(false);
    expect(isFetchableUrl("http://172.31.255.255/")).toBe(false);
    expect(isFetchableUrl("http://192.168.1.1/")).toBe(false);
    expect(isFetchableUrl("http://169.254.169.254/metadata")).toBe(false);
    expect(isFetchableUrl("http://[::1]/")).toBe(false);
  });

  it("rejects dot-local / dot-internal hosts", () => {
    expect(isFetchableUrl("http://printer.local/")).toBe(false);
    expect(isFetchableUrl("http://service.internal/")).toBe(false);
  });
});

/* ------------------------------- resolveLinkMeta ------------------------------- */

describe("resolveLinkMeta", () => {
  it("resolves label og:title → title → domain in priority order", async () => {
    const now = () => 1000;
    const fetchImpl = makeFetch([
      HTML(`<html><head><meta property="og:title" content="  Etiqueta  OG  "></head></html>`),
    ]);
    const meta = await resolveLinkMeta("https://example.com/link", { fetchImpl, now });
    expect(meta.label).toBe("Etiqueta OG");
    expect(meta.domain).toBe("example.com");
    expect(meta.url).toBe("https://example.com/link");
  });

  it("uses the manifest name when og:title is absent", async () => {
    const fetchImpl = makeFetch([
      HTML(`<link rel="manifest" href="/manifest.json">`),
      HTML(JSON.stringify({ name: "Nombre del Manifest" })),
    ]);
    const meta = await resolveLinkMeta("https://example.com/link", { fetchImpl });
    expect(meta.label).toBe("Nombre del Manifest");
  });

  it("falls back to <title> when og:title and manifest name are absent", async () => {
    const fetchImpl = makeFetch([HTML(`<title> Título  de  la  página </title>`)]);
    const meta = await resolveLinkMeta("https://example.com/link", { fetchImpl });
    expect(meta.label).toBe("Título de la página");
  });

  it("falls back to the hostname when no label is found", async () => {
    const fetchImpl = makeFetch([HTML("<html><body>sin metadatos</body></html>")]);
    const meta = await resolveLinkMeta("https://example.com/link", { fetchImpl });
    expect(meta.label).toBe("example.com");
  });

  it("caps a label at 120 chars and collapses whitespace", async () => {
    const long = "x".repeat(200);
    const fetchImpl = makeFetch([HTML(`<title>${long}    seguido</title>`)]);
    const meta = await resolveLinkMeta("https://example.com/link", { fetchImpl });
    expect(meta.label).toHaveLength(120);
    expect(meta.label).toBe("x".repeat(120));
  });

  it("returns an icon from rel=icon with relative resolution", async () => {
    const fetchImpl = makeFetch([HTML(`<link rel="icon" href="/assets/favicon.ico">`)]);
    const meta = await resolveLinkMeta("https://example.com/a/b", { fetchImpl });
    expect(meta.iconUrl).toBe("https://example.com/assets/favicon.ico");
  });

  it("falls back to the Google favicon service when no icon link exists", async () => {
    const fetchImpl = makeFetch([HTML("<html></html>")]);
    const meta = await resolveLinkMeta("https://example.com/x", { fetchImpl });
    expect(meta.iconUrl).toBe(
      "https://www.google.com/s2/favicons?domain=example.com&sz=64",
    );
  });

  it("decodes entities in labels", async () => {
    const fetchImpl = makeFetch([HTML(`<title>Tom &amp; Jerry</title>`)]);
    const meta = await resolveLinkMeta("https://example.com/x", { fetchImpl });
    expect(meta.label).toBe("Tom & Jerry");
  });

  it("throws invalid_url for a non-fetchable URL", async () => {
    await expect(
      resolveLinkMeta("http://localhost:8080/", { fetchImpl: makeFetch([]) }),
    ).rejects.toMatchObject({ code: "invalid_url", name: "LinkMetaError" });
    await expect(resolveLinkMeta("javascript:alert(1)")).rejects.toMatchObject({
      code: "invalid_url",
    });
  });

  it("throws upstream_failed when the fetch rejects", async () => {
    const fetchImpl = makeFetch([new Error("red caída")]);
    await expect(
      resolveLinkMeta("https://example.com/", { fetchImpl }),
    ).rejects.toMatchObject({ code: "upstream_failed", name: "LinkMetaError" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("throws upstream_failed on a non-ok response", async () => {
    const fetchImpl = makeFetch([new Response("nope", { status: 500 })]);
    await expect(
      resolveLinkMeta("https://example.com/", { fetchImpl }),
    ).rejects.toMatchObject({ code: "upstream_failed" });
  });

  it("serves a cache hit without a second fetch", async () => {
    const fetchImpl = makeFetch([HTML(`<title>Cacheado</title>`)]);
    const now = () => 1000;
    const first = await resolveLinkMeta("https://example.com/x", { fetchImpl, now });
    const second = await resolveLinkMeta("https://example.com/x", { fetchImpl, now });
    expect(first).toEqual(second);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("ignores a failing manifest fetch and falls through to title", async () => {
    const fetchImpl = makeFetch([new Error("manifest fail")]);
    // Here the primary fetch fails entirely; assert we get upstream_failed too.
    await expect(
      resolveLinkMeta("https://example.com/x", { fetchImpl }),
    ).rejects.toMatchObject({ code: "upstream_failed" });
  });

  it("returns the optional og fields (title, description, site name, image)", async () => {
    const html = `<meta property="og:title" content="Jardinería La Mediterránea">
      <meta property="og:description" content="Vivero y jardinería en Barcelona.">
      <meta property="og:site_name" content="La Mediterránea">
      <meta property="og:image" content="/og/portada.jpg">`;
    const fetchImpl = makeFetch([HTML(html)]);
    const meta = await resolveLinkMeta("https://jardineria.example.com/a", { fetchImpl });
    expect(meta.ogTitle).toBe("Jardinería La Mediterránea");
    expect(meta.ogDescription).toBe("Vivero y jardinería en Barcelona.");
    expect(meta.ogSiteName).toBe("La Mediterránea");
    expect(meta.ogImage).toBe("https://jardineria.example.com/og/portada.jpg");
  });

  it("falls back to the meta description for og:description", async () => {
    const fetchImpl = makeFetch([HTML(`<meta name="description" content="Descripción clásica">`)]);
    const meta = await resolveLinkMeta("https://example.com/x", { fetchImpl });
    expect(meta.ogDescription).toBe("Descripción clásica");
    expect(meta.ogTitle).toBeUndefined();
    expect(meta.ogImage).toBeUndefined();
    expect(meta.ogSiteName).toBeUndefined();
  });

  it("omits every og field when the page publishes none", async () => {
    const fetchImpl = makeFetch([HTML("<html><title>Solo título</title></html>")]);
    const meta = await resolveLinkMeta("https://example.com/x", { fetchImpl });
    expect(meta.ogTitle).toBeUndefined();
    expect(meta.ogDescription).toBeUndefined();
    expect(meta.ogImage).toBeUndefined();
    expect(meta.ogSiteName).toBeUndefined();
  });

  it("caps og text fields and drops images over the cap", async () => {
    const title = "t".repeat(300);
    const description = "d".repeat(500);
    const siteName = "s".repeat(150);
    const image = `https://example.com/${"i".repeat(2010)}.jpg`;
    const fetchImpl = makeFetch([
      HTML(`<meta property="og:title" content="${title}">
        <meta property="og:description" content="${description}">
        <meta property="og:site_name" content="${siteName}">
        <meta property="og:image" content="${image}">`),
    ]);
    const meta = await resolveLinkMeta("https://example.com/x", { fetchImpl });
    expect(meta.ogTitle).toHaveLength(200);
    expect(meta.ogDescription).toHaveLength(400);
    expect(meta.ogSiteName).toHaveLength(100);
    expect(meta.ogImage).toBeUndefined();
  });

  it("drops og:image values with non-http(s) schemes", async () => {
    const fetchImpl = makeFetch([
      HTML(`<meta property="og:image" content="data:image/png;base64,AAAA">`),
    ]);
    const meta = await resolveLinkMeta("https://example.com/x", { fetchImpl });
    expect(meta.ogImage).toBeUndefined();
  });
});

/* -------------------------------- the route --------------------------------- */

describe("GET /api/link-meta route", () => {
  const BASE_URL = "https://verdu.dev";

  function fakeRateLimiter(allowed: boolean): RateLimit {
    return { check: async () => ({ allowed, retryAfterSeconds: allowed ? 0 : 60 }) };
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

  it("returns 200 with the resolved metadata and CORS headers", async () => {
    const fetchImpl = makeFetch([HTML(`<meta property="og:title" content="Proyecto">`)]);
    const handler = buildHandler(makeDeps({ fetchImpl }));
    const response = await handler(get("/api/link-meta?url=https%3A%2F%2Fexample.com%2Fp"), {
      ALLOWED_ORIGINS: "http://localhost:4321",
    } as never);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      url: "https://example.com/p",
      domain: "example.com",
      label: "Proyecto",
      iconUrl: "https://www.google.com/s2/favicons?domain=example.com&sz=64",
      ogTitle: "Proyecto",
    });
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:4321");
    expect(response.headers.get("vary")).toBe("Origin");
  });

  it("returns 400 invalid_url when the param is missing", async () => {
    const handler = buildHandler(makeDeps({ fetchImpl: makeFetch([]) }));
    const response = await handler(get("/api/link-meta"), {
      ALLOWED_ORIGINS: "http://localhost:4321",
    } as never);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "invalid_url", message: "Enlace inválido.", retryable: false },
    });
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:4321");
  });

  it("returns 400 invalid_url for a non-fetchable URL", async () => {
    const handler = buildHandler(makeDeps({ fetchImpl: makeFetch([]) }));
    const response = await handler(
      get("/api/link-meta?url=http%3A%2F%2F127.0.0.1%2F"),
      { ALLOWED_ORIGINS: "http://localhost:4321" } as never,
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_url");
  });

  it("returns 502 link_meta_unavailable on upstream failure", async () => {
    const fetchImpl = makeFetch([new Error("boom")]);
    const handler = buildHandler(makeDeps({ fetchImpl }));
    const response = await handler(
      get("/api/link-meta?url=https%3A%2F%2Fexample.com%2F"),
      { ALLOWED_ORIGINS: "http://localhost:4321" } as never,
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: {
        code: "link_meta_unavailable",
        message: "No se pudo obtener la información del enlace.",
        retryable: true,
      },
    });
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:4321");
  });
});