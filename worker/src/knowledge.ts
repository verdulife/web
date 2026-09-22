import type { KnowledgeDocument, KnowledgeIndexEntry } from "./types";
import { limitsFromEnv, type LimitsEnvShape } from "./limits";
import indexEntriesJson from "./generated/knowledge-index.json";
import snapshotJson from "./generated/knowledge-snapshot.json";

interface SnapshotDocument {
  id: string;
  title: string;
  description: string;
  content: string;
}

interface SnapshotFile {
  documents: SnapshotDocument[];
}

const INDEX = indexEntriesJson as KnowledgeIndexEntry[];
const SNAPSHOT_DOCUMENTS = (snapshotJson as SnapshotFile).documents;
const SNAPSHOT_BY_ID = new Map<string, SnapshotDocument>(
  SNAPSHOT_DOCUMENTS.map((doc) => [doc.id, doc] as const),
);

/** Allowed logical id -> knowledge path, derived from the generated index. */
export const ALLOWLIST: ReadonlyMap<string, string> = new Map(
  INDEX.map((entry) => [entry.id, entry.path] as const),
);

export interface KnowledgeProvider {
  getDocument(id: string): Promise<KnowledgeDocument | null>;
  index(): KnowledgeIndexEntry[];
}

/** Serves the bundled snapshot of knowledge/*.md (local dev / no repo configured). */
export class SnapshotKnowledgeProvider implements KnowledgeProvider {
  constructor(private readonly maxChars: number) {}

  async getDocument(id: string): Promise<KnowledgeDocument | null> {
    const doc = SNAPSHOT_BY_ID.get(id);
    if (!doc) return null;
    return { id: doc.id, title: doc.title, content: doc.content.slice(0, this.maxChars) };
  }

  index(): KnowledgeIndexEntry[] {
    return INDEX;
  }
}

interface GitHubConfig {
  repo: string;
  ref: string;
  token: string;
  maxChars: number;
}

/** Fetches knowledge documents from raw.githubusercontent.com (production path). */
export class GitHubKnowledgeProvider implements KnowledgeProvider {
  private readonly paths: Map<string, string>;

  constructor(
    private readonly indexEntries: KnowledgeIndexEntry[],
    private readonly config: GitHubConfig,
  ) {
    this.paths = new Map(indexEntries.map((entry) => [entry.id, entry.path] as const));
  }

  async getDocument(id: string): Promise<KnowledgeDocument | null> {
    const path = this.paths.get(id);
    if (!path) return null;
    const url = `https://raw.githubusercontent.com/${this.config.repo}/${this.config.ref}/${path}`;
    const headers: Record<string, string> = {};
    if (this.config.token !== "") headers.Authorization = `Bearer ${this.config.token}`;

    const response = await fetch(url, { headers });
    if (!response.ok) return null;
    const body = await response.text();
    const content = stripLeadingFrontmatter(body.replace(/<!--[\s\S]*?-->/g, ""))
      .trim()
      .slice(0, this.config.maxChars);
    const title = this.indexEntries.find((entry) => entry.id === id)?.title ?? id;
    return { id, title, content };
  }

  index(): KnowledgeIndexEntry[] {
    return this.indexEntries;
  }
}

/**
 * Removes a leading YAML frontmatter block (between the first two "---" fences)
 * so raw GitHub content matches the bundled snapshot, which strips it at
 * generation time.
 */
function stripLeadingFrontmatter(text: string): string {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return text;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end === -1) return text;
  return lines.slice(end + 1).join("\n");
}

export interface KnowledgeEnvShape extends LimitsEnvShape {
  GITHUB_REPO?: string;
  GITHUB_REF?: string;
  GITHUB_TOKEN?: string;
}

/** GitHub-backed provider when a repo is configured; bundled snapshot otherwise. */
export function createKnowledgeProvider(env: KnowledgeEnvShape): KnowledgeProvider {
  const maxChars = limitsFromEnv(env).docMaxChars;
  const repo = env.GITHUB_REPO?.trim() ?? "";
  if (repo !== "") {
    return new GitHubKnowledgeProvider(INDEX, {
      repo,
      ref: env.GITHUB_REF?.trim() || "main",
      token: env.GITHUB_TOKEN ?? "",
      maxChars,
    });
  }
  return new SnapshotKnowledgeProvider(maxChars);
}