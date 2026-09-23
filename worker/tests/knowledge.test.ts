import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createKnowledgeProvider,
  GitHubKnowledgeProvider,
  SnapshotKnowledgeProvider,
} from "../src/knowledge";
import type { KnowledgeIndexEntry } from "../src/types";

interface FetchInit {
  headers?: Record<string, string>;
}

function mockFetchOk(body: string) {
  return vi.fn(async (_url: string, _init?: FetchInit) => ({
    ok: true,
    status: 200,
    text: async () => body,
  }));
}

function mockFetchNotOk() {
  return vi.fn(async () => ({ ok: false, status: 404, text: async () => "Not found" }));
}

const index: KnowledgeIndexEntry[] = [
  { id: "gaplogic", path: "projects/gaplogic", kind: "project", title: "Gaplogic", description: "Web y ecosistema digital de Gaplogic." },
  { id: "about", path: "about", kind: "about", title: "Sobre mí", description: "Perfil de Albert Verdu." },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SnapshotKnowledgeProvider", () => {
  it("returns a document for a known id", async () => {
    const provider = new SnapshotKnowledgeProvider(6000);
    const doc = await provider.getDocument("about");
    expect(doc).not.toBeNull();
    expect(doc?.id).toBe("about");
    expect(doc?.title).toBe("Sobre mí");
    expect(doc?.content.length).toBeGreaterThan(0);
  });

  it("returns null for an unknown id", async () => {
    const provider = new SnapshotKnowledgeProvider(6000);
    expect(await provider.getDocument("no-such-doc")).toBeNull();
  });

  it("trims content to docMaxChars", async () => {
    const provider = new SnapshotKnowledgeProvider(5);
    const doc = await provider.getDocument("about");
    expect(doc?.content.length).toBe(5);
  });

  it("exposes the generated index and excludes the index document", () => {
    const provider = new SnapshotKnowledgeProvider(6000);
    const entries = provider.index();
    expect(entries.some((entry) => entry.id === "index")).toBe(false);
    expect(entries.some((entry) => entry.id === "about")).toBe(true);
  });
});

describe("GitHubKnowledgeProvider", () => {
  const config = { repo: "verdulife/verdu", ref: "main", token: "", maxChars: 6000 };

  it("fetches the exact raw URL for the mapped path", async () => {
    const fetchMock = mockFetchOk("# Gaplogic\n\nContenido.");
    vi.stubGlobal("fetch", fetchMock);

    const provider = new GitHubKnowledgeProvider(index, config);
    const doc = await provider.getDocument("gaplogic");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://raw.githubusercontent.com/verdulife/verdu/main/projects/gaplogic",
      { headers: {} },
    );
    expect(doc).not.toBeNull();
    expect(doc?.title).toBe("Gaplogic");
    expect(doc?.content).toContain("Contenido.");
  });

  it("sends an Authorization header only when a token is set", async () => {
    const fetchMock = mockFetchOk("Contenido.");
    vi.stubGlobal("fetch", fetchMock);

    expect(await new GitHubKnowledgeProvider(index, { ...config, token: "" }).getDocument("about")).not.toBeNull();
    expect(fetchMock).toHaveBeenLastCalledWith("https://raw.githubusercontent.com/verdulife/verdu/main/about", {
      headers: {},
    });

    const fetchMockWithToken = mockFetchOk("Contenido.");
    vi.stubGlobal("fetch", fetchMockWithToken);
    expect(
      await new GitHubKnowledgeProvider(index, { ...config, token: "secret-token" }).getDocument("about"),
    ).not.toBeNull();
    expect(fetchMockWithToken).toHaveBeenLastCalledWith(
      "https://raw.githubusercontent.com/verdulife/verdu/main/about",
      { headers: { Authorization: "Bearer secret-token" } },
    );
  });

  it("returns null on a non-ok response", async () => {
    const fetchMock = mockFetchNotOk();
    vi.stubGlobal("fetch", fetchMock);
    const provider = new GitHubKnowledgeProvider(index, config);
    expect(await provider.getDocument("about")).toBeNull();
  });

  it("returns null for an unknown id without calling fetch", async () => {
    const fetchMock = mockFetchOk("Contenido.");
    vi.stubGlobal("fetch", fetchMock);
    const provider = new GitHubKnowledgeProvider(index, config);
    expect(await provider.getDocument("ghost")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("strips HTML comments and trims to maxChars", async () => {
    const body = "# Gaplogic\n\n<!-- DUDA: relación no documentada -->\n\nContenido completo para recortar." + "a".repeat(12000);
    const fetchMock = mockFetchOk(body);
    vi.stubGlobal("fetch", fetchMock);

    const provider = new GitHubKnowledgeProvider(index, { ...config, maxChars: 6000 });
    const doc = await provider.getDocument("gaplogic");

    expect(doc?.content).not.toContain("<!--");
    expect(doc?.content).toContain("# Gaplogic");
    expect(doc?.content.length).toBe(6000);

    const repeatProvider = new GitHubKnowledgeProvider(index, { ...config, maxChars: 6000 });
    const fetchMockRepeat = mockFetchOk("a".repeat(12000));
    vi.stubGlobal("fetch", fetchMockRepeat);
    const repeatDoc = await repeatProvider.getDocument("gaplogic");
    expect(repeatDoc?.content.length).toBe(6000);
  });
});

describe("createKnowledgeProvider", () => {
  it("returns a GitHub-backed provider when GITHUB_REPO is set", () => {
    const provider = createKnowledgeProvider({ GITHUB_REPO: "verdulife/verdu" });
    expect(provider).toBeInstanceOf(GitHubKnowledgeProvider);
  });

  it("returns the snapshot provider when GITHUB_REPO is empty", () => {
    const provider = createKnowledgeProvider({ GITHUB_REPO: "" });
    expect(provider).toBeInstanceOf(SnapshotKnowledgeProvider);
  });
});