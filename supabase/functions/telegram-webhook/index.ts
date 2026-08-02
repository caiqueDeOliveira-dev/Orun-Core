// Orun OS — Telegram Bot Webhook Handler
//
// Receives incoming Telegram messages via Bot API webhook,
// routes them to the appropriate agent, and sends replies back.
//
// Deploy: supabase functions deploy telegram-webhook
// Env vars needed: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET
//
// Security: Every request is validated against TELEGRAM_WEBHOOK_SECRET.
// When registering the webhook with Telegram, set secret_token to the
// same value. Telegram will include it as X-Telegram-Bot-Api-Secret-Token
// on every incoming request, so we can reject forged payloads.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { runAutonomousLoop } from "../ai-relay/autonomousLoop.ts";
import { PROVIDER_ENV_KEY } from "../ai-relay/logic.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN");
const TELEGRAM_WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET");

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: { id: number; first_name: string };
    chat: { id: number };
    text?: string;
  };
}

/**
 * Validates that the request came from Telegram by checking the
 * X-Telegram-Bot-Api-Secret-Token header against our configured secret.
 *
 * How it works:
 * 1. When you register a webhook with Telegram (setWebhook), you provide a secret_token
 * 2. Telegram stores that token and includes it as a header on every POST to your webhook
 * 3. We compare the header value with our local TELEGRAM_WEBHOOK_SECRET
 * 4. If they don't match, the request is forged and we reject it
 *
 * If TELEGRAM_WEBHOOK_SECRET is not configured, validation is skipped
 * (development mode) with a warning log.
 */
function validateTelegramSecret(req: Request): boolean {
  if (!TELEGRAM_WEBHOOK_SECRET) {
    console.warn("[Telegram] TELEGRAM_WEBHOOK_SECRET not set — skipping validation (dev mode)");
    return true;
  }
  const token = req.headers.get("x-telegram-bot-api-secret-token");
  if (!token) return false;
  // Timing-safe comparison to prevent timing attacks
  if (token.length !== TELEGRAM_WEBHOOK_SECRET.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) {
    diff |= token.charCodeAt(i) ^ TELEGRAM_WEBHOOK_SECRET.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Sends a message back via Telegram Bot API.
 */
async function sendTelegramMessage(chatId: number, text: string): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN) {
    console.log(`[Telegram] No token configured — would send to ${chatId}: ${text.slice(0, 100)}`);
    return;
  }

  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
    }),
  });
}

/**
 * Routes a Telegram message to the correct agent based on keyword rules.
 */
async function routeMessage(supabase: any, telegramUserId: number, text: string): Promise<{ agentId: string; userId: string } | null> {
  const { data: rules } = await supabase
    .from("whatsapp_keyword_rules")
    .select("agent, user_id, keywords")
    .eq("enabled", true)
    .is("deleted_at", null);

  if (!rules || rules.length === 0) return null;

  for (const rule of rules) {
    const keywords = (rule.keywords as string[]) ?? [];
    if (keywords.some((kw) => text.toLowerCase().includes(kw.toLowerCase()))) {
      return { agentId: rule.agent, userId: rule.user_id };
    }
  }

  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  // Validate webhook secret — reject forged requests
  if (!validateTelegramSecret(req)) {
    console.warn("[Telegram] Rejected request with invalid/missing secret token");
    return new Response("Forbidden", { status: 403 });
  }

  const update: TelegramUpdate = await req.json();
  const msg = update.message;
  if (!msg?.text) return new Response("OK", { status: 200 });

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // Route to agent
  const route = await routeMessage(supabase, msg.from.id, msg.text);
  if (!route) {
    await sendTelegramMessage(msg.chat.id, "Desculpe, nao consegui processar sua mensagem. Configure regras de palavras-chave no app.");
    return new Response("OK", { status: 200 });
  }

  // Create conversation
  const { data: conv } = await supabase
    .from("conversations")
    .insert({ title: `Telegram: ${msg.text.slice(0, 50)}`, user_id: route.userId })
    .select("id")
    .single();

  if (!conv) {
    await sendTelegramMessage(msg.chat.id, "Erro ao criar conversa.");
    return new Response("OK", { status: 200 });
  }

  // Get agent info
  const { data: agent } = await supabase
    .from("agents")
    .select("id, name, default_provider, default_model, persona_prompt")
    .eq("id", route.agentId)
    .maybeSingle();

  if (!agent) {
    await sendTelegramMessage(msg.chat.id, "Agente nao encontrado.");
    return new Response("OK", { status: 200 });
  }

  // Get API key for the agent's provider
  const providerKey = PROVIDER_ENV_KEY[agent.default_provider!];
  const apiKey = providerKey ? Deno.env.get(providerKey) : null;

  // Store user message
  const now = new Date().toISOString();
  await supabase.from("messages").insert({
    conversation_id: conv.id,
    seq: 1,
    role: "user",
    agent_id: route.agentId,
    content: msg.text,
    user_id: route.userId,
    created_at: now,
    updated_at: now,
  });

  if (!apiKey || !agent.default_provider || !agent.default_model) {
    await sendTelegramMessage(msg.chat.id, `[${agent.name}] Provider nao configurado.`);
    return new Response("OK", { status: 200 });
  }

  // Run autonomous loop
  try {
    const result = await runAutonomousLoop(
      agent.default_provider,
      agent.default_model,
      agent.persona_prompt ?? "Voce e um assistente util.",
      [{ role: "user", content: msg.text }],
      { userId: route.userId, agentId: route.agentId, conversationId: conv.id, supabase },
      apiKey,
    );

    const replyNow = new Date().toISOString();
    await supabase.from("messages").insert({
      conversation_id: conv.id,
      seq: 2,
      role: "assistant",
      agent_id: route.agentId,
      provider: agent.default_provider,
      model: agent.default_model,
      content: result.finalContent,
      user_id: route.userId,
      created_at: replyNow,
      updated_at: replyNow,
    });

    await sendTelegramMessage(msg.chat.id, result.finalContent);
  } catch (err) {
    await sendTelegramMessage(msg.chat.id, `[${agent.name}] Erro: ${(err as Error).message}`);
  }

  return new Response("OK", { status: 200 });
});
