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

## Tasks

| # | Task | Status | Route | ~lines | TDD/checks | Outcome |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | repo-init: git, .gitignore, README (pending delegation), tracking | in_progress (restart) | inline + delegated write | 40 | — |  |
| 2 | knowledge-content: draft `knowledge/*.md` (Spanish) | pending | delegated explore → inline write | 400 | review |  |
| 3 | frontend-scaffold: package.json, astro/tailwind config, fonts, layouts, design tokens | pending | delegated writer | 400 | astro check + build |  |
| 4 | pages-static: content collections + about/skills/services/experience/projects/contact/detail | pending | delegated writer | 400 | astro check + build |  |
| 5 | home-editorial: editorial homepage + masthead + AI intro | pending | delegated writer | 350 | astro check + build |  |
| 6 | conversation-ui: integrated conversation component (not chatbot box) | pending | delegated writer | 400 | astro check + build |  |
| 7 | worker-knowledge: scaffold, limits, KnowledgeProvider + snapshot script, prompts, tests | pending | delegated writer | 450 | vitest + tsc |  |
| 8 | worker-chat: AI client, tool loop, router, error handling, rate limiting, tests | pending | delegated writer | 450 | vitest + tsc + wrangler dev |  |
| 9 | verify-e2e: full vertical path local verification + graceful-degradation check | pending | delegated verify | 100 | all |  |
| 10 | close: README/runbook, memory, final report | pending | inline | 100 | — |  |

## Work-unit commit ledger

| Commit | Task | Identity | Tier (RDD) | Outcome |
| --- | --- | --- | --- | --- |

(RDD: assess each work-unit commit via `gentle_review assess`; medium → defer to slice; boundary tracking per ODD.)