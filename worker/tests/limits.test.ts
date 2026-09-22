import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, limitsFromEnv, trimMessages, validateChatRequest } from "../src/limits";
import type { ChatMessage } from "../src/types";

const user = (content: string): ChatMessage => ({ role: "user", content });

describe("validateChatRequest", () => {
  it("accepts a valid request and trims message content", () => {
    const result = validateChatRequest({ messages: [{ role: "user", content: "  Hola  " }] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.messages).toHaveLength(1);
    expect(result.request.messages[0].content).toBe("Hola");
  });

  it("retains an optional threadId and drops a blank one", () => {
    const result = validateChatRequest({
      messages: [{ role: "user", content: "Hola" }],
      threadId: "abc-123",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.threadId).toBe("abc-123");

    const blank = validateChatRequest({
      messages: [{ role: "user", content: "Hola" }],
      threadId: "   ",
    });
    expect(blank.ok).toBe(true);
    if (!blank.ok) return;
    expect(blank.request.threadId).toBeUndefined();
  });

  it("rejects bodies that are not plain JSON objects", () => {
    for (const body of [null, "hola", 42, ["messages"], undefined]) {
      expect(validateChatRequest(body).ok).toBe(false);
    }
  });

  it("rejects missing or empty messages", () => {
    expect(validateChatRequest({}).ok).toBe(false);
    expect(validateChatRequest({ messages: [] }).ok).toBe(false);
    expect(validateChatRequest({ messages: "nope" }).ok).toBe(false);
  });

  it("rejects more than 12 messages", () => {
    const messages = Array.from({ length: 13 }, (_, index) => user(`mensaje ${index}`));
    const result = validateChatRequest({ messages });
    expect(result.ok).toBe(false);
  });

  it("rejects empty or whitespace-only content", () => {
    expect(validateChatRequest({ messages: [{ role: "user", content: "" }] }).ok).toBe(false);
    expect(validateChatRequest({ messages: [{ role: "user", content: "   " }] }).ok).toBe(false);
  });

  it("rejects content longer than maxInputChars (default and custom)", () => {
    const tooLong = `a`.repeat(DEFAULT_LIMITS.maxInputChars + 1);
    expect(validateChatRequest({ messages: [{ role: "user", content: tooLong }] }).ok).toBe(false);

    const customLimits = limitsFromEnv({ MAX_INPUT_CHARS: "10" });
    expect(validateChatRequest({ messages: [{ role: "user", content: "a".repeat(11) }] }, customLimits).ok).toBe(false);
    expect(validateChatRequest({ messages: [{ role: "user", content: "a".repeat(10) }] }, customLimits).ok).toBe(true);
  });

  it("rejects invalid roles", () => {
    const result = validateChatRequest({ messages: [{ role: "system", content: "x" }] });
    expect(result.ok).toBe(false);
  });

  it("rejects a first message that is not a user message (400 contract)", () => {
    const result = validateChatRequest({
      messages: [
        { role: "assistant", content: "Hola, ¿en qué te ayudo?" },
        { role: "user", content: "Hola" },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("first_message_role");
    expect(result.error.retryable).toBe(false);
  });
});

describe("trimMessages", () => {
  it("keeps only the last max messages", () => {
    const messages = Array.from({ length: 10 }, (_, index) => user(`m${index}`));
    const trimmed = trimMessages(messages, 8);
    expect(trimmed).toHaveLength(8);
    expect(trimmed.map((m) => m.content)).toEqual(["m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9"]);
  });

  it("drops a leading assistant message from the kept window", () => {
    const messages = [
      user("m0"),
      user("m1"),
      { role: "assistant" as const, content: "a2" },
      user("m3"),
      user("m4"),
      user("m5"),
      user("m6"),
      user("m7"),
      user("m8"),
      user("m9"),
    ];
    const trimmed = trimMessages(messages, 8);
    expect(trimmed).toHaveLength(7);
    expect(trimmed[0].role).toBe("user");
    expect(trimmed[0].content).toBe("m3");
  });

  it("leaves fewer-than-max messages unchanged", () => {
    const messages = [user("m0"), user("m1"), user("m2")];
    expect(trimMessages(messages, 8)).toEqual(messages);
    expect(trimMessages(messages, 3)).toEqual(messages);
  });

  it("handles a zero max defensively", () => {
    expect(trimMessages([user("m0")], 0)).toEqual([]);
  });
});