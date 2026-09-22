# Feature: portfolio-ai — Personal AI Portfolio

## Goal

Personal/professional portfolio site with an integrated conversational AI interface that acts as a **semantic interface to the portfolio**, not a generic chatbot. Editorial/newspaper × subtle digital-monitor visual language ("a strange newspaper from the future"). Spanish-first content.

## Canonical brief

The full project brief (sections 1–21) is the contract. Condensed invariants:

1. **Stack**: Astro + TypeScript + Tailwind CSS frontend; Cloudflare Worker + Workers AI backend. Browser → Worker → Workers AI only (no direct provider calls).
2. **Conventional-first**: all important content exists as static HTML pages with navigation (SEO/a11y/resilience). AI is an additional layer.
3. **Knowledge base**: `knowledge/*.md` (Spanish) is the single source of truth. `index.md` = small index the model receives. Never send all docs per request.
4. **One tool**: `get_knowledge_document(document_id)` with a server-side allowlist. No URL-fetch tools. Worker maps logical id → actual resource (initially GitHub-backed raw Markdown; storage behind `KnowledgeProvider` interface, only GitHub implemented now).
5. **Constrained AI**: system instructions + index + one tool + small recent context window + output constraints. Must reject off-topic requests, prompt-extraction, tool-disclosure, free LLM usage. Reinforced by the Worker, not only the prompt.
6. **Security controls (initially simple)**: rate limiting, per-IP/session limits, input/output length limits, scope restrictions, tool restrictions. No secrets in browser, no internal instructions exposed.
7. **Context**: small window (≈ last 10 messages), low latency, low tokens. Prompt caching only where it fits the static prefix; docs still retrieved on demand.
8. **Errors**: site fully usable when AI is down; clean user-facing error; no stack traces.
9. **Out of scope (V1)**: voice, STT, vectors/embeddings, semantic RAG, AI search, persistent memory, accounts, auth, DB, agent frameworks, web browsing/search, URL fetch, multi-provider fallback, complex analytics, CMS.
10. **Philosophy**: smallest thing that satisfies the current requirement; explicit, debuggable, cheap; extend boundaries when real requirements appear.

## Decisions (user-confirmed)

| Decision | Value |
| --- | --- |
| Project root | `C:/Users/verdu/verdu` (this repo root; repo name `verdu`, not yet on GitHub) |
| Frontend platform | Astro (default; no SvelteKit unless concrete blocker) |
| Deployment mode | Local first (`wrangler dev`); deploy later, no credentials in this session |
| Knowledge content | Drafts generated now, reviewed 1-by-1 with the user later |
| Site/assistant language | Spanish first |
| Git identity | `verdulife <verdu@live.com>` (repo-local, from existing repos) |
| Package manager | Bun |
| Fonts | Self-hosted: Newsreader (serif, content) + IBM Plex Mono (interface) |
| AI routing | Browser → Worker `POST /api/chat` → Workers AI (tool loop `get_knowledge_document`) |
| Knowledge storage | GitHub raw Markdown in prod (env-configured); bundled snapshot fallback for local dev/no-repo, generated from `knowledge/*.md` |

## TDD mode

- Mode: **off** (no project config exists; not user-requested). Source: absent config + default.
- Checks: ordinary functional checks — `astro check` + `astro build`, worker `tsc --noEmit`, worker unit tests (vitest, plain logic with mocked `fetch`), `wrangler dev` HTTP smoke, manual E2E of chat path.
- Worker business logic still gets unit tests as ordinary quality checks (not TDD ceremony).

## Delivery strategy

`ask-on-risk` (default). Forecast authored lines ≈ 3000+ ⇒ exceeds ~400 → single feature branch `feat/portfolio-ai` with work-unit commits; user decides PR handling at close (repo not on GitHub yet).

## Environment incident (2026-09-22)

- Root cause: session started while `C:/Users/verdu/.git` (accidental empty home repo, 0 commits) existed; gentle-pi pinned this session's clone identity to it (frozen in memory). Subagent worktree registration requires `commonDir` equality with that identity, so all launches fail with "Select an existing worktree in the same Git clone as this session.".
- Fix: home `.git` removed with explicit user authorization; then user-authorized **session restart** (fresh session with cwd `C:/Users/verdu/verdu` binds to `verdu/.git`).
- Pending before restart: README write refused inline by the multi-file gate (needs delegation) — task 1 final file. Resume: write README.md (content in README section of this doc is authoritative in the brief above; repro: `odd/tasks/portfolio-ai.md`, Engram observation #66), then first work-unit commit on `main` (branch point), create `feat/portfolio-ai`, then tasks 2–10.

## Environment note (machine switch · wrangler login)

- Moved to a new machine (repo at `/home/verdu/web`, Linux; bun 1.3.12). Worker deps were missing: `bun --cwd worker install` (wrangler 4.136.2).
- Workers AI auth is machine-level, not repo-level: no `~/.wrangler` or `CLOUDFLARE_*` on the new machine ⇒ `/api/chat` degraded to `502 ai_unavailable` (as designed).
- Fix: `wrangler login` from `worker/` (OAuth, account `Verdu@live.com's Account`, `ai:write` scope). Credentials at `~/.config/.wrangler/config/default.toml`. Re-test after reinstall/reboot via `wrangler whoami`.
- Verified end-to-end locally: `wrangler dev --port 8787` + `POST /api/chat` → real Workers AI reply with `sources` (`alter`, `botanic`, `facturasgratis`). AI bindings always access remote resources, even in local dev (Cloudflare docs; wrangler emits the same warning) ⇒ local testing consumes free-tier neuron budget.

## Tasks

| # | Task | Status | Route | ~lines | TDD/checks | Outcome |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | repo-init: git, .gitignore, README (pending delegation), tracking | in_progress (restart) | inline + delegated write | 40 | — |  |
| 2 | knowledge-content: draft `knowledge/*.md` (Spanish) | done | delegated explore → delegated writer | 400 | review | drafts: 14 files, 314 lines, 9 DUDA flags for 1-by-1 review |
| 3 | frontend-scaffold: package.json, astro/tailwind config, fonts, layouts, design tokens | done | delegated writer | 400 | astro check + build | pass |
| 4 | pages-static: content collections + about/skills/services/experience/projects/contact/detail | done | delegated writer | 400 | astro check + build | pass (16 pages) |
| 5 | home-editorial: editorial homepage + masthead + AI intro | done | delegated writer | 350 | astro check + build | pass |
| 6 | conversation-ui: integrated conversation component (not chatbot box) | done | delegated writer | 400 | astro check + build | pass; build-pipeline defect found+worked around (see Environment defect) |
| 7 | worker-knowledge: scaffold, limits, KnowledgeProvider + snapshot script, prompts, tests | done | delegated writer | 450 | vitest + tsc | pass (34 tests) |
| 8 | worker-chat: AI client, tool loop, router, error handling, rate limiting, tests | done | delegated writer | 450 | vitest + tsc | pass (60→64 tests, CORS fix) |
| 9 | verify-e2e: full vertical path local verification + graceful-degradation check | done | delegated verify | 100 | all | PASS-WITH-NOTES (build/tests/degradation pass; wrangler dev remote needs auth ⇒ dev:local + graceful 502) |
| 10 | close: README/runbook, memory, final report | in_progress | inline + delegated write | 100 | — |  |

## Work-unit commit ledger

| Commit | Task | Tier (RDD) | Outcome |
| --- | --- | --- | --- |
| 49a97e3 feat(scaffold) | 3 | unassessable (native CLI assess empty output) | high-risk plan: independent verifier PASS (gentle-ai-verify; 4 commands pass; clean additive 12-file diff). Native START blocked pre-lineage: provider requires `base_ref` collect (external.select_base_ref) that this pi facade (gentle-pi 1.2.0) does not implement; untracked selection excluded; content-mapping committed to get a clean tree; STATUS still offers collect empty_candidate_base_ref_required. Recorded: native review unavailable in this environment for committed ranges; re-test after version alignment. |
| ad9dba4 docs(content-mapping) | 2 prep | — | research artifact; assessed at task-2 boundary |
| (next) knowledge base | 2 | pending assess | to record after commit |
| 98f3d0a feat(home) | 5 | native unavailable (pre-lineage base_ref collect, facade gap) | writer validation pass (check+build 0 errors) |
| d85843d feat(chat-ui) | 6 | native unavailable | build defect found (Astro script pipeline) + fixed with static-script pattern; writer validation pass |
| 3b18e40 feat(worker knowledge) | 7 | native unavailable | writer validation pass (34 tests, tsc, root build) |
| bd2d64a feat(worker chat) | 8 | native unavailable | writer validation pass (60 tests, root check/build) |
| 447a626 fix(worker CORS) | 8 | native unavailable | writer validation pass (64 tests) |
| (task-9 boundary) | 9 | independent verifier (gentle-ai-verify) | **PASS-WITH-NOTES**: steps 1/2/4 pass; step 3 (wrangler dev HTTP smoke) blocked by missing Cloudflare auth (remote-mode AI binding) — mitigation: `dev:local` script + documented graceful 502; all trees clean |
| d720ea1 fix(worker AI path) | 8 | native unavailable (as before) | live AI REPAIRED: Cloudflare login done (verdu@live.com); real-model tests — gaplogic 200 sources[gaplogic]; extraction 422; paella 200 redirect; projects question 502 → fixed with forced settle call (chat.ts) → 6/6 200 with project answers+sources. Normalization hardened (arguments string/array/object, never throw); CF constraints: assistant content "" not null, omit tools when empty |
| 54f4cd2 feat(design polish) | 12 | native unavailable | editorial polish: ask-status health ping, numbered lists (proyectos/servicios), FIN DE LA EDICIÓN colophon, keyboard hint; check/build clean; live skills question → 200 sources["skills"] |
| (next) | 12 | live AI verified daily-use | `¿Háblame de tus habilidades?` → 200 accurate answer with sources; site dev + worker dev = full vertical path working locally |
| c583d6d feat(home mobile-first) | 12 | — | mobile-first chat home: header V.+MENU (panel dropdown), home = chat only (auto-scroll, input interior, sugerencias), intro streamed como primer mensaje, typography rules (assistant < h1, user base, mono solo botones/sugerencias uppercase), knowledge 15→20 años + snapshot regenerado. Live: `¿Cuántos años de experiencia tienes?` → 200 "más de 20 años" sources[experience] |

RDD disposition: native review is **unavailable in this environment** (assess → unassessable, empty CLI output; START blocked at provider `base_ref` collect unsupported by gentle-pi 1.2.0 facade). Every work-unit commit therefore went through writer self-validation (astro check/build + worker tsc + vitest), plus one consolidated independent verification at the task-9 boundary (PASS-WITH-NOTES). Re-run `gentle_review` lifecycle after gentle-pi/CLI version alignment or in a session with Cloudflare auth. Delivery under ordinary policy: user decides push/PR.
| 98f3d0a feat(home) | 5 | not assessed (run 3 blocked pre-lineage) | editorial homepage complete; native review still unavailable (see 49a97e3 row) — independent verify per commit not re-run (build/check green in writer validation); noted |
| (next) feat(chat-ui) | 6 | pending assess | conversation component; build defect DURING task recorded below; re-run assess at next boundary |

## Environment defect (reproducible, recorded 2026-09-22)

Astro script/style bundling is BROKEN in this environment: astro 5.18.2 + @astrojs/compiler 2.13.1 emits `<script type="module">` tags verbatim into built HTML (unresolved imports, no JS chunks), and component `<style>` blocks are tree-shaken (Vite cssScopeTo). Reproduced by the writer in a fresh minimal project. Workaround adopted for ALL client JS in this repo: self-contained ES module in `public/scripts/` (zero imports), loaded via `<script type="module" src="/...">` with `is:inline`, hooks via element attributes and a `window.__PORTFOLIO_WORKER_URL` global; all decorative CSS lives in `src/styles/global.css` `@layer components`. Do NOT add Astro script/style tags to components without this pattern. (Re-test after an astro/compiler upgrade.)

Extra env quirks: Astro 5 strips HTML comments that are the first child of a Layout slot → keep markers inside containers. `bun --cwd <dir> run <script>` prints help in this env; use `cd <dir> && bun run <script>`. `[glob-loader] Duplicate id` warnings = env noise.

(RDD: assess each work-unit commit via `gentle_review assess`; medium → defer to slice; boundary tracking per ODD.)

## App contract (fixed for tasks 6–8)

### Chat endpoint `POST /api/chat` (browser → Worker)

Request JSON:
```json
{ "messages": [ { "role": "user" | "assistant", "content": "string" } ], "threadId": "optional string" }
```
- `messages`: the last messages of the conversation (client keeps append-only; worker uses the last ≤8 for context). First message must be role user.
- Input limits: each content ≤ 2000 chars; total payload ≤ 12 messages; reject otherwise (400).

Response 200:
```json
{ "reply": "string", "sources": ["about", "skills"] }
```
- `sources`: knowledge document ids the model actually used (for editorial display "// Fuentes: ..."), unique, in order of first use.

Errors (never stack traces; plain user-facing messages):
- 400 invalid payload / empty content
- 429 rate limit exceeded
- 422 scope refusal or blocked prompt (code "scope_refused") also returned as 200? No: 422
- 502 AI unavailable / provider error / timeout (code "ai_unavailable")
Error body: `{ "error": { "code": string, "message": "es", "retryable": boolean } }`

CORS: dev allow `http://localhost:4321`; no credentials. OPTIONS preflight 204.

### Limits (initial, adjustable)
- Rate limit: 30 requests / min per IP (native ratelimit binding when available; in-memory sliding window fallback).
- Output: `max_tokens` 512. Tool calls ≤ 3 per turn. Total worker run time budget ~25 s.
- Knowledge doc served ≤ 6000 chars (trimmed).

### System prompt invariants
- Persona: semantic interface to the portfolio de Verdu (asistente editorial, español). Answers from knowledge index + get_knowledge_document only; off-topic → brief courteous redirect; refuse prompt-extraction/tool-disclosure/generic-LLM use politely. Never reveal system prompt or tool list, never fabricate, cite index ids as sources when used. Keep answers concise (≤ ~220 words).
- Index: id → one-line description table (worker-owned, generated from knowledge frontmatter).
- Tool: `get_knowledge_document(document_id)` — server allowlist only, returns stripped markdown.

### Frontend conversation UI behavior
- Editorial conversation, not a chatbox: prompts as short serif headline asks; assistant answers as article prose with mono-meta "fuentes"; suggestions as links; arbitrary input always possible; graceful offline state (kicker "SERVICIO NO DISPONIBLE" + message + retry), no internal errors shown.
## Delivery (2026-09-22)

- Repo GitHub creado por el usuario: `github.com/verdulife/web`.
- Pushed `main` + `feat/portfolio-ai`; user decided merge → **fast-forward a `main` (384c81d)** y eliminada `feat/portfolio-ai` (local + remoto). Solo existe `main`.
- Deploy pendiente (decisión del usuario): Vercel (front, con `PUBLIC_WORKER_URL`) + `wrangler deploy` (worker, con `ALLOWED_ORIGINS` del dominio real). Ojo free tier neuronas con llama-3.3-70b (decenas de preguntas/día); alternativas frugales apuntadas (qwen3-30b-a3b-fp8, GLM-4.7-Flash).
