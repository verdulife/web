# Feature: guide-mode — Modo guía determinista (fallback del chat)

## Goal

When the chat's LLM is unavailable — free-tier quota exhausted, 5xx, timeout — `/api/chat` **never dies**: it answers with curated, deterministic content (no LLM, no quota, no tools) using the existing `reply + widgets` contract, plus `mode: "guide"` and `suggestions`. The front shows a discreet notice and offers suggestion chips. The normal path (`mode` absent) is byte-identical to today's contract.

## Problem / Why

Free providers measured so far: Workers AI (10k neurons/day, exhausted quickly) and Gemini free (~20 req/window). Today when they run out, the chat returns 502 "Servicio no disponible" (`AI_UNAVAILABLE_ERROR`). User decision (2026-09-29): **no paid AI for the portfolio**. Guide mode is the bottom rung of the cost ladder: `real LLM → guide mode`. Also usable as `AI_PROVIDER=guide` for zero-cost development/smoke of the whole flow.

## Scope

- `GuideAIProvider` in the worker implementing the existing `AIProvider.generate` boundary — deterministic, no LLM.
- Intent router (keywords, no embeddings — in guide mode there is no API to consult): curated catalog + **honest fallback** (state what is not covered, offer suggestions; never fake it).
- Selection: `AI_PROVIDER=guide` forces guide mode (dev/smoke); automatic fallback: any `ChatRunError("ai_unavailable")` from the real provider resolves that **whole turn** in guide mode.
- Response: same `{ reply, widgets?, sources? }` through the existing `normalizeWidgets` pipeline; plus `mode: "guide"` and `suggestions?: string[]` only on guide replies.
- Front: when `mode === "guide"`, show a discreet notice + suggestion chips reusing the existing `.ask-suggestions` mechanism.
- Tests: worker vitest (router, contract, fallback) + client DOM-stub harness (notice + suggestions); `tsc` + `astro check` clean.
- NOT in scope: changing the normal `/api/chat` contract, touching the tool loop when the LLM is up, embeddings, or any model call inside guide mode.

## Decisions (user-confirmed, 2026-09-29)

| Decision | Value |
| --- | --- |
| Guide mode signalized | Yes — discreet notice + suggestions (user accepted the recommendation) |
| Catalog content | Lives in `worker/src/guide.ts` (code, not `knowledge/`) — lesson: models parrot instruction lines from docs; guide content is fixed by design |
| Project data | Reuses the existing project index (`listProjectCards` / knowledge) — no duplicated content |
| Automatic fallback | A whole turn resolves in guide mode when the provider throws `ai_unavailable` at any point |
| Suggestions | Worker sends `suggestions: string[]` on guide replies; front renders them with `.ask-suggestions` |
| Prompt/tools | No model, no tools, no knowledge queries in guide mode; zero quota, deterministic |

## App contract

- `POST /api/chat` → `200 { reply, widgets?, sources?, mode?, suggestions? }`
- `mode: "guide"` only on guide replies; absent on normal replies.
- Guide replies reuse existing widget tokens: `[[widget:projects]]`, `[[widget:project slug="…"]]`, `[[widget:link url="…"]]`.

## Intent catalog v1 (content curated from `knowledge/`)

| id | patterns (frases/words, lowercase) | reply source | widgets |
| --- | --- | --- | --- |
| `saludo` | hola, buenas, hey, buen dia, que tal | greeting + what I can tell | — |
| `quien_eres` | quién eres, quien eres, presentate, sobre ti, hablame de ti, sobre mi, albert | `knowledge/about.md` | — |
| `experiencia` | experiencia, curriculum, cv, trayectoria, has trabajado, años | `knowledge/experience.md` | — |
| `skills` | skills, habilidades, stack, tecnologias, herramientas, que sabes | `knowledge/skills.md` | — |
| `servicios` | servicios, que ofreces, diseno (web), desarrollo web | `knowledge/services.md` | — |
| `proyectos` | proyectos, portfolio, trabajos, que has hecho, que has creado | list intro | `[[widget:projects]]` |
| `proyecto_concreto` | data-driven: question contains a known project title from the index | name + short line | `[[widget:project slug="…"]]` |
| `contacto` | contacto, email, linkedin, github, escribirte, hablemos | `knowledge/contact.md` | `[[widget:link url=…]]` ×2 |
| `web` | esta web, como esta hecha, el chat, quien hizo el chat | honest explanation (Astro + worker + widgets + guide mode) | — |
| `trabajo_colab` | contratar, freelance, colaborar, presupuesto, encargo | services + contact | link |
| `fallback` | (default) | honest: not covered + suggestions list | — |

Router design notes: keyword scoring with weights; minimum threshold; specific intents before generic ones (`proyecto_concreto` before `proyectos`); negative cases tested ("cuánto cuesta tu casa" → `fallback`, no false positives). Suggestions (v1): "¿Quién eres?", "¿Qué proyectos tienes?", "¿Qué tecnologías usas?", "¿Cómo contactarte?".

## Tasks

1. Feature doc + catalog spec (this file).
2. `GuideAIProvider` + intent router + tests (`worker/src/guide.ts`, `worker/tests/guide.test.ts`).
3. Integration in `index.ts`: `AI_PROVIDER=guide`, automatic fallback `ai_unavailable` → guide, `mode` + `suggestions`; handler tests.
4. Front: guide notice + suggestion chips (`public/scripts/conversation.js`, `src/styles/global.css`, DOM-stub harness).
5. Docs + README runbook + full worker tests + `tsc` + `astro check`.
6. Live smoke with `AI_PROVIDER=guide` (servers already running: astro :4321, worker :8787).
7. (user) merge/push decision.

## Ledger

- 2026-09-29: feature started. Branch `feat/guide-mode` from `main` (8b86d02). Baseline: worker tests 200 (main; +14 gemini on the other branch = the 214 figure seen in older ledgers), tsc clean.
- 2026-09-29: T1-T4 done. Commits: 84ad80a (docs + .gitignore .dev.vars), e6d3b9e (guide.ts + router, 92 tests), 878096c (index.ts integration + `classifyProviderError` in chat.ts mapping real availability failures 429/5xx/quota to guide fallback, +23 tests), 98523a0 (front notice + chips).
- 2026-09-29: review catch — the FIRST integration wired fallback only to the settle no-output path; quota/5xx (the real free-tier case) arrived wrapped as `ai_error` and still 502. Fixed via `classifyProviderError` in `chat.ts` (tests in chat.test.ts table + guide-handler 429/5xx cases).
- 2026-09-29: T5 done, T6 smoke LIVE with `AI_PROVIDER=guide` (wrangler dev :8787 + astro :4321): saludo/quien_eres/skills/experiencia/proyectos (widget projects)/botanic (widget project)/contacto (2 link widgets)/web/fallback honesto — ALL correct with `mode: "guide"` + suggestions. NOT a bug: Windows git-bash `curl -d` mangles literal `é`/`í` (CP1252) — always use `\u00e9` escapes when probing from shell; the browser sends correct UTF-8 JSON. Verification: worker 315 tests, worker tsc clean, astro check 0 errors.
- 2026-09-29: native RDD review: user GRANTED consent; the consent binding mechanism in this Pi host is broken (every START envelope reports `consent-binding-expired` — "expired after 10 minutes without an answer" even for bindings created seconds earlier; host-owned consent dialog never surfaces). No lineage created (`lineage_created: false`), no mutation. Not retried further per contract (do not hammer START on the same candidate). Verification stands on: 315 worker tests, worker tsc, astro check 0 errors, live smoke. Re-run `gentle_review inspect` for this candidate when the host consent flow works.