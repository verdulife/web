import type { ChatMessage, ChatRequest, ErrorResponse } from "./types";

export interface Limits {
  maxMessages: number;
  maxInputChars: number;
  maxOutputTokens: number;
  maxToolCalls: number;
  docMaxChars: number;
  rateLimitPerMinute: number;
}

/** Shape of the env keys this module consumes; both Env and test fixtures fit structurally. */
export interface LimitsEnvShape {
  MAX_MESSAGES?: string;
  MAX_INPUT_CHARS?: string;
  MAX_OUTPUT_TOKENS?: string;
  MAX_TOOL_CALLS?: string;
  DOC_MAX_CHARS?: string;
  RATE_LIMIT_PER_MINUTE?: string;
}

export const DEFAULT_LIMITS: Limits = {
  maxMessages: 8,
  maxInputChars: 2000,
  maxOutputTokens: 512,
  maxToolCalls: 3,
  docMaxChars: 6000,
  rateLimitPerMinute: 30,
};

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function limitsFromEnv(env: LimitsEnvShape): Limits {
  return {
    maxMessages: positiveInt(env.MAX_MESSAGES, DEFAULT_LIMITS.maxMessages),
    maxInputChars: positiveInt(env.MAX_INPUT_CHARS, DEFAULT_LIMITS.maxInputChars),
    maxOutputTokens: positiveInt(env.MAX_OUTPUT_TOKENS, DEFAULT_LIMITS.maxOutputTokens),
    maxToolCalls: positiveInt(env.MAX_TOOL_CALLS, DEFAULT_LIMITS.maxToolCalls),
    docMaxChars: positiveInt(env.DOC_MAX_CHARS, DEFAULT_LIMITS.docMaxChars),
    rateLimitPerMinute: positiveInt(env.RATE_LIMIT_PER_MINUTE, DEFAULT_LIMITS.rateLimitPerMinute),
  };
}

function invalid(code: string, message: string): { ok: false; error: ErrorResponse["error"] } {
  return { ok: false, error: { code, message, retryable: false } };
}

// Payload cap from the App contract: total messages <= 12.
export const MAX_PAYLOAD_MESSAGES = 12;

export function validateChatRequest(
  body: unknown,
  limits: Limits = DEFAULT_LIMITS,
):
  | { ok: true; request: ChatRequest }
  | { ok: false; error: ErrorResponse["error"] } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return invalid("invalid_payload", "El payload no es un objeto JSON válido.");
  }
  const raw = body as Record<string, unknown>;

  if (!Array.isArray(raw.messages)) {
    return invalid("invalid_payload", "Falta el campo messages.");
  }
  if (raw.messages.length < 1) {
    return invalid("empty_messages", "La conversación no puede estar vacía.");
  }
  if (raw.messages.length > MAX_PAYLOAD_MESSAGES) {
    return invalid(
      "too_many_messages",
      `Demasiados mensajes: máximo ${MAX_PAYLOAD_MESSAGES}.`,
    );
  }

  const messages: ChatMessage[] = [];
  for (const item of raw.messages) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return invalid("invalid_message", "Cada mensaje debe ser un objeto.");
    }
    const message = item as Record<string, unknown>;
    if (message.role !== "user" && message.role !== "assistant") {
      return invalid("invalid_role", "El rol debe ser user o assistant.");
    }
    if (typeof message.content !== "string") {
      return invalid("invalid_content", "El contenido del mensaje debe ser texto.");
    }
    const content = message.content.trim();
    if (content.length < 1) {
      return invalid("empty_content", "El mensaje no puede estar vacío.");
    }
    if (content.length > limits.maxInputChars) {
      return invalid(
        "content_too_long",
        `El mensaje supera el límite de ${limits.maxInputChars} caracteres.`,
      );
    }
    messages.push({ role: message.role, content });
  }

  if (messages[0]?.role !== "user") {
    return invalid("first_message_role", "La conversación debe empezar con un mensaje de usuario.");
  }

  const request: ChatRequest = { messages };
  if (typeof raw.threadId === "string" && raw.threadId.trim().length > 0) {
    request.threadId = raw.threadId;
  }
  return { ok: true, request };
}

export function trimMessages(messages: ChatMessage[], max: number): ChatMessage[] {
  if (max < 1) return [];
  if (messages.length <= max) return [...messages];
  const kept = messages.slice(messages.length - max);
  if (kept[0]?.role === "assistant") return kept.slice(1);
  return kept;
}