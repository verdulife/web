/**
 * Constrained agent loop: the model may request a single tool
 * (get_knowledge_document) across at most limits.maxToolCalls tool-enabled
 * turns; the tool stays available on every call because llama-family
 * tool-calling fine-tunes answer with text exactly when the tool is present.
 *
 * When that tool budget runs out without a final text, the loop does ONE last
 * mandatory "settle" call with no tools at all, which forces an answer from the
 * documents already retrieved instead of a 502. Budget semantics: the settle
 * call is IN ADDITION to the tool budget, so total provider calls stay
 * <= limits.maxToolCalls + 1.
 *
 * History uses the OpenAI-compatible function-calling message shape that
 * llama-family models expect: after each tool call push
 * { role: "assistant", content: "", tool_calls: [{ id, type, function }] }
 * followed by one
 * { role: "tool", tool_call_id: id, name, content: JSON.stringify(result) }
 * per call. Tool resolution is non-fatal: a failure becomes an error result and
 * the loop keeps going.
 *
 * `content` is an empty string, never null: the Workers AI request schema
 * rejects null message content ("Type mismatch of '/messages/N/content',
 * 'string' not in 'null'"), which surfaced live as a 502 ai_unavailable.
 */
import type { AIProvider, AiRequest, AiResponse, AiTool } from "./ai";
import { normalizeToolArguments } from "./ai";
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

/**
 * Forced final answer. Sent as a user message with no tools available, so the
 * model can only reply with text (never another document request).
 */
const SETTLE_INSTRUCTION =
  "Resume ahora tu respuesta en español usando únicamente la información de los documentos ya recuperados en esta conversación. Si no tienes información suficiente o nada relevante, responde con un redireccionamiento cortés a los apartados del porfolio. No pidas más documentos.";

export async function runChat(
  deps: ChatRunDeps,
  systemPrompt: string,
  messages: ChatMessage[],
  provider: AIProvider,
  knowledge: KnowledgeProvider,
): Promise<ChatRunResult> {
  // Tool budget: tool-enabled turns only. The settle call below is one extra
  // provider call, so the run never exceeds maxToolCalls + 1 calls in total.
  const maxToolTurns = deps.limits.maxToolCalls;
  const history: AiRequest["messages"] = messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
  const sources = new Set<string>();
  const toolId = { next: 0 };

  for (let turn = 0; turn < maxToolTurns; turn += 1) {
    const response = await generateTurn(
      provider,
      systemPrompt,
      history,
      [GET_KNOWLEDGE_DOCUMENT_TOOL],
      deps.limits.maxOutputTokens,
    );
    if (response.text !== null && (response.toolCalls === null || response.toolCalls.length === 0)) {
      return { reply: response.text, sources: [...sources] };
    }
    if (response.toolCalls !== null && response.toolCalls.length > 0) {
      await executeToolCalls(history, sources, toolId, knowledge, response.toolCalls);
      continue;
    }
    break;
  }

  return await settleChat(provider, systemPrompt, history, sources, deps.limits.maxOutputTokens);
}

/**
 * Mandatory one-shot final turn once the tool budget is spent: no tools are
 * offered (Cloudflare rejects an empty `tools` array, so the adapter omits the
 * field entirely) and a closing user instruction asks for an answer built from
 * the documents already retrieved. `sources` is untouched: it stays the set of
 * ids actually fetched earlier. If even this call yields no text, the run fails
 * through the existing ai_unavailable path.
 */
async function settleChat(
  provider: AIProvider,
  systemPrompt: string,
  history: AiRequest["messages"],
  sources: Set<string>,
  maxTokens: number,
): Promise<ChatRunResult> {
  history.push({ role: "user", content: SETTLE_INSTRUCTION });
  const response = await generateTurn(provider, systemPrompt, history, [], maxTokens);
  if (response.text !== null && response.text.trim() !== "") {
    return { reply: response.text, sources: [...sources] };
  }

  console.error("[chat]", "model returned no usable output after the settle call");
  throw new ChatRunError(
    "ai_unavailable",
    "El proveedor no devolvió respuesta ni llamadas a herramienta.",
  );
}

/** One provider call; any provider failure maps to ChatRunError(ai_error). */
async function generateTurn(
  provider: AIProvider,
  systemPrompt: string,
  history: AiRequest["messages"],
  tools: AiTool[],
  maxTokens: number,
): Promise<AiResponse> {
  try {
    return await provider.generate({ system: systemPrompt, messages: history, tools, maxTokens });
  } catch (error) {
    throw new ChatRunError("ai_error", toErrorMessage(error));
  }
}

/**
 * Resolves a batch of tool calls: one assistant message carrying all of them,
 * then one tool message per call, pairing each with its id. Nothing here may
 * throw; tool failures become error results and sources only collect successful
 * document ids.
 */
async function executeToolCalls(
  history: AiRequest["messages"],
  sources: Set<string>,
  toolId: { next: number },
  knowledge: KnowledgeProvider,
  toolCalls: { name: string; arguments: Record<string, unknown> }[],
): Promise<void> {
  const batchId = toolId.next;
  toolId.next += 1;

  const resolved = await Promise.all(
    toolCalls.map(async (call, index) => {
      const name = call.name.trim() === "" ? GET_KNOWLEDGE_DOCUMENT_TOOL.name : call.name;
      // Ids must be unique inside one assistant message; the first call of the
      // batch keeps the canonical `call_<batchId>` form.
      const id = index === 0 ? `call_${batchId}` : `call_${batchId}_${index}`;
      const args = normalizeToolArguments(call.arguments);
      const outcome = await resolveKnowledgeDocument(knowledge, args);
      if (outcome.id !== undefined) sources.add(outcome.id);
      return { id, name, args, payload: outcome.payload };
    }),
  );

  history.push({
    role: "assistant",
    content: "",
    tool_calls: resolved.map((item) => ({
      id: item.id,
      type: "function",
      function: { name: item.name, arguments: safeStringify(item.args) },
    })),
  });
  for (const item of resolved) {
    history.push({
      role: "tool",
      tool_call_id: item.id,
      name: item.name,
      content: safeStringify(item.payload),
    });
  }
}

interface ToolOutcome {
  id: string | undefined;
  payload: Record<string, unknown>;
}

/**
 * Resolves one tool call into a JSON-serializable result. Nothing here may
 * throw: an unexpected failure becomes { ok: false, error: message }.
 */
async function resolveKnowledgeDocument(
  knowledge: KnowledgeProvider,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  try {
    return await fetchKnowledgeDocument(knowledge, args);
  } catch (error) {
    return { id: undefined, payload: { ok: false, error: toErrorMessage(error) } };
  }
}

/** Server-side allowlist enforcement happens here (document_id guard + provider). */
async function fetchKnowledgeDocument(
  knowledge: KnowledgeProvider,
  toolArguments: Record<string, unknown>,
): Promise<ToolOutcome> {
  const documentId = toolArguments.document_id;
  if (typeof documentId !== "string" || documentId.trim() === "") {
    return {
      id: undefined,
      payload: { ok: false, error: "document_id invalido", valid_ids: knownIds(knowledge) },
    };
  }

  let document;
  try {
    document = await knowledge.getDocument(documentId.trim());
  } catch {
    return { id: undefined, payload: { ok: false, error: "error al recuperar el documento" } };
  }

  if (document === null) {
    // The model sometimes invents a topic id ("projects"). Returning the real
    // ids (plus a general-overview suggestion) lets it self-correct on the next
    // turn instead of looping towards the turn budget.
    return {
      id: undefined,
      payload: {
        ok: false,
        error: "documento no encontrado",
        valid_ids: knownIds(knowledge),
        sugerencia:
          'Para una visión general usa "about" o "skills"; para proyectos usa un documento de proyecto de la lista.',
      },
    };
  }

  return {
    id: document.id,
    payload: { ok: true, id: document.id, title: document.title, content: document.content },
  };
}

/** Best-effort list of selectable document ids for tool-error feedback. */
function knownIds(knowledge: KnowledgeProvider): string[] {
  try {
    return knowledge.index().map((entry) => entry.id);
  } catch {
    return [];
  }
}

/** JSON for the provider payloads; never throws on unexpected values. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "{}";
  } catch {
    return "{}";
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}