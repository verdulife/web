# verdu

Personal/professional portfolio with an integrated conversational AI layer: **a semantic interface to the portfolio**, in the visual language of *a strange newspaper from the future* (editorial serif content typography, restrained digital/monitor interface details).

> Status: early development — see `odd/tasks/portfolio-ai.md` for the feature plan and decisions.

## Stack

- **Frontend**: Astro + TypeScript + Tailwind CSS (static output, conventional HTML-first pages)
- **AI backend**: Cloudflare Worker + Workers AI (browser → Worker → Workers AI)
- **Knowledge**: Markdown files in `knowledge/` (Spanish), single source of truth for both the conventional pages and the AI layer

## Repo layout

```text
src/          Astro site (pages, components, styles)
knowledge/    Knowledge base markdown (also feeds the AI)
worker/       Cloudflare Worker (chat endpoint, limits, knowledge retrieval)
odd/          ODD feature tracking
```

## Docs

- Feature plan & decisions: `odd/tasks/portfolio-ai.md`
- Runbook (dev + deploy): to be written at feature close.
