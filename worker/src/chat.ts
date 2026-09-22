/**
 * Constrained agent loop: at most limits.maxToolCalls turns, a single tool
 * (get_knowledge_document). History follows the Cloudflare traditional
 * function-calling message shape: after each tool call push
 * { role: "assistant", content: JSON.stringify(call) } followed by
 * { role: "tool", content: JSON.stringify(result) }.
 */
import type { AIProvider, AiRequest, AiResponse, AiTool } from "./ai";
import type { KnowledgeProvider } from "./knowledge";
import type { Limits } from "./limits";
import type { ChatMessage } from "./types";

/** Raised when the model loop cannot produce a final answer for the user. */
export class ChatRunError extends Error {
  constructor(
    public readonly code: "ai_unavailable" | "ai_error",
    message: string,
  ) {
    super(message);
    this.name = "ChatRunError";
  }
}

/** The only tool the model may use: fetch a knowledge document by id. */
export const GET_KNOWLEDGE_DOCUMENT_TOOL: AiTool = {
  name: "get_knowledge_document",
  description:
    "Recupera un documento del conocimiento del porfolio. Recibe un document_id válido de la lista CONOCIMIENTO DISPONIBLE y devuelve el contenido completo de ese documento.",
  parameters: {
    type: "object",
    properties: {
      document_id: {
        type: "string",
        description:
          "Identificador del documento tal y como aparece en la lista CONOCIMIENTO DISPONIBLE (p. ej. about, skills, gaplogic, alter).",
      },
    },
    required: ["document_id"],
  },
};

/** Minimal env-derived deps (limits come from env vars in production). */
export interface ChatRunDeps {
  limits: Limits;
}

export interface ChatRunResult {
  reply: string;
  sources: string[];
}

export async function runChat(
  deps: ChatRunDeps,
  systemPrompt: string,
  messages: ChatMessage[],
  provider: AIProvider,
  knowledge: KnowledgeProvider,
): Promise<ChatRunResult> {
  const maxTurns = deps.limits.maxToolCalls;
  const history: AiRequest["messages"] = messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
  const sources = new Set<string>();

  for (let turn = 0; turn < maxTurns; turn += 1) {
    let response: AiResponse;
    try {
      response = await provider.generate({
        system: systemPrompt,
        messages: history,
        tools: [GET_KNOWLEDGE_DOCUMENT_TOOL],
        maxTokens: deps.limits.maxOutputTokens,
      });
    } catch (error) {
      throw new ChatRunError("ai_error", toErrorMessage(error));
    }

    if (response.toolCalls !== null && response.toolCalls.length > 0) {
      for (const call of response.toolCalls) {
        const result = await fetchKnowledgeDocument(knowledge, call.arguments);
        if (result.ok) sources.add(result.id);
        history.push({ role: "assistant", content: JSON.stringify(call) });
        history.push({ role: "tool", content: JSON.stringify(result.payload) });
      }
      continue;
    }

    if (response.text !== null) {
      return { reply: response.text, sources: [...sources] };
    }

    throw new ChatRunError(
      "ai_unavailable",
      "El proveedor no devolvió respuesta ni llamadas a herramienta.",
    );
  }

  throw new ChatRunError(
    "ai_unavailable",
    `Se alcanzó el máximo de ${maxTurns} turnos sin una respuesta final.`,
  );
}

type KnowledgeFetchResult =
  | { ok: true; id: string; payload: { ok: true; id: string; title: string; content: string } }
  | { ok: false; id: undefined; payload: { ok: false; error: string } };

/** Server-side allowlist enforcement happens here (document_id guard + provider). */
async function fetchKnowledgeDocument(
  knowledge: KnowledgeProvider,
  toolArguments: Record<string, unknown>,
): Promise<KnowledgeFetchResult> {
  const documentId = toolArguments.document_id;
  if (typeof documentId !== "string" || documentId.trim() === "") {
    return { ok: false, id: undefined, payload: { ok: false, error: "document_id invalido" } };
  }

  let document;
  try {
    document = await knowledge.getDocument(documentId.trim());
  } catch {
    return { ok: false, id: undefined, payload: { ok: false, error: "error al recuperar el documento" } };
  }

  if (document === null) {
    return { ok: false, id: undefined, payload: { ok: false, error: "documento no encontrado" } };
  }

  return {
    ok: true,
    id: document.id,
    payload: { ok: true, id: document.id, title: document.title, content: document.content },
  };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}