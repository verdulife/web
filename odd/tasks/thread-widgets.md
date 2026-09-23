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
| W2 | Worker: widget token parser + bare-URL detection + normalization in chat response | unit tests (valid/invalid/limits/order), contract test in handler || W3 | Worker: system prompt documents widget syntax + rules | prompt test/readback; chat E2E |
| W4 | Client: widget engine (registry + placeholder splitter + `PortfolioWidgets` API) | `astro check`, manual E2E |
| W5 | Client: link renderer + `/api/link-meta` fetch + cache + loading state | manual E2E (og:title, manifest, title, fallback) |
| W6 | Client: typewriter integration (pause/resolve/insert, hide raw URL) | manual E2E + reduced-motion |
| W7 | CSS: `.widget-link` styles (inline, underline, favicon) in `global.css` | visual review on thread |
| W8 | Contract/docs + end-to-end verification (worker suite + chat smoke + browser) | all prior checks + manual E2E recorded |

## Image widget — second type (added 2026-09-23)

Second widget type on the same protocol, user-requested: show a site image (example: asking about the profile loads `/verdu.jpg`).

| Decision | Value |
| --- | --- |
| Image origin | Site-relative paths only (`/verdu.jpg`), validated by shape (leading `/`, no `..`, no `//`) |
| Presentation | Block figure inside the thread: max width ~78%, subtle border/radius, optional mono uppercase caption |
| Token | `[[widget:image src="/verdu.jpg" alt="Albert Verdu" caption="Opcional"]]` — `src` + `alt` required, `caption` optional (all capped 200) |

Tasks:

| ID | Task | Checks |
| --- | --- | --- |
| [x] I1 | Worker: `image` type in allowlist + `isSiteImagePath` validation (`src`, `alt`, `caption`) | widget unit tests (valid/invalid/escaping/absolute URL rejected) |
| [x] I2 | Worker: prompt documents the image token and when to use it | prompt readback + live smoke |
| [x] I3 | Knowledge: `about.md` mentions the available portrait asset; regenerate snapshot | `worker:gen` + diff (commit 39f5382) |
| [x] I4 | Client: `image` renderer (figure span + img + optional caption) | engine harness (34/34) + `astro check` (commit d56eaa8) |
| [x] I5 | CSS: `.widget-image` figure styles | visual review (commit d56eaa8) |
| [x] I6 | Verification: worker suite + live smoke (ask about the profile) | all prior checks + smoke (commit 17e65ca + final verify) |

Image widget progress (verified):

- [x] I1 — done: `image` in allowlist + `isSiteImagePath` validation — `cd worker && bun run check` → exit 0 (`tsc --noEmit`, no type errors); `cd worker && bun run test` → 7 files / 158 tests pass (138 prior + 20 new, all in `tests/widgets.test.ts`, 25 → 45).
- [x] I2 — done: prompt documents the image token — prompt readback confirms the `[[widget:image src="/verdu.jpg" alt="descripción" caption="Opcional"]]` bullet in WIDGET_NOTE with the site-relative-only rule, mandatory `alt`, and when to use it (portrait asset).
- [x] I3 — done: `about.md` portraits line factual + snapshot regenerated (commit 39f5382; later reworded in 17e65ca to avoid the model parroting an instruction).
- [x] I4 — done: client `image` renderer — `renderImage` registered at module scope (`window.PortfolioWidgets.register("image", renderImage)`) next to the link renderer. Builds `<span class="widget-image">` → `<img class="widget-image-img" loading="lazy" decoding="async">` + optional `<span class="widget-image-caption">` (textContent only); wrapper is a phrasing-level span (valid inside `.ask-paragraph` `<p>`), CSS figure styling in I5. Client-side re-validation mirrors worker `isSiteImagePath`: src must be non-empty, exactly one leading `/` (never `//`), chars `[A-Za-z0-9._~/-]`, no `..` segment; alt must be non-empty after trim; alt/caption truncated defensively to 200. Invalid input → `null` (placeholder dropped). Evidence: `node --check` OK; `astro check` 0/0/0; 1× `register("image"`; DOM-stub harness 34/34.
- [x] I5 — done: `.widget-image` block figure (width min(78%, 34rem), 1px line border, 4px radius, centered; caption mono uppercase muted).
- [x] I6 — done: automated verify green (7 files / 158 tests, tsc clean, astro check/build 0 errors, greps ok, 4 I-commits in order, working tree clean except pre-existing `undefined/`); live smoke: asking the profile returns `[[widget:0]]` + validated `{type:"image", src:"/verdu.jpg", alt, caption}` — end-to-end works. Mote: non-blocking pre-existing `[WARN] [glob-loader] Duplicate id "about"` observed during build; out of scope.

## Progress

- [x] W1 — done: `GET /api/link-meta` endpoint (fetch+parse, security, cache).
- [x] W2 — done: widget token parser + bare-URL detection + normalization in chat response.
- [x] W3 — done: system prompt documents widget syntax + rules.
- [x] W4 — done: client widget engine (registry + placeholder splitter + `PortfolioWidgets` API) — implemented together with W6 (same streaming path).
- [x] W6 — done: client typewriter integration (pause/resolve/insert, hide raw URL) — commit c6b56cb.
- [x] W5 — done: client link renderer + `/api/link-meta` fetch + session cache — commit eb4ad8d.
- [x] W7 — done: CSS `.widget-link` styles (inline-flex, label underline, 16px favicon, monochrome) — commit e945906.
- [x] W8 — done: contract/docs + end-to-end verification — commit (this unit).

## Verification evidence

W8 (gentle-ai-verify + live smoke):

- `cd worker && bun run check` → exit 0; `bun run test` → 7 files / 138 tests pass.
- `bun run check` (root) → 0 errors/0 warnings/0 hints (18 files); `bun run build` → exit 0, 16 pages.
- Greps: `innerHTML` in conversation.js only in the pre-existing security comment; 1× `register("link")`; `setLinkMetaResolver` definition + init wiring; `.widget-link` rules in global.css; WIDGET_NOTE defined + appended.
- Live smoke (wrangler dev, remote AI): `/api/link-meta` resolved og:title (“Astro”), `<title>` (GitHub “verdulife - Overview”), 400 on `javascript:`/empty, 502 graceful on bot-blocked (LinkedIn). `/api/chat` returned `[[widget:0]]/[[widget:1]]` + validated `widgets` (LinkedIn, GitHub) — model emits WIDGET_NOTE tokens, worker normalizes, contract holds end-to-end.
- Browser visual E2E: pending user confirmation on localhost:4321.

W3 (prompt, verified by gentle-ai-verify):

- `cd worker && bun run check` → exit 0; `bun run test` → 7 files / 138 tests pass (W1/W2 regression green).
- `buildSystemPrompt` joins `PERSONA_INTRO → SCOPE_RULES → CONOCIMIENTO DISPONIBLE → index → TOOL_NOTE → WIDGET_NOTE`; WIDGET_NOTE documents both token forms, inline placement rule, and the 4-widget cap. No test references `prompts` symbols; no breakage.

W2 (worker vitest + `tsc --noEmit`):

- `cd worker && bun run check` → exit 0, no type errors.
- `cd worker && bun run test` → 7 files / 138 tests passed (112 prior + 26 new: 25 in `tests/widgets.test.ts` + 1 contract case in `tests/handler.test.ts`).
- `normalizeWidgets` behavior observed in tests: valid link/project tokens converted to `[[widget:N]]`; unknown type, malformed tokens (missing close, junk inside, missing url), non-http URL schemes, invalid slugs, and slug-over-cap dropped; bare URLs converted with trailing punctuation stripped and kept as text; non-fetchable bare URLs preserved as plain text; token-before-URL ordering indexes 0,1; MAX_WIDGETS=4 cap with the 5th widget dropped and placeholder count == widgets.length; plain text untouched; handler contract case returns `{ reply, widgets, sources }`.

W1 (worker vitest + `tsc --noEmit`):

- `cd worker && bun run check` → exit 0, no type errors.
- `cd worker && bun run test` → 6 files / 112 tests passed (84 pre-existing + 28 new in `tests/link-meta.test.ts`).
- New route behavior observed in tests: `GET /api/link-meta` → 200 with `{url,domain,label,iconUrl}` + CORS echo; 400 `invalid_url` for missing/non-fetchable `url`; 502 `link_meta_unavailable` on upstream failure. `resolveLinkMeta` throws typed `LinkMetaError` (`invalid_url` | `upstream_failed`).

## Next step

Implement the image widget (I1 → I6); link widget closed and committed.