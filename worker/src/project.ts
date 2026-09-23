/**
 * Project card resolution for the inline project widget and GET /api/project.
 *
 * A card is the knowledge document's canonical title/description plus live
 * Open Graph media (image, site name) from the project's canonical URL. OG
 * enrichment is best-effort: any resolution failure keeps the doc-only card.
 */

import type { KnowledgeIndexEntry } from "./types";
import { resolveLinkMeta } from "./link-meta";

export interface ProjectCard {
  /** Knowledge project id (widget token slug). */
  slug: string;
  /** Canonical title from the knowledge document. */
  title: string;
  /** Canonical description from the knowledge document. */
  description: string;
  /** Canonical project URL when the knowledge entry has one. */
  url?: string;
  /** Hostname of the project URL (live OG). */
  domain?: string;
  /** Absolute og:image URL (live OG), when available. */
  image?: string;
  /** og:site_name, falling back to the domain (live OG). */
  siteName?: string;
  /** Favicon URL resolved for the project page (live OG). */
  iconUrl?: string;
}

export interface ResolveProjectCardDeps {
  entries: KnowledgeIndexEntry[];
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_CACHE_ENTRIES = 50;

interface CacheEntry {
  card: ProjectCard;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Clears the module-level project card cache. Used by tests. */
export function clearProjectCache(): void {
  cache.clear();
}

/**
 * Resolves the card for a knowledge project id. Returns null when no entry
 * matches; otherwise a card with the doc fields, enriched with live OG media
 * when the entry has a URL. OG failures are non-fatal (doc-only card).
 */
export async function resolveProjectCard(
  slug: string,
  deps: ResolveProjectCardDeps,
): Promise<ProjectCard | null> {
  const now = deps.now ?? (() => Date.now());
  const entry = deps.entries.find((candidate) => candidate.id === slug);
  if (!entry) return null;

  const cached = cache.get(slug);
  if (cached && cached.expiresAt > now()) return cached.card;

  const card: ProjectCard = {
    slug: entry.id,
    title: entry.title,
    description: entry.description,
    url: entry.url || undefined,
  };

  if (entry.url) {
    try {
      const meta = await resolveLinkMeta(entry.url, { fetchImpl: deps.fetchImpl, now });
      card.domain = meta.domain;
      card.iconUrl = meta.iconUrl;
      card.image = meta.ogImage;
      card.siteName = meta.ogSiteName ?? meta.domain;
    } catch (error) {
      // OG failure is non-fatal: keep the doc-only card.
      console.warn(
        `[project] og resolution failed for "${slug}"`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  // Cache every resolved card (doc-only included) so repeated requests are cheap.
  cache.set(slug, { card, expiresAt: now() + CACHE_TTL_MS });
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }

  return card;
}