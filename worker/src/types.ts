import type { Widget } from "./widgets";

export interface Env {
  AI: any;
  MODEL_ID: string;
  /** Provider selection: mock (CLI dev only) | gemini (default) | cloudflare (legacy). */
  AI_PROVIDER?: string;
  /**
   * Secret key for the Gemini provider. Local dev: `worker/.dev.vars`; prod:
   * `wrangler secret put GEMINI_API_KEY`. Never a `[vars]` entry.
   */
  GEMINI_API_KEY?: string;
  GITHUB_REPO: string;
  GITHUB_REF: string;
  GITHUB_TOKEN: string;
  ALLOWED_ORIGINS: string;
  RATE_LIMIT_PER_MINUTE: string;
  MAX_MESSAGES: string;
  MAX_INPUT_CHARS: string;
  MAX_OUTPUT_TOKENS: string;
  MAX_TOOL_CALLS: string;
  DOC_MAX_CHARS: string;
  RATE_LIMITER?: {
    limit(opts: { key: string }): Promise<{ success: boolean; reset?: unknown }>;
  };
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  threadId?: string;
}

export interface ChatResponse {
  reply: string;
  /** Validated inline widgets, present when the reply contains any. */
  widgets?: Widget[];
  sources: string[];
}

export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

export interface KnowledgeIndexEntry {
  id: string;
  path: string;
  kind: string;
  /** Canonical project URL, present on project-kind entries. */
  url?: string;
  title: string;
  description: string;
}

export interface KnowledgeDocument {
  id: string;
  title: string;
  content: string;
}