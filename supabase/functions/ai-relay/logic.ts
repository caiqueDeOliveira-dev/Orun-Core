// Pure logic used by ai-relay/index.ts, extracted so it can be unit-tested
// with Vitest in plain Node — the Deno-specific parts (Deno.serve,
// Deno.env, the actual fetch() calls to provider APIs) can't run outside a
// real Deno runtime, so they're NOT covered by these tests. This file has
// zero Deno-specific imports on purpose.

export interface ChatTurn {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface AgentConfig {
  id: string;
  name: string;
  default_provider: string | null;
  default_model: string | null;
  persona_prompt: string | null;
}

export interface StoredMessage {
  role: string;
  content: string;
  seq: number;
}

// Providers reachable from a cloud function. Ollama is deliberately absent
// — see the doc comment in index.ts for why.
export const OPENAI_COMPATIBLE_ENDPOINTS: Record<string, string> = {
  openai: "https://api.openai.com/v1/chat/completions",
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  groq: "https://api.groq.com/openai/v1/chat/completions",
  github: "https://models.inference.ai.azure.com/chat/completions",
  opencode: "https://opencode.ai/zen/v1/chat/completions",
};

export const PROVIDER_ENV_KEY: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  groq: "GROQ_API_KEY",
  github: "GITHUB_MODELS_TOKEN",
  claude: "ANTHROPIC_API_KEY",
  opencode: "OPENCODE_API_KEY",
};

export function isCloudReachableProvider(provider: string): boolean {
  return provider === "claude" || provider in OPENAI_COMPATIBLE_ENDPOINTS;
}

export function validateRelayRequest(body: unknown): { conversationId: string; agentId: string; content: string } {
  const b = body as Record<string, unknown>;
  const conversationId = typeof b?.conversationId === "string" ? b.conversationId : "";
  const agentId = typeof b?.agentId === "string" ? b.agentId : "";
  const content = typeof b?.content === "string" ? b.content : "";

  if (!conversationId || !agentId || !content.trim()) {
    throw new Error("conversationId, agentId and content are required");
  }
  return { conversationId, agentId, content };
}

export function validateAgentIsUsable(agent: AgentConfig | null): asserts agent is AgentConfig & {
  default_provider: string;
  default_model: string;
} {
  if (!agent) throw new Error("Agent not found");
  if (!agent.default_provider || !agent.default_model) {
    throw new Error(`Agent "${agent.name}" has no provider/model configured`);
  }
  if (!isCloudReachableProvider(agent.default_provider)) {
    throw new Error(
      `Provider "${agent.default_provider}" isn't reachable from ai-relay. Ollama is local-only — this ` +
        `agent needs a cloud provider assigned (claude/openai/openrouter/groq/github) to work from mobile ` +
        `without the PC on.`
    );
  }
}

/**
 * Builds the ordered chat history sent to the provider: optional system
 * prompt first, then existing messages oldest-first, then the new user turn.
 * `recentMessages` is expected newest-first (as returned by an
 * `order('seq', {ascending: false})` query) and gets reversed here.
 */
export function buildHistory(
  personaPrompt: string | null,
  recentMessagesNewestFirst: StoredMessage[],
  newUserContent: string
): ChatTurn[] {
  const history: ChatTurn[] = [];
  if (personaPrompt) history.push({ role: "system", content: personaPrompt });

  for (const m of [...recentMessagesNewestFirst].reverse()) {
    if (m.role === "user" || m.role === "assistant" || m.role === "system") {
      history.push({ role: m.role, content: m.content });
    }
  }

  history.push({ role: "user", content: newUserContent });
  return history;
}

/** Next seq to use for the user message; the reply then uses `+1` on top of it. */
export function nextSeqAfter(lastSeq: number | null | undefined): number {
  return (lastSeq ?? 0) + 1;
}
