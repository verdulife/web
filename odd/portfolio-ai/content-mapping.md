# Content Mapping — verdu portfolio knowledge base

Evidence-based research artifact (gentle-ai-explore, read-only). Facts below trace to files read:
`C:/Users/verdu/porfolio/src/lib/projects.ts`, `Presentation.astro`, `Welcome.astro`, `C:/Users/verdu/AGENTS.md`,
`alter/README.md`, and first ~60 lines of README/package.json/.git config of each repo listed. No web research.
Used to draft `knowledge/*.md` (the user reviews drafts 1-by-1).

## Profile facts

- Name: **Albert Verdu** (LinkedIn: linkedin.com/in/albert-verdu). GitHub identity: `verdulife` (variants `verdu-dev`, `verdulive`).
- Self-description: graphic designer and frontend developer from Barcelona, 15+ years experience; "design first is the core of all ui/ux development".
- Location: Olivella, works in Sitges (Barcelona). Language: Spanish (es-ES).
- Main stack: Astro, SvelteKit, TailwindCSS, TypeScript, Bun, Node. Also seen: GSAP, Playwright, WordPress+Divi, Angular+Firebase, PDFlib.js, Remotion, Cohere AI.

## Gaplogic relationship (evidence only)

- Portfolio entry "Gaplogic": WordPress + Divi site, URL https://testing.gaplogic.com/ → Verdu built/maintains it.
- `gapcloud` + `gapcloud-2026` both point at remote `github.com/gaplogic/gapcloud` (POS, SvelteKit, README ES) → POS developed under Gaplogic's own GitHub org; Verdu is a contributor.
- AGENTS.md has an HTML template "tareas Gaplogic" (task tracking/reporting, Notion→Email) → ongoing work relationship.
- NOT proven: whether Gaplogic is employer, freelancer client, or partner. gapcalc-v2/facturasgratis/weprintpdf/cola-impresion/art-director live under `verdulife` org (print-shop related, ownership unproven).

## Project inventory (class: own / client / collab / tool / experiment / clone)

- gapcloud (+2026): POS "for modern times", under construction, SvelteKit, **Gaplogic org** (contributor).
- gapcalc-v2: price calculator for print services (paper, plotter, t-shirts), protected admin, Astro SSR + Svelte 5 + Tailwind 4, Drizzle + Turso/libsql, Netlify, Bun — own.
- facturasgratis (+v2): free online invoicing tools (invoices, estimates, delivery notes, clients, products); v1 Sapper/Svelte + Express + pdfkit; v2 SvelteKit + Firebase + jsPDF; deployed facturasgratis.vercel.app — own (public).
- weprintpdf (internal name "papira"): customizable printable designs (calendarios, agendas, listas, perpetuos), SvelteKit — own (public).
- kncelados-web (+v2): official web of Kncelados podcast (episode/collection/shorts scrapers, mystery QR), Astro + Vercel, www.kncelados.com — collab/own (podcast org; v2 under verdulife).
- bleed: print preflight utility (Bleed Two App), SvelteKit, PDFlib.js, bleed-two.vercel.app — own.
- calendarify: preprinting utility app (page-size, rotation, custom size, bleed, fit/mirror bleed), SvelteKit — own/tool.
- botanic-app: P2P plant marketplace "where plants meet people", SvelteKit + Bun, NOT open-source, botanicapp.es — own (startup).
- botanic-social: social publishing pipeline for Botanic (IG/TikTok): strategy, schedulers, Remotion studio — own.
- mando: turn iPhones/browsers into virtual Xbox 360 controllers for Windows (ViGEmBus, Bun, PWA, mDNS), releases at github.com/verdulife/mando — own (public).
- level: "RPG in real life" — AI daily real-world quests (Cohere AI), SvelteKit — own/experiment.
- synopsis: movie data site (scraper), SvelteKit — own/experiment.
- bridge: secretary/orchestrator, Bun/TS, "O.T.T.O." proposal — own/tool.
- cahoot: online team task management (ES), SvelteKit — own/experiment.
- dailies: SGL Vilanova client site (truss & temporary electrical installations for events), Astro + Tailwind, sglvilanova.com — client.
- arp, game-animations, poc-endless-page, testing-env, outline-studio: experiments (SvelteKit/Astro + animejs/prompter studio).
- art-director: multi-agent system generating print-ready posters/flyers (5 OpenCode agents, Paged.js, Bun) — own/tool (print-shop).
- cola-impresion: print queue system (monorepo admin/api/web), Bun workspaces — own/tool (no readme).
- streamlist-extension: Chrome/Brave extension capturing video streams into ad-free playlist (MSE interception) — own/tool.
- alter: personal virtual secretary, modular Go service (agent adapter, scheduler, SQLite event store, triggers), Go 1.24+ — own. README says "nothing implemented yet" but internal/ has real code (state discrepancy).
- Clones (NOT Verdu's work): odysseus, illustrator-mcp, email-mcp, mcp-telegram-poc.

## Portfolio showcase (porfolio projects.ts 16 entries)

Kncelados, Calandra Automobili, Ulavet, Jardinería La Medeterránia, **Gaplogic**, Gaudio Art, Stopper Internacional, Tattoo Killer, Menuplis, **Sitgesgi**, **Facturas Gratis**, Timer App, **Venarima**, Grande Fronteo, Simplemente Wear, Bleed Two.

## Gaps / open questions (mark in drafts)

- Gaplogic relationship type (employee/freelancer/partner) — not stated; check with user.
- Ownership of print-shop tools (gapcalc, facturasgratis, weprintpdf, cola-impresion) vs Gaplogic — unproven.
- Public email/phone for contact — none found; user decides.
- Status of many experiments (active vs abandoned).
- alter roadmap discrepancy.

## Language

Site content in the old portfolio (porfolio/) is EN; most product READMEs are ES. The new site + knowledge base are **Spanish-first** (user decision).