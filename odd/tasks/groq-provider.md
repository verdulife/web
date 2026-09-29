# Feature: groq-provider — Groq free tier como proveedor del chat

## Goal

Add **Groq** (OpenAI-compatible, `https://api.groq.com/openai/v1`, free tier openai/gpt-oss-20b) as a chat provider on `main`. Groq is a real free tier with daily quota (~14.4k req/day RPD for 70b versatile) that does not touch Gemini's window or Cloudflare neurons, and it participates in the existing cost ladder: `real LLM → guide mode` (automatic fallback already generic via `classifyProviderError`, which catches Groq 429/5xx/timeouts).

## Scope

- `GroqOpenAIProvider` in `worker/src/groq.ts`: HTTP OpenAI-compatible adapter (Bearer `GROQ_API_KEY` from `.dev.vars`/secrets — never in repo), model `GROQ_MODEL_ID ?? MODEL_ID`, no reasoning field (llama family), normalize text + tool_calls into the existing `AiResponse` contract, defensive like the rest of the adapters.
- `Env`: add `GROQ_API_KEY: string` and optional `GROQ_MODEL_ID?: string`.
- Selection: extract a testable `selectProvider(env)` (mock | guide | groq | cloudflare default) in `index.ts`; `AI_PROVIDER=groq` wires Groq. Guide fallback unchanged (no changes to chat.ts).
- Script `worker:dev:groq` (`wrangler dev --port 8787 --local --var AI_PROVIDER:groq --var GROQ_MODEL_ID:openai/gpt-oss-20b`), README runbook note.
- Tests: adapter unit with fetch stub (200 text, 200 tool_calls, 429/5xx → availability error, malformed payload defensive), selection tests.
- NOT in scope: changing the committed production default (stays cloudflare legacy on main; prod choice is user-owned), Gemini (separate unmerged branch).

## App contract (unchanged)

- `POST /api/chat` contract identical; Groq is just another `AIProvider`. Availability failures fall back to guide (`mode: "guide"`) exactly as with any provider.

## Tasks

1. Feature doc + branch `feat/groq-provider` (this file).
2. `GroqOpenAIProvider` + `Env` fields + `selectProvider` wiring + tests.
3. `worker:dev:groq` script + README note.
4. Full verification (worker tests, tsc, astro check) + live smoke with the real key (1-2 turns).

## Ledger

- 2026-09-29: started. `GROQ_API_KEY` saved in `worker/.dev.vars` (gitignored; verified no git trace). Branch from `main` (09f1a25). Main default unchanged (cloudflare legacy, MODEL_ID @cf/meta/llama-3.3-70b-instruct-fp8-fast).- 2026-09-29 (implemented): T2+T3+T4 done. Commits: 6f8bd0e (plan), e78… (GroqOpenAIProvider + selectProvider + 21 tests), 9b1… (script dev:groq + README), afa57b8 (fix fetch bind + tools OpenAI shape + provider error log). LIVE findings: (1) The account's Groq catalog has NO llama models — free access exposes openai/gpt-oss-120b, openai/gpt-oss-20b, qwen/qwen3.8-27b, whisper etc; gpt-oss-120b thinks in chat/completions (reasoning field, empty content within small budgets) → chose openai/gpt-oss-20b (content within 512 budget + standard tool_calls). (2) Fetch passed as a bare reference throws "Illegal invocation" in workerd (Bun/Node don't) → bound via arrow wrapper. (3) Tools must be mapped to { type: "function", function: {…} } or Groq 400s. (4) The model occasionally emits the widget token without an entry — normalizeWidgets/front drop unresolvable indices (expected). SMOKE: quién eres / gaplogic (tool loop, sources:["gaplogic"]) / proyectos (widget projects) all real LLM responses. Tests 336, tsc clean, astro check 0.
