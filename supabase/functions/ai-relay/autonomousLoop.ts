// Orun OS — Autonomous Agent Loop
//
// The core engine that enables real agent behavior:
// 1. Send user message + tool definitions to the AI provider
// 2. If the provider returns tool calls, execute them locally
// 3. Feed tool results back to the provider
// 4. Repeat until the provider returns a final text response (max 10 iterations)
//
// This runs server-side in the Edge Function (Deno runtime).
// It has access to Supabase (service_role) and can execute tools
// that work via HTTP (memory, notifications, n8n webhooks, etc.).

import { getAllTools, getToolByName, type ToolContext, type ToolResult } from "./tools.ts";

export interface LoopMessage {
  role: "user" | "assistant" | "system" | "tool";
  content?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export interface LoopResult {
  finalContent: string;
  toolCallsMade: Array<{ name: string; args: unknown; result: ToolResult }>;
  iterations: number;
}

const MAX_ITERATIONS = 10;

/** Max time (ms) allowed per single provider API call before aborting. */
const PROVIDER_TIMEOUT_MS = 30_000;

/**
 * Runs the autonomous tool-calling loop.
 *
 * @param provider - The AI provider (groq, openai, claude, etc.)
 * @param model - The model identifier
 * @param systemPrompt - The agent's system prompt
 * @param messages - Conversation history (user/assistant turns)
 * @param context - Tool execution context (userId, supabase client, etc.)
 * @param apiKey - Provider API key
 * @returns The final text response + metadata about tool calls made
 */
export async function runAutonomousLoop(
  provider: string,
  model: string,
  systemPrompt: string,
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  context: ToolContext,
  apiKey: string,
): Promise<LoopResult> {
  const toolCallsMade: Array<{ name: string; args: unknown; result: ToolResult }> = [];
  const toolSchemas = getAllTools().map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));

  // Build initial messages array for the provider
  const providerMessages: LoopMessage[] = [
    { role: "system", content: systemPrompt },
    ...messages.map((m) => ({ role: m.role, content: m.content })),
  ];

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    // Call the provider with tool definitions
    const response = await callProviderWithTools(provider, model, providerMessages, toolSchemas, apiKey);

    // If no tool calls — we're done, return the final text
    if (!response.toolCalls || response.toolCalls.length === 0) {
      return {
        finalContent: response.content ?? "",
        toolCallsMade,
        iterations: iteration + 1,
      };
    }

    // Add the assistant's response (with tool calls) to the conversation
    providerMessages.push({
      role: "assistant",
      content: response.content ?? undefined,
      tool_calls: response.toolCalls,
    });

    // Execute each tool call
    for (const toolCall of response.toolCalls) {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(toolCall.function.arguments);
      } catch {
        args = {};
      }

      const tool = getToolByName(toolCall.function.name);
      let result: ToolResult;

      if (!tool) {
        result = { success: false, error: `Tool '${toolCall.function.name}' not found` };
      } else {
        try {
          result = await tool.execute(args, context);
        } catch (err) {
          result = { success: false, error: (err as Error).message };
        }
      }

      toolCallsMade.push({ name: toolCall.function.name, args, result });

      // Add tool result to conversation for the provider to see
      providerMessages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      });
    }
  }

  // Safety: if we hit max iterations, ask the model to summarize
  providerMessages.push({
    role: "user",
    content: "Voce ja usou muitas ferramentas. Resuma o que fez para o usuario.",
  });

  const finalResponse = await callProviderWithTools(provider, model, providerMessages, [], apiKey);
  return {
    finalContent: finalResponse.content ?? "Executado com sucesso (limite de iteracoes atingido).",
    toolCallsMade,
    iterations: MAX_ITERATIONS,
  };
}

// ─── Provider-specific API calls with tool support ─────────────────

interface ProviderResponse {
  content: string | null;
  toolCalls: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }> | null;
}

async function callProviderWithTools(
  provider: string,
  model: string,
  messages: LoopMessage[],
  tools: Array<{ type: "function"; function: { name: string; description: string; parameters: any } }>,
  apiKey: string,
): Promise<ProviderResponse> {
  if (provider === "claude") {
    return callClaudeWithTools(model, messages, tools, apiKey);
  }
  return callOpenAICompatibleWithTools(provider, model, messages, tools, apiKey);
}

async function callClaudeWithTools(
  model: string,
  messages: LoopMessage[],
  tools: Array<{ type: "function"; function: { name: string; description: string; parameters: any } }>,
  apiKey: string,
): Promise<ProviderResponse> {
  // Claude uses a different format: system is a top-level param, tools are separate
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  const nonSystem = messages.filter((m) => m.role !== "system");

  // Convert tool results from "tool" role to Claude's format
  const claudeMessages = nonSystem.map((m) => {
    if (m.role === "tool") {
      return {
        role: "user" as const,
        content: [
          {
            type: "tool_result",
            tool_use_id: m.tool_call_id,
            content: m.content ?? "",
          },
        ],
      };
    }
    if (m.role === "assistant" && m.tool_calls) {
      const content: Array<{ type: string; id?: string; name?: string; input?: any; text?: string }> = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls) {
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments || "{}"),
        });
      }
      return { role: "assistant" as const, content };
    }
    return { role: m.role as "user" | "assistant", content: m.content ?? "" };
  });

  const claudeTools = tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system,
      messages: claudeMessages,
      tools: claudeTools.length > 0 ? claudeTools : undefined,
    }),
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });

  if (!res.ok) throw new Error(`Claude API error ${res.status}: ${await res.text()}`);
  const data = await res.json();

  // Parse Claude's response format
  const textBlocks = data.content?.filter((b: any) => b.type === "text") ?? [];
  const toolUseBlocks = data.content?.filter((b: any) => b.type === "tool_use") ?? [];

  return {
    content: textBlocks.map((b: any) => b.text).join("\n") || null,
    toolCalls: toolUseBlocks.length > 0
      ? toolUseBlocks.map((b: any) => ({
          id: b.id,
          type: "function" as const,
          function: {
            name: b.name,
            arguments: JSON.stringify(b.input),
          },
        }))
      : null,
  };
}

async function callOpenAICompatibleWithTools(
  provider: string,
  model: string,
  messages: LoopMessage[],
  tools: Array<{ type: "function"; function: { name: string; description: string; parameters: any } }>,
  apiKey: string,
): Promise<ProviderResponse> {
  const endpoints: Record<string, string> = {
    openai: "https://api.openai.com/v1/chat/completions",
    openrouter: "https://openrouter.ai/api/v1/chat/completions",
    groq: "https://api.groq.com/openai/v1/chat/completions",
    github: "https://models.inference.ai.azure.com/chat/completions",
    opencode: "https://opencode.ai/zen/v1/chat/completions",
  };

  const endpoint = endpoints[provider];
  if (!endpoint) throw new Error(`Provider '${provider}' not supported`);

  // Clean messages: remove fields that OpenAI-compatible APIs don't understand
  const cleanMessages = messages.map((m) => {
    const clean: Record<string, unknown> = { role: m.role };
    if (m.content) clean.content = m.content;
    if (m.tool_calls) clean.tool_calls = m.tool_calls;
    if (m.tool_call_id) clean.tool_call_id = m.tool_call_id;
    return clean;
  });

  const body: Record<string, unknown> = {
    model,
    messages: cleanMessages,
  };

  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });

  if (!res.ok) throw new Error(`${provider} API error ${res.status}: ${await res.text()}`);
  const data = await res.json();

  const choice = data.choices?.[0];
  return {
    content: choice?.message?.content ?? null,
    toolCalls: choice?.message?.tool_calls ?? null,
  };
}
