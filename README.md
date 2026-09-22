# verdu

Personal/professional portfolio with an integrated conversational AI layer: **a semantic interface to the portfolio**, in the visual language of *a strange newspaper from the future* (editorial serif content typography, restrained digital/monitor interface details). Spanish-first.

> Feature plan and decisions: `odd/tasks/portfolio-ai.md`.

## Stack

- **Frontend**: Astro 5 + TypeScript + Tailwind CSS v4 (static output; HTML-first conventional pages)
- **AI backend**: Cloudflare Worker (`worker/`) + Workers AI — browser → Worker → Workers AI (no direct provider access)
- **Knowledge**: Markdown in `knowledge/` (Spanish), single source of truth for the pages AND the AI (stored behind a `KnowledgeProvider` interface: GitHub raw in production, bundled snapshot for local/dev)

## Repo layout

```text
src/          Astro site (pages, components, styles)
public/       Static assets (favicon, scripts/conversation.js)
knowledge/    Knowledge base md (pages + AI; edit these, then `bun run worker:gen`)
worker/       Cloudflare Worker (chat endpoint, limits, knowledge providers, tests)
odd/          ODD feature tracking
```

## Dev (no Cloudflare account needed)

```bash
bun install              # frontend deps (repo root)
bun --cwd worker install # worker deps
bun run dev              # Astro dev server on http://localhost:4321
bun run worker:gen       # regenerate worker/src/generated/*.json from knowledge/*.md
bun run worker:dev:local # wrangler dev (no auth) on http://localhost:8787 ... see below
```

There is no `worker:dev:local` root script yet — run `bun --cwd worker run dev:local`. In local (no-auth) mode the Workers AI binding is unavailable, so `/api/chat` answers `502 ai_unavailable` with a user-facing message; the site keeps working and the conversation UI shows "SERVICIO NO DISPONIBLE" with a retry. The full AI path (tool loop + answer) needs real Workers AI auth.

## Using the AI endpoint

```bash
curl -s -X POST http://localhost:8787/api/chat \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"¿Qué proyectos tienes?"}]}'
```

Contract (request/response/errors) is documented in `odd/tasks/portfolio-ai.md` under *App contract*.

### Editing knowledge

1. Edit the Spanish markdown in `knowledge/` (frontmatter: `id`, `kind`, `title`, `description`).
2. Run `bun run worker:gen` — regenerates the worker's bundled snapshot + index (excludes `knowledge/index.md` by design).
3. The static pages (about, skills, services, projects, …) render the same files automatically.

## Checks & tests

```bash
bun run check          # astro check (frontend types)
bun run build          # astro check + static build
bun --cwd worker run check   # worker tsc
bun --cwd worker run test    # worker vitest (limits, ratelimit, chat, knowledge, handler)
```

## Deploy (later, user-owned)

- **Worker**: set `CLOUDFLARE_API_TOKEN` (or `wrangler login`), optionally set the `GITHUB_REPO`/`GITHUB_REF` vars to serve knowledge from the GitHub repo instead of the bundled snapshot, then `bun --cwd worker run deploy`.
- **Frontend**: Vercel import of this repo (static output, no adapter required).

## Known environment quirks (this machine)

- Astro script bundling is broken here (astro 5.18.2 + @astrojs/compiler 2.13.1 emit `<script type="module">` verbatim, no JS chunk). Client code therefore lives in `public/scripts/conversation.js` (self-contained module, no imports) and decorative CSS in `src/styles/global.css`. Re-test after an astro/compiler upgrade.
- `wrangler dev` (remote mode) needs auth even for local work; use `dev:local` for no-auth runs.
