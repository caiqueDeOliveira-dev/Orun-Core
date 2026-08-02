import { describe, it, expect } from "vitest";
import {
  isCloudReachableProvider,
  validateRelayRequest,
  validateAgentIsUsable,
  buildHistory,
  nextSeqAfter,
  type AgentConfig,
} from "./logic";

describe("isCloudReachableProvider", () => {
  it("claude and the OpenAI-compatible providers are reachable", () => {
    expect(isCloudReachableProvider("claude")).toBe(true);
    expect(isCloudReachableProvider("openai")).toBe(true);
    expect(isCloudReachableProvider("openrouter")).toBe(true);
    expect(isCloudReachableProvider("groq")).toBe(true);
    expect(isCloudReachableProvider("github")).toBe(true);
  });

  it("ollama is NOT reachable — it's local-only by design", () => {
    expect(isCloudReachableProvider("ollama")).toBe(false);
  });

  it("an unknown provider string is not reachable", () => {
    expect(isCloudReachableProvider("some-made-up-provider")).toBe(false);
  });
});

describe("validateRelayRequest", () => {
  it("accepts a well-formed body", () => {
    const result = validateRelayRequest({ conversationId: "c1", agentId: "hampton", content: "oi" });
    expect(result).toEqual({ conversationId: "c1", agentId: "hampton", content: "oi" });
  });

  it("rejects a missing conversationId", () => {
    expect(() => validateRelayRequest({ agentId: "hampton", content: "oi" })).toThrow();
  });

  it("rejects empty/whitespace-only content", () => {
    expect(() => validateRelayRequest({ conversationId: "c1", agentId: "hampton", content: "   " })).toThrow();
  });

  it("rejects a completely malformed body (not an object)", () => {
    expect(() => validateRelayRequest(null)).toThrow();
    expect(() => validateRelayRequest("just a string")).toThrow();
  });
});

describe("validateAgentIsUsable", () => {
  const baseAgent: AgentConfig = {
    id: "hampton",
    name: "Hampton",
    default_provider: "claude",
    default_model: "claude-sonnet-5",
    persona_prompt: null,
  };

  it("passes for a properly configured cloud agent", () => {
    expect(() => validateAgentIsUsable(baseAgent)).not.toThrow();
  });

  it("throws when the agent doesn't exist", () => {
    expect(() => validateAgentIsUsable(null)).toThrow(/not found/);
  });

  it("throws when the agent has no provider/model configured", () => {
    expect(() => validateAgentIsUsable({ ...baseAgent, default_provider: null })).toThrow(/no provider/);
  });

  it("throws a clear, honest error when the agent is assigned to Ollama (local-only)", () => {
    expect(() => validateAgentIsUsable({ ...baseAgent, default_provider: "ollama" })).toThrow(/local-only/);
  });
});

describe("buildHistory", () => {
  it("puts the persona prompt first as a system turn when present", () => {
    const history = buildHistory("Você é o Hampton.", [], "oi");
    expect(history[0]).toEqual({ role: "system", content: "Você é o Hampton." });
  });

  it("omits the system turn when there's no persona prompt", () => {
    const history = buildHistory(null, [], "oi");
    expect(history.every((h) => h.role !== "system")).toBe(true);
  });

  it("reverses newest-first history into oldest-first order, then appends the new user message last", () => {
    const recentNewestFirst = [
      { role: "assistant", content: "resposta 2", seq: 4 },
      { role: "user", content: "pergunta 2", seq: 3 },
      { role: "assistant", content: "resposta 1", seq: 2 },
      { role: "user", content: "pergunta 1", seq: 1 },
    ];
    const history = buildHistory(null, recentNewestFirst, "pergunta 3");
    expect(history.map((h) => h.content)).toEqual([
      "pergunta 1",
      "resposta 1",
      "pergunta 2",
      "resposta 2",
      "pergunta 3",
    ]);
  });

  it("ignores rows with an unexpected role instead of crashing", () => {
    const weird = [{ role: "tool_call", content: "??", seq: 1 }];
    const history = buildHistory(null, weird as any, "oi");
    expect(history).toEqual([{ role: "user", content: "oi" }]);
  });
});

describe("nextSeqAfter", () => {
  it("returns 1 when there's no previous message", () => {
    expect(nextSeqAfter(null)).toBe(1);
    expect(nextSeqAfter(undefined)).toBe(1);
  });

  it("increments from the last seq", () => {
    expect(nextSeqAfter(7)).toBe(8);
  });
});
