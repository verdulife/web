import type { AIProvider, AiRequest, AiResponse } from "./ai";
import type { ProjectListItem } from "./projects";

/**
 * Guide mode: the deterministic bottom rung of the chat cost ladder.
 *
 * When the real model is unavailable (`AI_PROVIDER=guide`, quota exhausted or
 * a turn-wide `ai_unavailable`), the worker answers with curated content — no
 * LLM, no tools, no knowledge queries, zero quota. The reply keeps the same
 * `reply + widgets` contract used by the model path: widget tokens
 * (`[[widget:projects]]`, `[[widget:project slug="…"]]`, `[[widget:link …]]`)
 * are normalized by the existing pipeline.
 *
 * Intent routing is keyword-scored (there is no API to consult in guide mode,
 * so no embeddings): patterns are matched on normalized text (lowercase,
 * accent-stripped), longer phrases score higher, each intent needs a minimum
 * score, specific intents are evaluated before generic ones (`proyecto_concreto`
 * before `proyectos`), and every unmatched question lands on an honest
 * `fallback` that says what is (not) covered and offers suggestions — never a
 * faked answer.
 *
 * Content lives in this module by design (feature decision 2026-09-29): model
 * providers parrot instruction lines from docs, and guide content is fixed by
 * design. The prose paraphrases knowledge/ (about, experience, skills,
 * services, contact) in neutral professional Spanish, no voseo.
 */

export type GuideIntentId =
  | "proyecto_concreto"
  | "saludo"
  | "quien_eres"
  | "experiencia"
  | "skills"
  | "servicios"
  | "proyectos"
  | "contacto"
  | "web"
  | "trabajo_colab"
  | "fallback";

/** One router pattern: normalized text plus its match weight. */
export interface IntentPattern {
  text: string;
  weight: number;
}

export interface RouterIntent {
  id: Exclude<GuideIntentId, "proyecto_concreto" | "fallback">;
  /** Ordered; earlier patterns are the more specific phrasing. */
  patterns: IntentPattern[];
}

export interface RouterResult {
  intent: GuideIntentId;
  /** Present only for `proyecto_concreto`. */
  project?: ProjectListItem;
}

/** Minimum score for an intent to be selected (any single weak keyword). */
export const MIN_INTENT_SCORE = 1;

/** v1 suggestion chips sent to the front on guide replies. */
export const GUIDE_SUGGESTIONS: readonly string[] = [
  "¿Quién eres?",
  "¿Qué proyectos tienes?",
  "¿Qué tecnologías usas?",
  "¿Cómo contactarte?",
];

const LINKEDIN_URL = "https://linkedin.com/in/albert-verdu";
const GITHUB_URL = "https://github.com/verdulife";

/* ------------------------------------------------------------------------- */
/* Normalization                                                              */
/* ------------------------------------------------------------------------- */

/**
 * Normalizes user input for matching: lowercase and accent-stripped
 * (diacritics decomposed and removed). Punctuation is kept — `contains`
 * matching is insensitive to ¿, ¡, commas etc.
 */
export function normalizeText(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/**
 * Idiomatic greetings stay weak (weight 1) even when multi-word: they are
 * social filler, not topic phrases, so they must not outrank a content intent
 * that also matches ("¿qué tal tu experiencia?" is an experience question).
 */
const GREETING_PATTERNS = new Set(["que tal", "buen dia"]);

/**
 * Pattern weight: descriptive phrases score by word count (longer phrase =
 * stronger signal); single keywords score 1.
 */
export function patternWeight(pattern: string): number {
  if (GREETING_PATTERNS.has(pattern)) return 1;
  const words = pattern.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, words);
}

const P = (text: string): IntentPattern => ({ text, weight: patternWeight(text) });

/* ------------------------------------------------------------------------- */
/* Intent catalog (evaluation order = tie-break order)                        */
/* ------------------------------------------------------------------------- */

/**
 * Intent catalog v1. Order is the tie-break order: when two intents reach the
 * same score, the earlier one wins. Content intents precede `saludo` (weak),
 * and the data-driven `proyecto_concreto` is handled before any scoring (see
 * {@link routeIntent}). Contacto's core verbs carry an explicit weight boost
 * so "¿cómo te contacto, Albert?" (contacto 2 + quien_eres 1) answers contact.
 */
export const GUIDE_INTENTS: readonly RouterIntent[] = [
  {
    id: "quien_eres",
    patterns: [
      P("hablame de ti"),
      P("quien eres"),
      P("sobre ti"),
      P("sobre mi"),
      P("presentate"),
      P("albert"),
    ],
  },
  {
    id: "experiencia",
    patterns: [
      P("has trabajado"),
      P("experiencia"),
      P("trayectoria"),
      P("curriculum"),
      P("cv"),
      P("anos"),
    ],
  },
  {
    id: "skills",
    patterns: [
      P("que sabes"),
      P("habilidades"),
      P("tecnologias"),
      P("herramientas"),
      P("stack"),
      P("skills"),
    ],
  },
  {
    id: "servicios",
    patterns: [P("que ofreces"), P("desarrollo web"), P("diseno web"), P("servicios")],
  },
  {
    id: "web",
    patterns: [
      P("quien hizo el chat"),
      P("quien hizo esta web"),
      P("como esta hecha"),
      P("esta web"),
      P("el chat"),
    ],
  },
  {
    id: "trabajo_colab",
    patterns: [
      P("contratar"),
      P("freelance"),
      P("colaborar"),
      P("presupuesto"),
      P("encargo"),
    ],
  },
  {
    id: "proyectos",
    patterns: [
      P("que has hecho"),
      P("que has creado"),
      P("proyectos"),
      P("proyecto"),
      P("portfolio"),
      P("trabajos"),
    ],
  },
  {
    id: "contacto",
    patterns: [
      { text: "contacto", weight: 2 },
      { text: "contactar", weight: 2 },
      { text: "contactarte", weight: 2 },
      P("escribirte"),
      P("linkedin"),
      P("github"),
      P("email"),
      P("hablemos"),
    ],
  },
  { id: "saludo", patterns: [P("hola"), P("buenas"), P("hey"), P("buen dia"), P("que tal")] },
];

/* ------------------------------------------------------------------------- */
/* Scoring                                                                   */
/* ------------------------------------------------------------------------- */

/** Sum of the weights of every pattern of `intent` present in `question`. */
export function scoreQuestion(intent: RouterIntent, question: string): number {
  let score = 0;
  for (const pattern of intent.patterns) {
    if (question.includes(pattern.text)) score += pattern.weight;
  }
  return score;
}

/* ------------------------------------------------------------------------- */
/* Concrete project matching (data-driven, specific intent)                   */
/* ------------------------------------------------------------------------- */

/**
 * The name variants usable to recognize a project in a question: the primary
 * title (pipe/parenthetical suffixes dropped, e.g. "Gaudio Art" from
 * "Gaudio Art | Diseño de trofeos exclusivos"), the full title, and the slug.
 * Normalized for matching.
 */
export function projectNameVariants(item: ProjectListItem): string[] {
  const title = normalizeText(item.title);
  const slug = normalizeText(item.slug);
  const primary = title.replace(/\s*[|(].*$/, "").trim();
  const variants = [primary, slug];
  if (title !== primary) variants.push(title);
  return [...new Set(variants.filter((variant) => variant !== ""))];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whole-word containment of `word` in `text` (both normalized). Using word
 * boundaries instead of `includes` avoids false positives like "botanic"
 * matching inside "botánica" or "mando" inside "mandar".
 */
function containsWholeWord(text: string, word: string): boolean {
  if (word === "") return false;
  const escaped = escapeRegExp(word);
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(text);
}

/**
 * Returns the project referenced in the question, or null. When several
 * projects match, the longest matched name wins (and ties keep the first
 * entry in the provided list — deterministic).
 */
export function findConcreteProject(
  question: string,
  projects: ProjectListItem[],
): ProjectListItem | null {
  const text = normalizeText(question);
  let best: ProjectListItem | null = null;
  let bestLength = 0;
  for (const item of projects) {
    for (const variant of projectNameVariants(item)) {
      if (!containsWholeWord(text, variant)) continue;
      if (variant.length > bestLength) {
        best = item;
        bestLength = variant.length;
      }
    }
  }
  return best;
}

/* ------------------------------------------------------------------------- */
/* Router                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Routes a question to an intent. `proyecto_concreto` is decided first
 * (data-driven, specific before generic): a named known project always beats
 * keyword intents. Otherwise the highest-scoring catalog intent wins; ties go
 * to the earlier intent in {@link GUIDE_INTENTS}; no intent reaches
 * {@link MIN_INTENT_SCORE} → `fallback`.
 */
export function routeIntent(question: string, projects: ProjectListItem[]): RouterResult {
  const text = normalizeText(question);

  const project = findConcreteProject(question, projects);
  if (project !== null) return { intent: "proyecto_concreto", project };

  let best: RouterResult = { intent: "fallback" };
  let bestScore = 0;
  for (const intent of GUIDE_INTENTS) {
    const score = scoreQuestion(intent, text);
    // Strictly greater: on equal scores the earlier intent keeps the turn.
    if (score > bestScore && score >= MIN_INTENT_SCORE) {
      bestScore = score;
      best = { intent: intent.id };
    }
  }
  return best;
}

/* ------------------------------------------------------------------------- */
/* Curated replies (content fixed by design, paraphrased from knowledge/)     */
/* ------------------------------------------------------------------------- */

const SALUDO_REPLY =
  "¡Hola! Soy Albert Verdu, diseñador gráfico y desarrollador frontend. Puedo contarte sobre mí, mi experiencia, mis habilidades, los servicios que ofrezco, mis proyectos o cómo contactarme. ¿Qué te gustaría saber?";

const QUIEN_ERES_REPLY =
  "Soy Albert Verdu, diseñador gráfico y desarrollador frontend de Barcelona, con más de 20 años de experiencia entre el diseño y el código. Trabajo desde Olivella, con actividad en Sitges. Para mí el design first es el núcleo de todo desarrollo de UI/UX: la intención visual, la jerarquía y la forma guían la implementación. Mi trabajo abarca el diseño editorial y web, y las interfaces y herramientas digitales para estudios, imprentas y equipos pequeños.";

const EXPERIENCIA_REPLY =
  "Tengo más de 20 años de experiencia como diseñador gráfico y desarrollador frontend, con base en Barcelona y actividad en Sitges. Entre las colaboraciones destacadas están la web de SGL Vilanova construida con Astro, el ecosistema digital de Gaplogic (web WordPress, POS gapcloud y reporte de tareas) y la web del podcast Kncelados. También tengo productos propios: Botanic, Facturas Gratis, Mando, WePrintPDF, GapCalc y utilidades de imprenta. ¿Te cuento alguno en detalle?";

const SKILLS_REPLY =
  "Mi stack principal es Astro, SvelteKit, TailwindCSS, TypeScript, Bun y Node; la combinación más habitual es Astro o SvelteKit con TailwindCSS y TypeScript. En proyectos concretos he usado GSAP, Playwright, WordPress con Divi, Angular con Firebase, PDFlib.js y Remotion. En diseño cubro diseño gráfico, identidad, UI/UX, diseño editorial y de imprenta, preflight y herramientas de preimpresión.";

const SERVICIOS_REPLY =
  "Ofrezco diseño y desarrollo web —webs editoriales y aplicaciones con Astro o SvelteKit, y mantenimiento de proyectos existentes sobre WordPress con Divi—, diseño gráfico y de imprenta (identidad, piezas impresas, preflight), UI/UX con enfoque design-first y automatización con herramientas y agentes propios. Trabajo con autónomos, estudios de diseño, imprentas y organización de eventos.";

const PROYECTOS_REPLY = "Aquí tienes una selección de mis proyectos:\n\n[[widget:projects]]";

const CONTACTO_REPLY =
  "El portfolio público es verdu.dev, este mismo sitio. Puedes escribirme por LinkedIn o ver mi código en GitHub; la base está en Sitges (Barcelona).\n\n" +
  `[[widget:link url="${LINKEDIN_URL}"]] [[widget:link url="${GITHUB_URL}"]]`;

const WEB_REPLY =
  "Esta web está construida con Astro y el chat corre en un worker de Cloudflare. El chat responde con mensajes y widgets —listas de proyectos, enlaces, fichas de proyecto— y tiene un modo guía: cuando el modelo de IA no está disponible, responde con contenido curado y determinista, sin consumir cuota. La hice yo, Albert Verdu, con el mismo enfoque design first del resto del portfolio.";

const TRABAJO_COLAB_REPLY =
  "Sí, trabajo por encargo: diseño y desarrollo web con Astro o SvelteKit, diseño gráfico y de imprenta, UI/UX design-first y automatización. Si quieres colaborar o pedir un presupuesto, puedes escribirme por LinkedIn.\n\n" +
  `[[widget:link url="${LINKEDIN_URL}"]]`;

const FALLBACK_REPLY =
  "Perdona, esta pregunta no está cubierta en el modo guía: ahora mismo el chat responde sin modelo de IA, con contenido curado y respuestas preparadas. Prueba con alguna de estas:\n" +
  "- «¿Quién eres?»\n- «¿Qué proyectos tienes?»\n- «¿Qué tecnologías usas?»\n- «¿Cómo contactarte?»";

/** Builds the deterministic reply text for a routed intent. */
export function replyForIntent(routed: RouterResult): string {
  switch (routed.intent) {
    case "proyecto_concreto": {
      const item = routed.project;
      // Defensive: the router guarantees a project here; never crash.
      if (!item) return FALLBACK_REPLY;
      return `Te cuento sobre ${item.title}.\n${item.description}\n\n[[widget:project slug="${item.slug}"]]`;
    }
    case "saludo":
      return SALUDO_REPLY;
    case "quien_eres":
      return QUIEN_ERES_REPLY;
    case "experiencia":
      return EXPERIENCIA_REPLY;
    case "skills":
      return SKILLS_REPLY;
    case "servicios":
      return SERVICIOS_REPLY;
    case "proyectos":
      return PROYECTOS_REPLY;
    case "contacto":
      return CONTACTO_REPLY;
    case "web":
      return WEB_REPLY;
    case "trabajo_colab":
      return TRABAJO_COLAB_REPLY;
    case "fallback":
      return FALLBACK_REPLY;
  }
}

/** Routes + replies in one step (pure convenience for tests/consumers). */
export function guideReply(question: string, projects: ProjectListItem[]): string {
  return replyForIntent(routeIntent(question, projects));
}

/** Content of the last user message, or "" when there is none. */
export function lastUserMessage(messages: AiRequest["messages"]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") return messages[index].content ?? "";
  }
  return "";
}

/* ------------------------------------------------------------------------- */
/* Provider                                                                  */
/* ------------------------------------------------------------------------- */

export interface GuideDeps {
  /** Project index (listProjectCards output); data source for proyectos. */
  projects: ProjectListItem[];
}

/**
 * Deterministic, model-free AIProvider. `generate` never throws: no user
 * message or empty input routes to the honest `fallback`. Replies carry the
 * widget tokens the existing normalizeWidgets pipeline understands.
 */
export class GuideAIProvider implements AIProvider {
  private readonly projects: ProjectListItem[];

  constructor(deps: GuideDeps) {
    this.projects = deps.projects;
  }

  async generate(request: AiRequest): Promise<AiResponse> {
    const question = lastUserMessage(request.messages);
    return { text: replyForIntent(routeIntent(question, this.projects)), toolCalls: null };
  }
}