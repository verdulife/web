import { describe, expect, it } from "vitest";
import {
  GUIDE_SUGGESTIONS,
  GuideAIProvider,
  MIN_INTENT_SCORE,
  findConcreteProject,
  guideReply,
  normalizeText,
  patternWeight,
  replyForIntent,
  routeIntent,
} from "../src/guide";
import { MAX_OUTPUT_CHARS } from "../src/ai";
import type { AiRequest } from "../src/ai";
import type { ProjectListItem } from "../src/projects";

/**
 * Guide-mode intent router + provider contract (worker/src/guide.ts).
 *
 * Guide mode is the deterministic bottom rung of the chat cost ladder: no LLM,
 * no tools, no knowledge queries. The router is keyword-scored (no embeddings)
 * with a minimum threshold, specific intents before generic ones
 * (`proyecto_concreto` before `proyectos`) and an honest `fallback`. Content is
 * curated Spanish prose paraphrased from knowledge/, fixed by design.
 */

/** Small deterministic project fixture (mirrors listProjectCards output). */
const PROJECTS: ProjectListItem[] = [
  { slug: "botanic", title: "Botanic", description: "Marketplace P2P de plantas: donde las plantas se encuentran con la gente." },
  { slug: "facturasgratis", title: "Facturas Gratis", description: "Herramienta gratuita de facturación online: facturas, presupuestos y albaranes." },
  { slug: "gaplogic", title: "Gaplogic", description: "Web y ecosistema digital de Gaplogic: web WordPress, POS gapcloud y reporte de tareas." },
  { slug: "gaudioart", title: "Gaudio Art | Diseño de trofeos exclusivos", description: "Diseño de trofeos exclusivos." },
  { slug: "kncelados", title: "Kncelados (podcast)", description: "Web oficial del podcast Kncelados, con episodios y colecciones." },
  { slug: "mando", title: "Mando", description: "Convierte iPhones y navegadores en mandos virtuales de Xbox 360 para Windows." },
];

function mockRequest(lastUserContent: string): AiRequest {
  return {
    system: "Eres el asistente del porfolio.",
    messages: [{ role: "user", content: lastUserContent }],
    tools: [],
    maxTokens: 512,
  };
}

/** Representative question per intent, used for reply-content checks. */
const QUESTION_PER_INTENT: Record<string, string> = {
  saludo: "Hola",
  quien_eres: "¿Quién eres?",
  experiencia: "¿Cuánta experiencia tienes?",
  skills: "¿Cuál es tu stack?",
  servicios: "¿Qué servicios ofreces?",
  proyectos: "¿Qué proyectos tienes?",
  proyecto_concreto: "¿Me cuentas sobre el proyecto botanic?",
  contacto: "¿Cómo te contacto?",
  web: "¿Cómo está hecha esta web?",
  trabajo_colab: "¿Te puedo contratar para un freelance?",
  fallback: "¿Cuánto cuesta tu casa?",
};

describe("normalizeText (normalized matching basis)", () => {
  it("lowercases and strips accents from questions (punctuation kept)", () => {
    expect(normalizeText("¿QUIÉN ERES TÚ?")).toBe("¿quien eres tu?");
    expect(normalizeText("Habilidades y Tecnologías")).toBe("habilidades y tecnologias");
  });

  it("keeps punctuation and diacritic-free characters intact", () => {
    expect(normalizeText("Hola, ¿qué tal?")).toBe("hola, ¿que tal?");
  });
});

describe("patternWeight (longer phrases score higher)", () => {
  it("weights a single keyword at 1", () => {
    expect(patternWeight("hola")).toBe(1);
    expect(patternWeight("proyectos")).toBe(1);
  });

  it("weights multi-word patterns by word count", () => {
    expect(patternWeight("quien eres")).toBe(2);
    expect(patternWeight("que has hecho")).toBe(3);
    expect(patternWeight("quien hizo el chat")).toBe(4);
  });

  it("treats idiomatic greetings as weak keywords regardless of length", () => {
    expect(patternWeight("que tal")).toBe(1);
    expect(patternWeight("buen dia")).toBe(1);
  });
});

describe("routeIntent — intent positives", () => {
  const cases: [string, string][] = [
    ["Hola", "saludo"],
    ["¡Buenas tardes!", "saludo"],
    ["¿Qué tal?", "saludo"],
    ["¿Quién eres?", "quien_eres"],
    ["Preséntate", "quien_eres"],
    ["Cuéntame sobre ti", "quien_eres"],
    ["Háblame de ti", "quien_eres"],
    ["¿Quién es Albert?", "quien_eres"],
    ["¿Cuánta experiencia tienes?", "experiencia"],
    ["¿Me pasas tu CV?", "experiencia"],
    ["¿Dónde has trabajado?", "experiencia"],
    ["¿Cuál es tu trayectoria?", "experiencia"],
    ["¿Qué habilidades tienes?", "skills"],
    ["¿Cuál es tu stack?", "skills"],
    ["¿Qué tecnologías usas?", "skills"],
    ["¿Qué herramientas usas?", "skills"],
    ["¿Qué sabes hacer?", "skills"],
    ["¿Qué servicios ofreces?", "servicios"],
    ["¿Haces desarrollo web?", "servicios"],
    ["¿Haces diseño web?", "servicios"],
    ["¿Qué proyectos tienes?", "proyectos"],
    ["¿Tienes portfolio?", "proyectos"],
    ["¿Qué trabajos has hecho?", "proyectos"],
    ["¿Qué has creado?", "proyectos"],
    ["¿Tienes algún proyecto en curso?", "proyectos"],
    ["¿Cómo te contacto?", "contacto"],
    ["¿Tienes email?", "contacto"],
    ["¿Dónde está tu LinkedIn?", "contacto"],
    ["¿Me pasas tu GitHub?", "contacto"],
    ["¿Puedo escribirte?", "contacto"],
    ["¿Cómo contactarte?", "contacto"],
    ["Hablemos", "contacto"],
    ["¿Cómo está hecha esta web?", "web"],
    ["¿Quién hizo el chat?", "web"],
    ["¿Quién hizo esta web?", "web"],
    ["¿Qué es el chat?", "web"],
    ["¿Te puedo contratar?", "trabajo_colab"],
    ["¿Haces trabajo freelance?", "trabajo_colab"],
    ["¿Te interesa colaborar?", "trabajo_colab"],
    ["¿Cuánto cuesta un encargo?", "trabajo_colab"],
    ["¿Me haces un presupuesto?", "trabajo_colab"],
  ];

  it.each(cases)("routes %j to intent %s", (question, expected) => {
    const result = routeIntent(question, PROJECTS);
    expect(result.intent).toBe(expected);
    expect(result.project).toBeUndefined();
  });
});

describe("routeIntent — concrete project beats generic projects", () => {
  it("routes a question naming a known project to proyecto_concreto with its slug", () => {
    const result = routeIntent("¿Me cuentas sobre el proyecto botanic?", PROJECTS);
    expect(result.intent).toBe("proyecto_concreto");
    expect(result.project?.slug).toBe("botanic");
  });

  it("routes the bare keyword proyectos to the generic proyectos intent", () => {
    const result = routeIntent("proyectos", PROJECTS);
    expect(result.intent).toBe("proyectos");
    expect(result.project).toBeUndefined();
  });

  it("matches a project by its full title phrase", () => {
    const result = routeIntent("¿Qué es Facturas Gratis?", PROJECTS);
    expect(result.intent).toBe("proyecto_concreto");
    expect(result.project?.slug).toBe("facturasgratis");
  });

  it("matches the primary name of a composite title (pipe suffix)", () => {
    const result = routeIntent("¿Qué es Gaudio Art?", PROJECTS);
    expect(result.intent).toBe("proyecto_concreto");
    expect(result.project?.slug).toBe("gaudioart");
  });

  it("matches the primary name of a parenthetical title", () => {
    const result = routeIntent("¿Qué es kncelados?", PROJECTS);
    expect(result.intent).toBe("proyecto_concreto");
    expect(result.project?.slug).toBe("kncelados");
  });

  it("matches a bare project slug even when asked without the word proyecto", () => {
    const result = routeIntent("¿Qué es Mando?", PROJECTS);
    expect(result.intent).toBe("proyecto_concreto");
    expect(result.project?.slug).toBe("mando");
  });

  it("does not treat a generic projects question as a concrete project", () => {
    const result = routeIntent("¿Qué proyectos tienes?", PROJECTS);
    expect(result.intent).toBe("proyectos");
    expect(result.project).toBeUndefined();
  });
});

describe("routeIntent — negatives fall back honestly", () => {
  const negatives = [
    "¿Cuánto cuesta tu casa?",
    "¿Qué hora es?",
    "qué hora es",
    "Cuéntame un chiste",
    "¿Puedes escribir una novela?",
    "¿Cómo está el tiempo en Sitges?",
    "¿Cuál es tu salario?",
    "asdf qwerty",
  ];

  it.each(negatives)("routes %j to fallback (no false positives)", (question) => {
    const result = routeIntent(question, PROJECTS);
    expect(result.intent).toBe("fallback");
    expect(result.project).toBeUndefined();
  });
});

describe("routeIntent — accent and case insensitivity", () => {
  const cases: [string, string][] = [
    ["¿QUIÉN ERES TÚ?", "quien_eres"],
    ["¿HÁBLAME DE TI?", "quien_eres"],
    ["¿Qué TECNOLOGÍAS usas?", "skills"],
    ["¿CÓMO ESTÁ HECHA ESTA WEB?", "web"],
    ["¿ME PUEDES HABLAR DE BOTANIC?", "proyecto_concreto"],
  ];

  it.each(cases)("routes %j to intent %s", (question, expected) => {
    const result = routeIntent(question, PROJECTS);
    expect(result.intent).toBe(expected);
  });

  it("normalizes accented user input before matching", () => {
    expect(normalizeText("tecnologías").includes("tecnologias")).toBe(true);
  });
});

describe("guideReply — curated content per intent", () => {
  it("greets and lists what the guide can tell (saludo)", () => {
    expect(guideReply("Hola", PROJECTS)).toContain("Albert Verdu");
  });

  it("introduces from the about source (quien_eres)", () => {
    const reply = guideReply("¿Quién eres?", PROJECTS);
    expect(reply).toContain("Albert Verdu");
    expect(reply).toContain("design first");
    expect(reply).toContain("Sitges");
  });

  it("summarizes work history with collaborations (experiencia)", () => {
    const reply = guideReply("¿Cuánta experiencia tienes?", PROJECTS);
    expect(reply).toContain("20 años");
    expect(reply).toContain("SGL Vilanova");
    expect(reply).toContain("Botanic");
  });

  it("lists the main stack and design areas (skills)", () => {
    const reply = guideReply("¿Cuál es tu stack?", PROJECTS);
    expect(reply).toContain("Astro");
    expect(reply).toContain("SvelteKit");
    expect(reply).toContain("TypeScript");
  });

  it("summarizes services (servicios)", () => {
    const reply = guideReply("¿Qué servicios ofreces?", PROJECTS);
    expect(reply).toContain("Astro o SvelteKit");
    expect(reply).toContain("imprenta");
  });

  it("answers the projects listing with the projects widget (proyectos)", () => {
    const reply = guideReply("¿Qué proyectos tienes?", PROJECTS);
    expect(reply).toContain("[[widget:projects]]");
    expect(reply).not.toContain("[[widget:project ");
  });

  it("answers a concrete project with its title and project widget (proyecto_concreto)", () => {
    const reply = guideReply("¿Me cuentas sobre el proyecto botanic?", PROJECTS);
    expect(reply).toContain("Botanic");
    expect(reply).toContain('[[widget:project slug="botanic"]]');
  });

  it("answers contact with two link widgets (contacto)", () => {
    const reply = guideReply("¿Cómo te contacto?", PROJECTS);
    expect(reply.match(/\[\[widget:link url="https:\/\/linkedin\.com\/in\/albert-verdu"\]\]/g)).toHaveLength(1);
    expect(reply.match(/\[\[widget:link url="https:\/\/github\.com\/verdulife"\]\]/g)).toHaveLength(1);
    expect(reply.match(/\[\[widget:link/g)).toHaveLength(2);
    expect(reply).toContain("Sitges");
    // URLs appear only inside widget tokens, never as bare prose URLs.
    expect(reply.replace(/\[\[widget:[^\]]*\]\]/g, "")).not.toContain("https://");
  });

  it("answers the chat/web question honestly (web)", () => {
    const reply = guideReply("¿Cómo está hecha esta web?", PROJECTS);
    expect(reply).toContain("Astro");
    expect(reply).toContain("Cloudflare");
    expect(reply).toContain("modo guía");
  });

  it("offers services and a contact link (trabajo_colab)", () => {
    const reply = guideReply("¿Te puedo contratar para un freelance?", PROJECTS);
    expect(reply).toContain("presupuesto");
    expect(reply).toContain('[[widget:link url="https://linkedin.com/in/albert-verdu"]]');
    expect(reply.match(/\[\[widget:link/g)).toHaveLength(1);
  });

  it("is honest in the fallback and lists suggestions inline (fallback)", () => {
    const reply = guideReply("¿Cuánto cuesta tu casa?", PROJECTS);
    expect(reply).toContain("modo guía");
    expect(reply).toContain("no está cubierta");
    expect(reply).toContain("¿Quién eres?");
    expect(reply).toContain("¿Cómo contactarte?");
    expect(reply).not.toContain("[[widget:");
  });

  it("keeps every reply within MAX_OUTPUT_CHARS and non-empty", () => {
    for (const question of Object.values(QUESTION_PER_INTENT)) {
      const reply = guideReply(question, PROJECTS);
      expect(reply.length).toBeGreaterThan(0);
      expect(reply.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
    }
  });

  it("never uses voseo conjugations in curated prose", () => {
    for (const question of Object.values(QUESTION_PER_INTENT)) {
      const reply = guideReply(question, PROJECTS);
      expect(reply).not.toMatch(/tenés|querés|podés|hacés|sabés/i);
    }
  });
});

describe("GuideAIProvider.generate — provider contract", () => {
  const provider = new GuideAIProvider({ projects: PROJECTS });

  it("returns non-empty text and null toolCalls", async () => {
    const result = await provider.generate(mockRequest("¿Quién eres?"));
    expect(result.text).not.toBeNull();
    expect((result.text ?? "").length).toBeGreaterThan(0);
    expect(result.toolCalls).toBeNull();
  });

  it("is deterministic across calls for the same question", async () => {
    const first = await provider.generate(mockRequest("¿Qué tecnologías usas?"));
    const second = await provider.generate(mockRequest("¿Qué tecnologías usas?"));
    expect(first.text).toBe(second.text);
    expect(first.text).toContain("TailwindCSS");
  });

  it("routes on the LAST user message, ignoring earlier turns", async () => {
    const result = await provider.generate({
      system: "Eres el asistente del porfolio.",
      messages: [
        { role: "user", content: "Hola" },
        { role: "assistant", content: "Hola, ¿qué quieres saber?" },
        { role: "user", content: "¿Cuál es tu stack?" },
      ],
      tools: [],
      maxTokens: 512,
    });
    expect(result.text).toContain("SvelteKit");
  });

  it("answers a concrete project question with the project widget", async () => {
    const result = await provider.generate(mockRequest("¿Me cuentas sobre botanic?"));
    expect(result.text).toContain('[[widget:project slug="botanic"]]');
    expect(result.toolCalls).toBeNull();
  });

  it("never crashes and falls back honestly with no user message", async () => {
    const result = await provider.generate({
      system: "Eres el asistente del porfolio.",
      messages: [{ role: "assistant", content: "Hola" }],
      tools: [],
      maxTokens: 512,
    });
    expect(result.text).toContain("modo guía");
    expect(result.text).toContain("no está cubierta");
  });

  it("never crashes on an empty question and falls back", async () => {
    const result = await provider.generate(mockRequest(""));
    expect(result.text).toContain("modo guía");
    expect(result.toolCalls).toBeNull();
  });
});

describe("GUIDE_SUGGESTIONS — constant shape", () => {
  it("exposes the v1 suggestion questions in order", () => {
    expect(GUIDE_SUGGESTIONS).toEqual([
      "¿Quién eres?",
      "¿Qué proyectos tienes?",
      "¿Qué tecnologías usas?",
      "¿Cómo contactarte?",
    ]);
  });

  it("exposes exactly four non-empty question strings", () => {
    expect(GUIDE_SUGGESTIONS).toHaveLength(4);
    for (const suggestion of GUIDE_SUGGESTIONS) {
      expect(typeof suggestion).toBe("string");
      expect(suggestion.length).toBeGreaterThan(0);
      expect(suggestion).toMatch(/\?$/);
    }
  });

  it("every suggestion routes to a non-fallback intent (chips work)", () => {
    for (const suggestion of GUIDE_SUGGESTIONS) {
      expect(routeIntent(suggestion, PROJECTS).intent).not.toBe("fallback");
    }
  });
});

describe("router internals available for review", () => {
  it("exposes a minimum intent score constant", () => {
    expect(MIN_INTENT_SCORE).toBe(1);
  });

  it("findConcreteProject returns null when no project is named", () => {
    expect(findConcreteProject("¿Qué proyectos tienes?", PROJECTS)).toBeNull();
  });

  it("replyForIntent stays deterministic for a routed result", () => {
    const routed = routeIntent("¿Quién eres?", PROJECTS);
    expect(replyForIntent(routed)).toBe(replyForIntent(routed));
  });
});