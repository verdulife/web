import { describe, expect, it } from "vitest";
import { buildHandler } from "../src/index";
import type { HandlerDeps } from "../src/index";
import { SnapshotKnowledgeProvider } from "../src/knowledge";
import type { KnowledgeProvider } from "../src/knowledge";
import { DEFAULT_LIMITS } from "../src/limits";
import { listProjectCards } from "../src/projects";
import type { ProjectListItem } from "../src/projects";
import type { RateLimit } from "../src/ratelimit";
import type { KnowledgeIndexEntry } from "../src/types";

const BASE_URL = "https://verdu.dev";

/**
 * Fixture entries mirror the generated index shape: `kind` is a runtime field
 * present on every entry ("project" for projects) that the modules read via a
 * narrow intersection; `url` is optional and may be an empty string.
 */
type FixtureEntry = KnowledgeIndexEntry & { kind?: string };

const ENTRIES: FixtureEntry[] = [
  { id: "about", path: "about", kind: "about", title: "Sobre mí", description: "Perfil." },
  { id: "alter", path: "projects/alter", kind: "project", title: "Alter", description: "Secretario personal virtual." },
  { id: "aster", path: "projects/aster", kind: "project", title: "Áster", description: "Paisajismo y exteriores.", url: "https://aster.example.com" },
  { id: "botanic", path: "projects/botanic", kind: "project", title: "Botanic", description: "Marketplace P2P de plantas.", url: "https://botanic.example.com/" },
  { id: "gapcalc", path: "projects/gapcalc", kind: "project", title: "gapcalc", description: "Calculadora de imprenta.", url: "" },
  { id: "kncelados", path: "projects/kncelados", kind: "project", title: "Kncelados", description: "Web del podcast." },
  { id: "weprintpdf", path: "projects/weprintpdf", kind: "project", title: "WePrintPDF", description: "Diseños imprimibles." },
  { id: "contact", path: "contact", kind: "contact", title: "Contacto", description: "Canales públicos." },
];

/** Expected es-locale order for the fixture project titles. */
const PROJECT_SLUGS_IN_ORDER = ["alter", "aster", "botanic", "gapcalc", "kncelados", "weprintpdf"];

/* ------------------------------- listProjectCards ------------------------------- */

describe("listProjectCards", () => {
  it("filters entries to kind 'project' only", () => {
    const items = listProjectCards(ENTRIES);
    expect(items).toHaveLength(6);
    expect(items.map((item) => item.slug)).toEqual(PROJECT_SLUGS_IN_ORDER);
    expect(items.map((item) => item.slug)).not.toContain("about");
    expect(items.map((item) => item.slug)).not.toContain("contact");
  });

  it("maps slug, title, description and keeps a present url", () => {
    const bySlug = new Map(listProjectCards(ENTRIES).map((item) => [item.slug, item]));
    expect(bySlug.get("botanic")).toEqual({
      slug: "botanic",
      title: "Botanic",
      description: "Marketplace P2P de plantas.",
      url: "https://botanic.example.com/",
    });
  });

  it("omits url when absent or empty", () => {
    const items = listProjectCards(ENTRIES);
    expect(items.find((item) => item.slug === "kncelados")?.url).toBeUndefined();
    expect(items.find((item) => item.slug === "gapcalc")?.url).toBeUndefined();
    expect(items.map((item) => item.url ?? null)).toEqual([
      null,
      "https://aster.example.com",
      "https://botanic.example.com/",
      null,
      null,
      null,
    ]);
  });

  it("sorts by title with the Spanish locale ('gapcalc' before 'Kncelados', accent-ignoring 'Áster')", () => {
    // Plain ASCII collation would order 'K'(75) before 'g'(103); the es locale
    // compares base letters case-insensitively, so 'g' < 'k' applies.
    const items = listProjectCards(ENTRIES);
    expect(items.map((item) => item.title)).toEqual([
      "Alter",
      "Áster",
      "Botanic",
      "gapcalc",
      "Kncelados",
      "WePrintPDF",
    ]);
  });

  it("returns an empty list for an empty index", () => {
    expect(listProjectCards([])).toEqual([]);
  });

  it("only returns entries with kind 'project' inside a mixed index", () => {
    const output = listProjectCards(ENTRIES);
    for (const item of output satisfies ProjectListItem[]) {
      expect(item.slug).toMatch(/^[a-z0-9-]+$/);
      expect(typeof item.title).toBe("string");
      expect(typeof item.description).toBe("string");
    }
  });
});

/* -------------------------------- the route --------------------------------- */

describe("GET /api/projects route", () => {
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
      ...overrides,
    };
  }

  function get(path: string): Request {
    return new Request(`${BASE_URL}${path}`, {
      method: "GET",
      headers: { origin: "http://localhost:4321" },
    });
  }

  it("returns 200 with the sorted projects list and CORS echo", async () => {
    const handler = buildHandler(makeDeps({ knowledge: knowledgeWith(ENTRIES) }));
    const response = await handler(get("/api/projects"), {
      ALLOWED_ORIGINS: "http://localhost:4321",
    } as never);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { projects: ProjectListItem[] };
    expect(body.projects.map((project) => project.slug)).toEqual(PROJECT_SLUGS_IN_ORDER);
    expect(body.projects[0]).toEqual({
      slug: "alter",
      title: "Alter",
      description: "Secretario personal virtual.",
    });
    // The empty-string url is normalized away and serialization omits it.
    expect(body.projects[3]).toEqual({
      slug: "gapcalc",
      title: "gapcalc",
      description: "Calculadora de imprenta.",
    });
    expect(body.projects[1]).toEqual({
      slug: "aster",
      title: "Áster",
      description: "Paisajismo y exteriores.",
      url: "https://aster.example.com",
    });
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:4321");
    expect(response.headers.get("vary")).toBe("Origin");
  });

  it("returns all 20 project entries from the real bundled index", async () => {
    const handler = buildHandler(makeDeps({}));
    const response = await handler(get("/api/projects"), {
      ALLOWED_ORIGINS: "http://localhost:4321",
    } as never);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { projects: ProjectListItem[] };
    expect(body.projects).toHaveLength(20);
    for (const project of body.projects) {
      expect(project.slug).toMatch(/^[a-z0-9-]+$/);
      expect(typeof project.title).toBe("string");
      expect(typeof project.description).toBe("string");
    }
    // Sorted (each item <= the next by es collation).
    for (let index = 1; index < body.projects.length; index += 1) {
      const previous = body.projects[index - 1];
      const current = body.projects[index];
      expect(previous.title.localeCompare(current.title, "es")).toBeLessThanOrEqual(0);
    }
  });

  it("returns an empty projects list (200) for an empty index", async () => {
    const handler = buildHandler(makeDeps({ knowledge: knowledgeWith([]) }));
    const response = await handler(get("/api/projects"), {
      ALLOWED_ORIGINS: "http://localhost:4321",
    } as never);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ projects: [] });
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:4321");
  });
});