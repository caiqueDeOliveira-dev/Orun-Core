// Orun OS — ai-relay Edge Function
//
// Runs on Supabase's infrastructure (Deno runtime), NOT on the user's PC.
// This is the piece that makes the mobile app work with the PC turned off:
// the phone calls this function instead of the Electron main process.
//
// Deploy: supabase functions deploy ai-relay
// Secrets (never hardcode): supabase secrets set ANTHROPIC_API_KEY=... OPENAI_API_KEY=... etc.
//
// Auth: `verify_jwt` defaults to true for Supabase Edge Functions, so a
// request without a valid Supabase Auth session JWT is rejected by the
// platform BEFORE this code even runs. Inside, we still use the
// service_role key (safe here — this runs in Supabase's trusted server
// environment, not on the phone) so the function can read agent config and
// write messages regardless of RLS.
//
// The pure logic (history building, validation, provider selection) lives
// in ./logic.ts and is unit-tested with Vitest in plain Node — this file
// is the thin Deno-specific glue (Deno.serve, Deno.env, the actual fetch()
// calls to provider APIs) that CAN'T be exercised outside a real Deno
// runtime, so it has no automated test coverage. Test it for real with
// `supabase functions serve ai-relay` against a local Supabase stack
// before relying on it in production.

import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  buildHistory,
  nextSeqAfter,
  validateAgentIsUsable,
  validateRelayRequest,
  OPENAI_COMPATIBLE_ENDPOINTS,
  PROVIDER_ENV_KEY,
  type ChatTurn,
} from "./logic.ts";
import { runAutonomousLoop, type LoopResult } from "./autonomousLoop.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

/** Max request body size in bytes (256KB). Prevents abuse via huge payloads. */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * Extracts the user_id from the Authorization header JWT.
 * The mobile app sends its Supabase Auth JWT — we decode the payload
 * to get the `sub` claim (user ID) without needing to verify the JWT
 * signature (Supabase's platform already verified it before our code runs).
 */
function extractUserId(req: Request): string | null {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    return payload.sub ?? null;
  } catch {
    return null;
  }
}

// ─── STT (Speech-to-Text) via Groq Whisper (GRÁTIS) ─────────────

async function transcribeAudio(audioBase64: string, mimeType: string): Promise<string> {
  const apiKey = Deno.env.get("GROQ_API_KEY");
  if (!apiKey) throw new Error("GROQ_API_KEY not configured (supabase secrets set GROQ_API_KEY=gsk_...)");

  const binaryStr = atob(audioBase64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }

  const ext = mimeType.includes("m4a") ? "m4a" : mimeType.includes("webm") ? "webm" : "mp3";
  const blob = new Blob([bytes], { type: mimeType });

  const formData = new FormData();
  formData.append("file", blob, `audio.${ext}`);
  formData.append("model", "whisper-large-v3");
  formData.append("language", "pt");

  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}` },
    body: formData,
  });

  if (!res.ok) throw new Error(`Groq Whisper error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.text ?? "";
}

async function callClaude(model: string, history: ChatTurn[]): Promise<string> {
  const apiKey = Deno.env.get(PROVIDER_ENV_KEY.claude);
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured (supabase secrets set)");

  const system = history.find((m) => m.role === "system")?.content;
  const messages = history.filter((m) => m.role !== "system");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    }),
  });

  if (!res.ok) throw new Error(`Claude API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const textBlock = data.content?.find((b: { type: string }) => b.type === "text");
  return textBlock?.text ?? "";
}

async function callOpenAICompatible(provider: string, model: string, history: ChatTurn[]): Promise<string> {
  const endpoint = OPENAI_COMPATIBLE_ENDPOINTS[provider];
  const apiKey = Deno.env.get(PROVIDER_ENV_KEY[provider]);
  if (!apiKey) throw new Error(`${PROVIDER_ENV_KEY[provider]} not configured (supabase secrets set)`);

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: history.map((m) => ({ role: m.role, content: m.content })),
    }),
  });

  if (!res.ok) throw new Error(`${provider} API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

async function callProvider(provider: string, model: string, history: ChatTurn[]): Promise<string> {
  if (provider === "claude") return callClaude(model, history);
  return callOpenAICompatible(provider, model, history);
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  // Reject oversized requests before parsing to prevent memory abuse
  const contentLength = Number(req.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) {
    return new Response(JSON.stringify({ error: `Request too large (max ${MAX_BODY_BYTES / 1024}KB)` }), {
      status: 413,
    });
  }

  const body = await req.json();

  // ─── STT transcribe action ──────────────────────────────────────
  if (body.action === "transcribe") {
    const audio = typeof body.audio === "string" ? body.audio : "";
    const mimeType = typeof body.mimeType === "string" ? body.mimeType : "audio/m4a";
    if (!audio.trim()) {
      return new Response(JSON.stringify({ error: "audio (base64) is required" }), { status: 400 });
    }
    try {
      const text = await transcribeAudio(audio, mimeType);
      return new Response(JSON.stringify({ text }), { status: 200, headers: { "content-type": "application/json" } });
    } catch (err) {
      return new Response(JSON.stringify({ error: (err as Error).message }), { status: 502 });
    }
  }

  // ─── Chat relay (default) ───────────────────────────────────────

  let parsed: ReturnType<typeof validateRelayRequest>;
  try {
    parsed = validateRelayRequest(body);
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 400 });
  }
  const { conversationId, agentId, content } = parsed;

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // 1) Look up which provider/model this agent is configured to use.
  const { data: agent, error: agentError } = await supabase
    .from("agents")
    .select("id, name, default_provider, default_model, persona_prompt")
    .eq("id", agentId)
    .maybeSingle();

  try {
    validateAgentIsUsable(agentError ? null : agent);
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 422 });
  }

  // 2) Pull recent conversation history for context (last 20 turns).
  const { data: recentMessages, error: historyError } = await supabase
    .from("messages")
    .select("role, content, seq")
    .eq("conversation_id", conversationId)
    .is("deleted_at", null)
    .order("seq", { ascending: false })
    .limit(20);

  if (historyError) {
    return new Response(JSON.stringify({ error: `Failed to load history: ${historyError.message}` }), {
      status: 500,
    });
  }

  const history = buildHistory(agent!.persona_prompt, recentMessages ?? [], content);

  // 3) Compute the next seq for both messages (user's + agent's reply).
  const { data: seqRow } = await supabase
    .from("messages")
    .select("seq")
    .eq("conversation_id", conversationId)
    .order("seq", { ascending: false })
    .limit(1)
    .maybeSingle();
  const userSeq = nextSeqAfter(seqRow?.seq);

  const userMessageId = crypto.randomUUID();
  const now = new Date().toISOString();
  const userId = extractUserId(req);

  const { error: insertUserError } = await supabase.from("messages").insert({
    id: userMessageId,
    conversation_id: conversationId,
    seq: userSeq,
    role: "user",
    agent_id: agentId,
    content,
    user_id: userId,
    created_at: now,
    updated_at: now,
  });
  if (insertUserError) {
    return new Response(JSON.stringify({ error: `Failed to store user message: ${insertUserError.message}` }), {
      status: 500,
    });
  }

  // 4) Run the autonomous tool-calling loop.
  const apiKey = Deno.env.get(PROVIDER_ENV_KEY[agent!.default_provider!]);
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: `${PROVIDER_ENV_KEY[agent!.default_provider!]} not configured` }),
      { status: 500 },
    );
  }

  // Convert history to the format expected by the autonomous loop
  const loopMessages = history
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  let loopResult: LoopResult;
  try {
    loopResult = await runAutonomousLoop(
      agent!.default_provider!,
      agent!.default_model!,
      agent!.persona_prompt ?? "Voce e um assistente util.",
      loopMessages,
      { userId: userId ?? "", agentId, conversationId, supabase },
      apiKey,
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 502 });
  }

  const replyContent = loopResult.finalContent;

  // 5) Store tool call messages in the DB for traceability
  let nextSeq = userSeq + 1;
  for (const tc of loopResult.toolCallsMade) {
    nextSeq++;
    // Store tool call as a system message
    await supabase.from("messages").insert({
      conversation_id: conversationId,
      seq: nextSeq,
      role: "system",
      agent_id: agentId,
      content: `[Tool: ${tc.name}] Args: ${JSON.stringify(tc.args)} → ${tc.result.success ? "OK" : "ERROR: " + tc.result.error}`,
      user_id: userId,
    });
  }

  // 6) Store the assistant's final reply
  const replyId = crypto.randomUUID();
  const replyNow = new Date().toISOString();
  const { error: insertReplyError } = await supabase.from("messages").insert({
    id: replyId,
    conversation_id: conversationId,
    seq: nextSeq + 1,
    role: "assistant",
    agent_id: agentId,
    provider: agent!.default_provider,
    model: agent!.default_model,
    content: replyContent,
    user_id: userId,
    created_at: replyNow,
    updated_at: replyNow,
  });
  if (insertReplyError) {
    return new Response(JSON.stringify({ error: `Failed to store reply: ${insertReplyError.message}` }), {
      status: 500,
    });
  }

  return new Response(
    JSON.stringify({
      userMessageId,
      replyId,
      content: replyContent,
      provider: agent!.default_provider,
      model: agent!.default_model,
      toolCalls: loopResult.toolCallsMade.length,
      iterations: loopResult.iterations,
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
});
