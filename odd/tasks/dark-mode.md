# Feature: dark-mode — Versión oscura con selector de tema

## Goal

Dark version of the whole site (currently light-only by design). Default follows the system (`prefers-color-scheme`); a manual override is available via three monochrome buttons (AUTO / CLARO / OSCURO) placed above the menu footer. The choice persists (localStorage) and applies before first paint (no FOUC).

## Decisions (user-confirmed, 2026-09-23)

| Decision | Value |
| --- | --- |
| Default | Follow system (`prefers-color-scheme: dark`) |
| Override | 3 mono uppercase buttons AUTO / CLARO / OSCURO above `.site-menu-footer`; active one highlighted in ink |
| Persistence | `localStorage["verdu-theme"]` = auto \| light \| dark; pre-paint head script sets `data-theme` on `<html>` |
| Palette | Warm dark, same family as the paper/ink identity: paper→#131110, paper-deep→#1d1a17, ink→#e7e2d8, ink-muted→#98917f, line→#3b362d, accent=ink, new `--color-surface` (white cards) → dark #1f1c19 |

## Architecture

- Tokens stay in `@theme` (light defaults). Overrides in plain CSS: `@media (prefers-color-scheme: dark)` applies to `:root[data-theme="auto"]` (and no attr); `:root[data-theme="dark"]` forced dark; `:root[data-theme="light"]` forced light (wins over system). Attribute blocks come AFTER the media block so forced modes win by cascade.
- New token `--color-surface` (light #ffffff, dark #1f1c19) replaces the hardcoded `#ffffff` in `.widget-image` and `.widget-card`.
- `color-scheme: dark` set alongside forced/system dark for native scrollbars/inputs.
- Mask gradients and shadows keep black (mask unrelated; shadows fine on dark).

## Tasks

| ID | Task | Checks |
| --- | --- | --- |
| D1 | CSS: dark token overrides (media + data-theme scopes), surface token + replacements, color-scheme | astro check/build; token audit grep |
| D2 | Layout: pre-paint theme script + AUTO/CLARO/OSCURO buttons above menu footer + wiring + persistence + active state | astro check/build; harness for mode resolver |
| D3 | Verification: system-follow, forced override, persistence, menu visual, widget cards in dark | manual E2E + visual review |

## Progress

- [x] D1 — CSS dark-mode tokens done: `--color-surface` added to `@theme`; theming block (media prefers-color-scheme + `data-theme` scopes, plain CSS after `@theme`) added; hardcoded `#ffffff` swapped to `var(--color-surface)` in `.widget-image`/`.widget-card`; masks/shadows untouched. Evidence: `bun run check` exit 0; `bun run build` exit 0; grep confirms `--color-surface` (defined + used), `:root[data-theme="dark"]`, media block and `color-scheme` in built CSS.
- [x] D2 — Layout wiring done: pre-paint head script (`is:inline`) resolves `localStorage["verdu-theme"]` → `data-theme` on `<html>`; AUTO/CLARO/OSCURO row inside `.site-menu-inner` above the footer; sibling inline script persists clicks, applies `data-theme`, syncs `aria-pressed`, keeps menu open; menu-scoped CSS added. Evidence: `bun run check` exit 0; `bun run build` exit 0; dist HTML contains the three theme buttons + pre-paint script; mode resolver harness: stored light→light, dark→dark, null/**other**→auto.
- [ ] D3 — manual E2E + visual review pending.