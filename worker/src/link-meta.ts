/**
 * Server-side link metadata resolution for the inline link widget.
 *
 * Runs on the Cloudflare Worker runtime (workerd), which has no DOM: all HTML
 * extraction is regex/string based. The worker fetches the target page so the
 * browser never has to deal with CORS, enforces an SSRF allowlist on the host,
 * caps read size and time, and caches successful resolutions in memory.
 */

export interface LinkMeta {
  /** Canonical (absolute) href of the parsed URL. */
  url: string;
  /** Hostname of the URL, used as a stable label fallback. */
  domain: string;
  /** Human-readable label: og:title > manifest name > <title> > domain. */
  label: string;
  /** Absolute icon URL, falling back to Google's favicon service. */
  iconUrl: string;
  /** Open Graph title (capped), when the page publishes one. */
  ogTitle?: string;
  /** Open Graph description (capped), or the meta description fallback. */
  ogDescription?: string;
  /** Absolute http(s) og:image URL (capped), when the page publishes one. */
  ogImage?: string;
  /** Open Graph site name (capped), when the page publishes one. */
  ogSiteName?: string;
}

/**
 * Error raised by URL validation or upstream resolution. `invalid_url` maps to a
 * 400 at the route; `upstream_failed` maps to a 502.
 */
export class LinkMetaError extends Error {
  readonly code: "invalid_url" | "upstream_failed";

  constructor(code: "invalid_url" | "upstream_failed", message: string) {
    super(message);
    this.name = "LinkMetaError";
    this.code = code;
    // `instanceof` still works across transpiled targets when set explicitly.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const FETCH_TIMEOUT_MS = 5000;
const MAX_DOC_BYTES = 1_500_000;
const MAX_LABEL_CHARS = 120;
const MAX_OG_TITLE_CHARS = 200;
const MAX_OG_DESCRIPTION_CHARS = 400;
const MAX_OG_SITE_NAME_CHARS = 100;
const MAX_OG_IMAGE_CHARS = 2000;
const MAX_CACHE_ENTRIES = 100;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

interface CacheEntry {
  meta: LinkMeta;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Clears the module-level resolution cache. Used by tests. */
export function clearLinkMetaCache(): void {
  cache.clear();
}

async function fetchText(fetchImpl: typeof fetch, url: string): Promise<string> {
  const response = await fetchImpl(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new LinkMetaError(
      "upstream_failed",
      `Upstream ${url} responded with status ${response.status}`,
    );
  }
  const text = await response.text();
  // Cap the read so a malicious oversized page cannot exhaust memory.
  return text.slice(0, MAX_DOC_BYTES);
}

/* ------------------------------------------------------------------------- */
/* URL validation (SSRF allowlist)                                            */
/* ------------------------------------------------------------------------- */

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    return n >= 0 && n <= 255 ? n : null;
  });
  if (octets.some((n) => n === null)) return false;
  const [a, b] = octets as number[];
  if (a === 0 && b === 0 && octets[2] === 0 && octets[3] === 0) return true; // 0.0.0.0
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  return false;
}

export function isPublicHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const bare = host.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host === "[::1]" || bare === "::1") return false;
  if (isPrivateIpv4(host)) return false;
  if (host.endsWith(".internal") || host.endsWith(".local")) return false;
  return true;
}

/** True only for absolute http/https URLs with no credentials and a public host. */
export function isFetchableUrl(raw: string): boolean {
  return parseFetchableUrl(raw) !== null;
}

function parseFetchableUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // Embedded credentials are a phishing/abuse vector; reject them outright.
  if (url.username !== "" || url.password !== "") return null;
  if (!isPublicHost(url.hostname)) return null;
  return url;
}

/* ------------------------------------------------------------------------- */
/* HTML extraction helpers (regex only — no DOM in workerd)                   */
/* ------------------------------------------------------------------------- */

function extractAttr(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i"));
  return match ? match[2] : null;
}

/** First `content` of a `<meta property="og:title">` tag, or null. */
export function extractOgTitle(html: string): string | null {
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    const property = extractAttr(tag[0], "property");
    if (property && property.toLowerCase() === "og:title") {
      const content = extractAttr(tag[0], "content");
      if (content != null) return content;
    }
  }
  return null;
}

/**
 * `content` of the first `<meta property="…">` tag matching `property`
 * (attribute-order independent, case-insensitive; e.g. "og:description"). The
 * value is entity-decoded with whitespace collapsed; null when absent.
 */
export function extractOgProperty(html: string, property: string): string | null {
  const needle = property.toLowerCase();
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    const prop = extractAttr(tag[0], "property");
    if (prop != null && prop.toLowerCase() === needle) {
      const content = extractAttr(tag[0], "content");
      if (content != null) return tidyText(content);
    }
  }
  return null;
}

/** `content` of the first `<meta name="description">` tag (og:description fallback). */
export function extractMetaDescription(html: string): string | null {
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    const name = extractAttr(tag[0], "name");
    if (name != null && name.toLowerCase() === "description") {
      const content = extractAttr(tag[0], "content");
      if (content != null) return tidyText(content);
    }
  }
  return null;
}

/** Text of the first `<title>` tag, or null. */
export function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? match[1] : null;
}

/** `href` of the first `link rel="manifest"`, or null. */
export function extractManifestHref(html: string): string | null {
  return linkHrefForRel(html, new Set(["manifest"]));
}

/** `href` of the first icon link (rel icon / shortcut icon / apple-touch-icon). */
export function extractIconHref(html: string): string | null {
  return linkHrefForRel(html, new Set(["icon", "shortcut icon", "apple-touch-icon"]));
}

function linkHrefForRel(html: string, rels: Set<string>): string | null {
  for (const tag of html.matchAll(/<link\b[^>]*>/gi)) {
    const raw = extractAttr(tag[0], "rel");
    if (raw == null) continue;
    const values = raw.toLowerCase().split(/\s+/).join(" ");
    if (rels.has(values) || values.startsWith("icon ")) {
      const href = extractAttr(tag[0], "href");
      if (href != null) return href;
    }
  }
  return null;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  ndash: "–",
  mdash: "—",
};

/** Decodes common HTML entities (named and numeric) in a text string. */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const hex = entity[1] === "x" || entity[1] === "X";
      const code = hex ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff) {
        return String.fromCodePoint(code);
      }
      return match;
    }
    return NAMED_ENTITIES[entity] ?? match;
  });
}

/** Entity-decodes a string and collapses runs of whitespace (tags preserved). */
function tidyText(text: string): string {
  return decodeHtmlEntities(text).replace(/\s+/g, " ").trim();
}

/** Resolves an href (possibly relative) against a base URL, or null on failure. */
export function resolveHref(href: string, baseUrl: string): URL | null {
  try {
    return new URL(href, baseUrl);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------------- */
/* Label / icon building                                                      */
/* ------------------------------------------------------------------------- */

const ICON_FALLBACK = (domain: string): string =>
  `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;

function sanitizeLabel(text: string | null | undefined): string | null {
  return sanitizeText(text, MAX_LABEL_CHARS);
}

/** Collapses whitespace, strips markup and caps a string; null when empty. */
function sanitizeText(text: string | null | undefined, maxChars: number): string | null {
  if (text == null) return null;
  const stripped = decodeHtmlEntities(text).replace(/<[^>]*>/g, "");
  const collapsed = stripped.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  return collapsed.slice(0, maxChars);
}

function resolveIcon(pageUrl: string, domain: string, html: string): string {
  const iconHref = extractIconHref(html);
  if (iconHref) {
    const resolved = resolveHref(iconHref, pageUrl);
    if (resolved && (resolved.protocol === "http:" || resolved.protocol === "https:")) {
      return resolved.toString();
    }
  }
  return ICON_FALLBACK(domain);
}

/**
 * Resolves an og:image value to an absolute http(s) URL, dropping values with
 * non-http(s) schemes (e.g. data:) or exceeding the length cap.
 */
function resolveOgImage(raw: string | null | undefined, pageUrl: string): string | null {
  if (raw == null) return null;
  const resolved = resolveHref(raw, pageUrl);
  if (resolved == null) return null;
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
  const value = resolved.toString();
  if (value.length > MAX_OG_IMAGE_CHARS) return null;
  return value;
}

/** Extracts the `name` field of a web app manifest (JSON object). */
function manifestName(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { name?: unknown };
    return typeof parsed.name === "string" ? parsed.name : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------------- */
/* Public resolution                                                          */
/* ------------------------------------------------------------------------- */

/**
 * Resolves link metadata for a raw URL. Throws `LinkMetaError` with code
 * `invalid_url` for non-fetchable input and `upstream_failed` for network or
 * parse failures. Successful results are cached (TTL 1h, ~100 entries). In
 * addition to the stable fields, optional Open Graph fields (title,
 * description, image, site name) are extracted for the project card.
 */
export async function resolveLinkMeta(
  rawUrl: string,
  deps: { fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<LinkMeta> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());

  const parsed = parseFetchableUrl(rawUrl);
  if (!parsed) throw new LinkMetaError("invalid_url", `No se puede obtener "${rawUrl}"`);

  const key = parsed.href;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now()) {
    return cached.meta;
  }

  let html: string;
  try {
    html = await fetchText(fetchImpl, parsed.href);
  } catch (error) {
    throw new LinkMetaError(
      "upstream_failed",
      `No se pudo obtener la página ${parsed.href}`,
    );
  }

  const domain = parsed.hostname;
  let label = sanitizeLabel(extractOgTitle(html));

  if (!label) {
    // Label priority: og:title → manifest name → <title> → hostname.
    const manifestHref = extractManifestHref(html);
    if (manifestHref) {
      const manifestUrl = resolveHref(manifestHref, parsed.href);
      if (manifestUrl) {
        try {
          const manifestText = await fetchText(fetchImpl, manifestUrl.toString());
          label = sanitizeLabel(manifestName(manifestText));
        } catch {
          // A failing manifest must not fail the whole resolution; fall through.
          label = null;
        }
      }
    }
  }
  if (!label) label = sanitizeLabel(extractTitle(html));
  if (!label) label = domain;

  // Optional OG fields; each is omitted when the page does not publish it.
  const ogTitle = sanitizeText(extractOgProperty(html, "og:title"), MAX_OG_TITLE_CHARS);
  const ogDescription = sanitizeText(
    extractOgProperty(html, "og:description") ?? extractMetaDescription(html),
    MAX_OG_DESCRIPTION_CHARS,
  );
  const ogImage = resolveOgImage(extractOgProperty(html, "og:image"), parsed.href);
  const ogSiteName = sanitizeText(extractOgProperty(html, "og:site_name"), MAX_OG_SITE_NAME_CHARS);

  const meta: LinkMeta = {
    url: parsed.href,
    domain,
    label,
    iconUrl: resolveIcon(parsed.href, domain, html),
  };
  if (ogTitle != null) meta.ogTitle = ogTitle;
  if (ogDescription != null) meta.ogDescription = ogDescription;
  if (ogImage != null) meta.ogImage = ogImage;
  if (ogSiteName != null) meta.ogSiteName = ogSiteName;

  cache.set(key, { meta, expiresAt: now() + CACHE_TTL_MS });
  // Simple insertion-order eviction beyond the cap.
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }

  return meta;
}