import { isFetchableUrl } from "./link-meta";

/**
 * Inline widget normalization for the assistant reply.
 *
 * The model may write structured `[[widget:type key="value"]]` tokens and/or
 * leave bare URLs in its reply text. This module validates every candidate and
 * rewrites the reply so it contains only canonical `[[widget:N]]` placeholders
 * (N = order of appearance), returning the validated widgets alongside.
 *
 * Grammar (ASCII only):
 *   [[widget:type key="value" key2="value2" ...]]
 * Type must be in the allowlist (`link`, `project`, `image`). `link` requires a
 * fetchable `url`; `project` requires a `slug`; `image` requires a site-relative
 * `src` (leading `/`, no `..` segment) and a descriptive `alt`. Any unknown
 * type, malformed token, or token missing a required field is dropped (not
 * echoed). Valid tokens/bare URLs beyond {@link MAX_WIDGETS} are also dropped.
 */

export interface Widget {
  /** 0-based order of appearance in the reply. */
  index: number;
  type: "link" | "project" | "image" | string;
  url?: string;
  label?: string;
  slug?: string;
  /** Site-relative image path (image widget). */
  src?: string;
  /** Required, descriptive alternative text (image widget). */
  alt?: string;
  /** Optional, truncated caption (image widget). */
  caption?: string;
}

export interface NormalizedReply {
  reply: string;
  widgets: Widget[];
}

/** Maximum number of widgets kept per reply (excess dropped). */
export const MAX_WIDGETS = 4;
/** Maximum length of a link `url` value. */
export const MAX_URL = 2000;
/** Maximum length of an optional `label` value (truncated). */
export const MAX_LABEL = 120;
/** Maximum length of a project `slug` value. */
export const MAX_SLUG = 64;
/** Maximum length of an image `src` path (longer rejected). */
export const MAX_IMAGE_SRC = 200;
/** Maximum length of image `alt`/`caption` text (alt drops, caption truncates). */
export const MAX_IMAGE_TEXT = 200;

/** Server-side allowlist of accepted widget types. */
export const WIDGET_TYPE_ALLOWLIST = ["link", "project", "image"] as const;

const TOKEN_OPEN = "[[widget:";
const PLACEHOLDER = (index: number): string => `[[widget:${index}]]`;

/** Trailing punctuation stripped from a bare URL before validation. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}>]+$/;

/**
 * A valid token body: type token, then zero or more `key="value"` attributes
 * (whitespace-separated, values may contain spaces), then optional trailing
 * whitespace. Anything else (extra junk) fails the match and drops the token.
 */
const TOKEN_BODY_RE = /^([a-z][a-z0-9-]*)((?:\s+[A-Za-z0-9_-]+="[^"]*")*)(\s*)$/;
const ATTR_RE = /([A-Za-z0-9_-]+)="([^"]*)"/g;

const SLUG_RE = /^[a-z0-9-]+$/;

/**
 * A site image path: exactly one leading `/`, then only ASCII URL-path
 * characters (`A-Za-z0-9._~/-`). Query strings, fragments, spaces and any
 * percent-encoding fall outside the class and are rejected verbatim.
 */
const SITE_IMAGE_RE = /^\/[A-Za-z0-9._~/-]*$/;

/**
 * True when `raw` is a valid site-relative image path: must start with a single
 * `/` (never `//`), contain only `[A-Za-z0-9._~/-]`, have no path segment that
 * is exactly `..`, and fit within {@link MAX_IMAGE_SRC}. Nothing is decoded:
 * the value is validated literally as given (e.g. `%20` is rejected).
 */
export function isSiteImagePath(raw: string): boolean {
  if (raw.length === 0 || raw.length > MAX_IMAGE_SRC) return false;
  if (!raw.startsWith("/") || raw.startsWith("//")) return false;
  if (!SITE_IMAGE_RE.test(raw)) return false;
  return !raw.split("/").some((segment) => segment === "..");
}

const ALLOWED_TYPES = new Set<string>(WIDGET_TYPE_ALLOWLIST);

/**
 * Locates the next inline widget token or bare URL at or after `from`.
 * A bare-URL endpoint is only considered when it is not part of a token that
 * comes first (tokens are consumed whole, so their inner URLs never leak out).
 */
function findNext(
  reply: string,
  from: number,
): { kind: "tag" | "url"; index: number } | null {
  const tag = reply.indexOf(TOKEN_OPEN, from);
  const urlRe = /https?:\/\//g;
  urlRe.lastIndex = from;
  const urlMatch = urlRe.exec(reply);
  const url = urlMatch ? urlMatch.index : -1;

  if (tag === -1) return url === -1 ? null : { kind: "url", index: url };
  if (url === -1) return { kind: "tag", index: tag };
  return tag < url ? { kind: "tag", index: tag } : { kind: "url", index: url };
}

/**
 * Parses a `[[widget:...]]` token starting at `start`. Returns the widget body
 * (without an index) plus the exclusive end of the consumed region, or null
 * widget when the token is invalid/dropped. On an unclosed token the rest of
 * the string is consumed (nothing echoed).
 */
function parseToken(
  reply: string,
  start: number,
): { widget: Omit<Widget, "index"> | null; consumed: number } {
  const closeIdx = reply.indexOf("]]", start + TOKEN_OPEN.length);
  if (closeIdx === -1) {
    // Missing closing brackets: the whole remainder is one malformed token.
    return { widget: null, consumed: reply.length };
  }
  const body = reply.slice(start + TOKEN_OPEN.length, closeIdx);
  const consumed = closeIdx + 2;

  const match = TOKEN_BODY_RE.exec(body);
  if (!match) return { widget: null, consumed };

  const type = match[1];
  if (!ALLOWED_TYPES.has(type)) return { widget: null, consumed };

  const attrs = new Map<string, string>();
  for (const attr of body.matchAll(ATTR_RE)) attrs.set(attr[1], attr[2]);

  if (type === "link") {
    const url = attrs.get("url") ?? "";
    if (url === "" || url.length > MAX_URL || !isFetchableUrl(url)) {
      return { widget: null, consumed };
    }
    const widget: Omit<Widget, "index"> = { type: "link", url };
    const label = (attrs.get("label") ?? "").trim();
    if (label !== "") widget.label = label.slice(0, MAX_LABEL);
    return { widget, consumed };
  }

  // type === "image": site-only paths; `src` + `alt` required, `caption` optional.
  if (type === "image") {
    const src = attrs.get("src") ?? "";
    const alt = (attrs.get("alt") ?? "").trim();
    if (src === "" || !isSiteImagePath(src) || alt === "" || alt.length > MAX_IMAGE_TEXT) {
      return { widget: null, consumed };
    }
    const widget: Omit<Widget, "index"> = { type: "image", src, alt };
    const caption = (attrs.get("caption") ?? "").trim();
    if (caption !== "") widget.caption = caption.slice(0, MAX_IMAGE_TEXT);
    return { widget, consumed };
  }

  // type === "project"
  const slug = attrs.get("slug") ?? "";
  if (slug === "" || slug.length > MAX_SLUG || !SLUG_RE.test(slug)) {
    return { widget: null, consumed };
  }
  return { widget: { type: "project", slug }, consumed };
}

/**
 * Reads a bare URL starting at `start` through the first whitespace, quote,
 * `<>`, or `]]`, then strips repeated trailing punctuation. Returns the URL and
 * the exclusive end of the raw matched region, or `url === null` when the
 * candidate is not a fetchable URL (and must be preserved as plain text).
 */
function extractBareUrl(
  reply: string,
  start: number,
): { url: string | null; start: number; rawEnd: number } {
  const urlRe = /https?:\/\/[^\s"<>]*/y;
  urlRe.lastIndex = start;
  const match = urlRe.exec(reply);
  if (!match) return { url: null, start, rawEnd: start };

  let text = match[0];
  let rawEnd = urlRe.lastIndex;

  const closeBracket = text.indexOf("]]");
  if (closeBracket !== -1) {
    text = text.slice(0, closeBracket);
    rawEnd = start + closeBracket;
  }

  const trimmed = text.replace(TRAILING_PUNCTUATION, "");
  if (trimmed === "" || trimmed.length > MAX_URL || !isFetchableUrl(trimmed)) {
    return { url: null, start, rawEnd };
  }
  return { url: trimmed, start, rawEnd };
}

/**
 * Normalizes a raw assistant reply into canonical `[[widget:N]]` placeholders
 * plus the validated widget list. Tokens and bare URLs are processed in order
 * of appearance; only the first {@link MAX_WIDGETS} valid candidates become
 * widgets. Invalid or excessive candidates are dropped from the reply text
 * (bare URLs that are not fetchable are preserved verbatim as plain text).
 */
export function normalizeWidgets(reply: string): NormalizedReply {
  const widgets: Widget[] = [];
  let out = "";
  let pos = 0;

  while (pos < reply.length) {
    const next = findNext(reply, pos);
    if (next === null) {
      out += reply.slice(pos);
      break;
    }

    // Emit the plain text that precedes this candidate verbatim.
    out += reply.slice(pos, next.index);
    pos = next.index;

    if (next.kind === "tag") {
      const parsed = parseToken(reply, next.index);
      if (parsed.widget !== null && widgets.length < MAX_WIDGETS) {
        const widget: Widget = { ...parsed.widget, index: widgets.length };
        widgets.push(widget);
        out += PLACEHOLDER(widget.index);
      }
      // Invalid, unknown, or beyond the cap: the token is dropped silently.
      pos = parsed.consumed;
      continue;
    }

    // Bare URL.
    const extracted = extractBareUrl(reply, next.index);
    if (extracted.url === null) {
      // Not a fetchable URL: preserve the text exactly as written.
      out += reply.slice(next.index, extracted.rawEnd);
      pos = extracted.rawEnd;
      continue;
    }
    const trimmedEnd = extracted.start + extracted.url.length;
    if (widgets.length < MAX_WIDGETS) {
      const widget: Widget = {
        index: widgets.length,
        type: "link",
        url: extracted.url,
      };
      widgets.push(widget);
      out += PLACEHOLDER(widget.index);
    }
    // Valid URL beyond the cap is dropped; trailing punctuation stays.
    pos = trimmedEnd;
  }

  return { reply: out, widgets };
}