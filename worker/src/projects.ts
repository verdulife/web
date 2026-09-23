import type { KnowledgeIndexEntry } from "./types";

/**
 * A doc-level project card for the `[[widget:projects]]` scroller: the
 * knowledge entry's slug (document id), canonical title, description and, when
 * present, the project URL. No live OG enrichment: the scroller stays cheap and
 * the single-project card (`GET /api/project?slug=`) already fetches media on
 * demand.
 */
export interface ProjectListItem {
  slug: string;
  title: string;
  description: string;
  url?: string;
}

/**
 * Reads the runtime `kind` field of a knowledge index entry. `kind` is present
 * on every entry of the generated `knowledge-index.json` (e.g. "project") but
 * is not declared on `KnowledgeIndexEntry`; the intersection narrows access to
 * the actual data without widening the public index contract.
 */
function kindOf(entry: KnowledgeIndexEntry): string | undefined {
  return (entry as KnowledgeIndexEntry & { kind?: string }).kind;
}

/**
 * Maps knowledge index entries to the projects list: only entries whose kind is
 * "project" are kept, each becomes `{ slug: id, title, description, url? }`
 * (an empty `url` is normalized to `undefined`), and the result is sorted by
 * title using the Spanish locale. Pure and synchronous: no network, no cache.
 */
export function listProjectCards(entries: KnowledgeIndexEntry[]): ProjectListItem[] {
  return entries
    .filter((entry) => kindOf(entry) === "project")
    .map((entry) => ({
      slug: entry.id,
      title: entry.title,
      description: entry.description,
      url: entry.url || undefined,
    }))
    .sort((a, b) => a.title.localeCompare(b.title, "es"));
}