# verdu

Personal/professional portfolio with an integrated conversational AI layer: **a semantic interface to the portfolio**, in the visual language of *a strange newspaper from the future* (editorial serif content typography, restrained digital/monitor interface details). Spanish-first.

> Feature plan and decisions: `odd/tasks/portfolio-ai.md`.

## Stack

- **Frontend**: Astro 5 + TypeScript + Tailwind CSS v4 (static output; HTML-first conventional pages)
- **AI backend**: Cloudflare Worker (`worker/`) + Gemini API (free tier, `gemini-2.5-flash`) — browser → Worker → Gemini (no direct provider access; legacy Workers AI mode selectable via `--var AI_PROVIDER:cloudflare`)
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
bun install --cwd worker # worker deps
bun run dev              # Astro dev server on http://localhost:4321
bun run worker:gen       # regenerate worker/src/generated/*.json from knowledge/*.md
bun run worker:dev:local # wrangler dev (no auth) on http://localhost:8787 ... see below
```

There is now a `worker:dev:local` root script — run `bun run worker:dev:local`. The full AI path (tool loop + knowledge + answer) works locally once the Gemini API key is in `worker/.dev.vars`; without a key `/api/chat` answers `502 ai_unavailable` with a user-facing message, the site keeps working and the conversation UI shows "SERVICIO NO DISPONIBLE" with a retry.

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

## Gemini provider (chat AI)

El chat del worker usa la **Gemini API free tier** por defecto (modelo `gemini-2.5-flash` a través del endpoint OpenAI-compatible de Gemini). Cuota estimada: ~10–15 RPM por proyecto; una pregunta del chat cuesta hasta **4 llamadas al modelo** (3 turnos de herramienta + settle). Los números reales de cuota no son públicos: verifícalos en [AI Studio](https://aistudio.google.com/rate-limit) después de crear la key.

### Requisitos

1. Crear una API key en [aistudio.google.com/apikey](https://aistudio.google.com/apikey). Opcional: restringir la key solo al Gemini API y revisar el toggle de uso de datos / opción UE del tier gratuito en AI Studio.
2. La key **nunca va a git**: en local vive en `worker/.dev.vars` (gitignored) y en producción como secreto del worker.

### Local dev

```bash
echo 'GEMINI_API_KEY=...' >> worker/.dev.vars   # gitignored
cd worker && wrangler dev                       # o `bun run worker:dev:local` para runs sin auth
```

### Producción

```bash
cd worker && wrangler secret put GEMINI_API_KEY
```

`wrangler.toml` ya trae por defecto `AI_PROVIDER = "gemini"` y `MODEL_ID = "gemini-2.5-flash"`. Al desplegar, recuerda: `ALLOWED_ORIGINS` debe listar el dominio real y, si el frontend está en Vercel, apuntar `PUBLIC_WORKER_URL` al worker desplegado.

### Cambiar de proveedor

El valor por defecto commiteado es Gemini; el resto de modos se seleccionan solo por CLI (`--var`), nunca editando `wrangler.toml`:

```bash
cd worker && bun run dev:mock                   # AI_PROVIDER:mock -> MockAIProvider (widget/UI testing)
cd worker && wrangler dev --var AI_PROVIDER:cloudflare   # legacy Workers AI
cd worker && wrangler dev --var AI_PROVIDER:gemini       # explícito, por si se prueba sin el defecto
```

### Caída del proveedor

Si Gemini no responde o limita por cuota, `/api/chat` responde `502` y la UI muestra "SERVICIO NO DISPONIBLE" con reintento; el resto del sitio sigue funcionando con normalidad.

## Checks & tests

```bash
bun run check          # astro check (frontend types)
bun run build          # astro check + static build
bun run --cwd worker check   # worker tsc
bun run --cwd worker test    # worker vitest (limits, ratelimit, chat, knowledge, handler)
```

## Deploy (later, user-owned)

- **Worker**: set `CLOUDFLARE_API_TOKEN` (or `wrangler login`), optionally set the `GITHUB_REPO`/`GITHUB_REF` vars to serve knowledge from the GitHub repo instead of the bundled snapshot, then `bun run --cwd worker deploy`.
- **Frontend**: Vercel import of this repo (static output, no adapter required).

## Known environment quirks (this machine)

- Astro script bundling is broken here (astro 5.18.2 + @astrojs/compiler 2.13.1 emit `<script type="module">` verbatim, no JS chunk). Client code therefore lives in `public/scripts/conversation.js` (self-contained module, no imports) and decorative CSS in `src/styles/global.css`. Re-test after an astro/compiler upgrade.
- `wrangler dev` (remote mode) needs auth even for local work; use `dev:local` for no-auth runs.
