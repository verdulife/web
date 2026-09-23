# Feature: thread-widgets — Widgets en el thread de IA

## Goal

Give the portfolio AI thread an **inline widget system**: the assistant response can contain rich, interactive inline elements (not just plain text), rendered in-flow with the text. First widget type: **link** (favicon + readable label with underline, hiding the raw URL). Second type planned and must be supported by the same protocol: **project** (card, not inline link).

## Problem / Why

The chat reply is currently streamed as plain text (`textContent` only, no HTML — model output is untrusted). The assistant already cites URLs (e.g. project links) as raw text, which is noise. We need a **reliable, extensible way for the model to invoke widgets** inline, usable both from the model reply and from code, with a single grammar that will cover future widget types.

## Scope

- Widget engine: token grammar → worker normalization (`reply` + `widgets`) → client renderer registry → inline DOM rendering (never `innerHTML`).
- Link widget: favicon + label (og:title → manifest name → `<title>` → domain) + underline; metadata resolved server-side (CORS-safe) and cached.
- Bare-URL auto-conversion in addition to explicit tokens.
- Typewriter integration: raw URLs are never visible while typing; the widget appears resolved at its position.
- Project widget: **out of scope to implement** now; the protocol must make it a drop-in later (`[[widget:project slug="…"]]`).

## Decisions (user-confirmed, 2026-09-23)

| Decision | Value |
| --- | --- |
| Metadata resolution | Worker endpoint `GET /api/link-meta?url=` (server-side fetch, no CORS) |
| Token grammar | Named key=value: `[[widget:link url="https://…"]]`, `[[widget:project slug="botanic"]]` |
| Bare URLs | Also auto-convert bare URLs to link widgets (worker-side) |
| Typewriter | Hide the raw URL while typing; pause at placeholder, resolve, insert mounted node |
| Invocation by code | Client registry API (`PortfolioWidgets.register(type, renderer)`) |
| Rendering | DOM nodes only, never `innerHTML`; monochrome accent (ink) per site redesign |

## App contract

### Token grammar (model writes inline in reply text)

```
[[widget:link url="https://example.com/path" label="Opcional"]]
[[widget:project slug="botanic"]]
```

- Delimiters `[[widget:…]]`, ASCII only. Attributes `key="value"`, space-separated. Type first after colon.
- Type allowlist (server-side): `link`, `project`. Unknown/malformed tokens are **dropped** (not echoed).
- `url` must parse as absolute http/https; `javascript:`/other schemes rejected. `label` optional, capped length.
- Limits (config): `MAX_WIDGETS = 4` per reply, `MAX_LABEL = 120` chars, `MAX_URL = 2000` chars. Excess tokens dropped in order.

### `POST /api/chat` response (normalization added)

Worker normalizes the model reply before returning:

```json
{
  "reply": "Texto de la respuesta… [[widget:0]] …sigue el texto",
  "widgets": [
    { "index": 0, "type": "link", "url": "https://example.com/path", "label": "Opcional" }
  ],
  "sources": ["…"]
}
```

- Valid tokens → replaced by canonical placeholder `[[widget:N]]` (N = order in `widgets`).
- **Bare URLs** in the reply text are also detected (worker-side, trailing-punctuation-aware) and converted to `link` widget placeholders, preserving exact position.
- Placeholders count must equal `widgets.length`; client trusts only this pair.

### `GET /api/link-meta?url=<encoded>`

- 200 → `{ "url": <canonical>, "domain": "example.com", "label": "…", "iconUrl": "…" }`
- 400 → invalid/malformed URL; 502 → upstream resolution failed.
- Resolution order for label: `og:title` → web app manifest `name` → `<title>` → `domain`.
- Icon: `<link rel="icon|shortcut icon|apple-touch-icon">` (relative resolved) → fallback `https://www.google.com/s2/favicons?domain=<domain>&sz=64`.
- Security: scheme http/https only; block private/loopback/link-local hosts (SSRF); fetch timeout (~5s), response size cap; in-memory cache (TTL 1h, LRU cap).

### Client engine (`public/scripts/conversation.js`, self-contained, no imports)

- `window.PortfolioWidgets = { register(type, renderer), renderReplyContainer(el, reply, widgets), resolveMeta(url) }`.
- Renderer contract: `(params, helpers) => HTMLElement` (async allowed; returns mounted node).
- Pipeline: split reply on `[[widget:N]]`, build text nodes + widget nodes in order; bare URLs never reach the client (worker already normalized).
- Link renderer: favicon `<img referrerpolicy="no-referrer" loading="lazy">` + label text + underline; wraps in `<a href target="_blank" rel="noopener noreferrer">`; `title` = raw URL.
- Metadata cache in client (Map, same session); loading state `.widget-link--loading`.
- Typewriter: type text segments char-by-char; at a placeholder, pause, resolve metadata, insert node, continue.
- Reduced motion: assemble full DOM synchronously.

## Tasks

| ID | Task | Checks |
| --- | --- | --- |
| W1 | Worker: `GET /api/link-meta` endpoint (fetch+parse, security, cache) | unit tests (mock fetch), `tsc`, wrangler smoke |
| W2 | Worker: widget token parser + bare-URL detection + normalization in chat response | unit tests (valid/invalid/limits/order), contract test in handler |
| W3 | Worker: system prompt documents widget syntax + rules | prompt test/readback; chat E2E |
| W4 | Client: widget engine (registry + placeholder splitter + `PortfolioWidgets` API) | `astro check`, manual E2E |
| W5 | Client: link renderer + `/api/link-meta` fetch + cache + loading state | manual E2E (og:title, manifest, title, fallback) |
| W6 | Client: typewriter integration (pause/resolve/insert, hide raw URL) | manual E2E + reduced-motion |
| W7 | CSS: `.widget-link` styles (inline, underline, favicon) in `global.css` | visual review on thread |
| W8 | Contract/docs + end-to-end verification (worker suite + chat smoke + browser) | all prior checks + manual E2E recorded |

## Progress

- [x] W1 — done: `GET /api/link-meta` endpoint (fetch+parse, security, cache).
- [ ] W2 … W8 pending. Next: W2.

## Verification evidence

W1 (worker vitest + `tsc --noEmit`):

- `cd worker && bun run check` → exit 0, no type errors.
- `cd worker && bun run test` → 6 files / 112 tests passed (84 pre-existing + 28 new in `tests/link-meta.test.ts`).
- New route behavior observed in tests: `GET /api/link-meta` → 200 with `{url,domain,label,iconUrl}` + CORS echo; 400 `invalid_url` for missing/non-fetchable `url`; 502 `link_meta_unavailable` on upstream failure. `resolveLinkMeta` throws typed `LinkMetaError` (`invalid_url` | `upstream_failed`).

## Next step

Confirm VCS strategy with user (work-unit commits on feature branch vs. working-tree only), then implement W1.