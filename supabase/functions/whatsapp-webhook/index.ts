// Orun OS — WhatsApp Webhook Handler
//
// Receives incoming WhatsApp messages via the Cloud API webhook,
// routes them to the appropriate agent based on keyword rules,
// and sends replies back via the WhatsApp Cloud API.
//
// Deploy: supabase functions deploy whatsapp-webhook
// Env vars needed: WHATSAPP_TOKEN, WHATSAPP_VERIFY_TOKEN, WHATSAPP_APP_SECRET
//
// Security: Every POST request is validated against WHATSAPP_APP_SECRET.
// WhatsApp signs the raw request body using HMAC-SHA256 and sends the
// signature in the X-Hub-Signature-256 header as "sha256=<hex>".
// We recompute the HMAC and compare to reject forged payloads.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { runAutonomousLoop } from "../ai-relay/autonomousLoop.ts";
import { PROVIDER_ENV_KEY } from "../ai-relay/logic.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WHATSAPP_TOKEN = Deno.env.get("WHATSAPP_TOKEN");
const WHATSAPP_VERIFY_TOKEN = Deno.env.get("WHATSAPP_VERIFY_TOKEN");
const WHATSAPP_APP_SECRET = Deno.env.get("WHATSAPP_APP_SECRET");

interface WhatsAppMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
}

/**
 * Validates that the POST request came from Meta/WhatsApp by verifying
 * the HMAC-SHA256 signature of the raw request body.
 *
 * How it works:
 * 1. When you configure the webhook in Meta App Dashboard, you set an app_secret
 * 2. Meta signs every POST payload with HMAC-SHA256 using that secret
 * 3. The signature is sent as: X-Hub-Signature-256: sha256=<hex-digest>
 * 4. We read the raw body bytes, compute the same HMAC, and compare
 * 5. If they don't match, the request is forged — reject it
 *
 * If WHATSAPP_APP_SECRET is not configured, validation is skipped
 * (development mode) with a warning log.
 *
 * @param rawBody - The raw request body as a Uint8Array (must be read BEFORE json())
 * @param request - The original Request object (to read the signature header)
 */
async function validateWhatsAppSignature(
  rawBody: Uint8Array,
  req: Request,
): Promise<boolean> {
  if (!WHATSAPP_APP_SECRET) {
    console.warn("[WhatsApp] WHATSAPP_APP_SECRET not set — skipping validation (dev mode)");
    return true;
  }

  const signatureHeader = req.headers.get("x-hub-signature-256");
  if (!signatureHeader) return false;

  // Header format: "sha256=<hex-digest>"
  const parts = signatureHeader.split("=");
  if (parts.length !== 2 || parts[0] !== "sha256") return false;
  const expectedHex = parts[1];

  // Compute HMAC-SHA256 of the raw body using the app secret
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(WHATSAPP_APP_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, rawBody);
  const computedHex = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Timing-safe comparison to prevent timing attacks
  if (computedHex.length !== expectedHex.length) return false;
  let diff = 0;
  for (let i = 0; i < computedHex.length; i++) {
    diff |= computedHex.charCodeAt(i) ^ expectedHex.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Verifies the webhook for WhatsApp Cloud API setup.
 * GET /whatsapp-webhook?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...
 */
function handleVerify(req: Request): Response {
  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === WHATSAPP_VERIFY_TOKEN) {
    return new Response(challenge, { status: 200 });
  }
  return new Response("Forbidden", { status: 403 });
}

/**
 * Sends a text message back via WhatsApp Cloud API.
 */
async function sendWhatsAppMessage(to: string, text: string): Promise<void> {
  if (!WHATSAPP_TOKEN) {
    console.log(`[WhatsApp] No token configured — would send to ${to}: ${text.slice(0, 100)}`);
    return;
  }

  await fetch(`https://graph.facebook.com/v18.0/me/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${WHATSAPP_TOKEN}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });
}

/**
 * Routes a WhatsApp message to the correct agent.
 * Priority: group_jid match > keyword match > null (no match).
 */
async function routeMessage(
  supabase: any,
  userPhone: string,
  text: string,
  groupJid?: string,
): Promise<{ agentId: string; userId: string } | null> {
  const { data: rules } = await supabase
    .from("whatsapp_keyword_rules")
    .select("agent, user_id, keywords, group_jid, channel")
    .eq("enabled", true)
    .is("deleted_at", null);

  if (!rules || rules.length === 0) return null;

  // 1) Group match — exact group_jid
  if (groupJid) {
    const groupRule = rules.find(
      (r: any) => r.group_jid && r.group_jid === groupJid,
    );
    if (groupRule) {
      return { agentId: groupRule.agent, userId: groupRule.user_id };
    }
  }

  // 2) Keyword match (DM or group fallback)
  for (const rule of rules) {
    if (rule.group_jid) continue; // skip group-only rules for keyword matching
    const keywords = (rule.keywords as string[]) ?? [];
    if (keywords.some((kw: string) => text.toLowerCase().includes(kw.toLowerCase()))) {
      return { agentId: rule.agent, userId: rule.user_id };
    }
  }

  return null;
}

Deno.serve(async (req: Request) => {
  // Webhook verification
  if (req.method === "GET") return handleVerify(req);
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  // Read raw body BEFORE parsing JSON (needed for HMAC verification)
  const rawBody = await req.arrayBuffer();
  const rawBodyBytes = new Uint8Array(rawBody);

  // Validate HMAC-SHA256 signature — reject forged requests
  if (!await validateWhatsAppSignature(rawBodyBytes, req)) {
    console.warn("[WhatsApp] Rejected request with invalid/missing signature");
    return new Response("Forbidden", { status: 403 });
  }

  // Now parse the validated body
  const body = JSON.parse(new TextDecoder().decode(rawBodyBytes));

  // Parse WhatsApp webhook payload
  const entries = body.entry ?? [];
  for (const entry of entries) {
    const changes = entry.changes ?? [];
    for (const change of changes) {
      const messages: WhatsAppMessage[] = change.value?.messages ?? [];

      for (const msg of messages) {
        if (msg.type !== "text" || !msg.text?.body) continue;

        const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

        // Extract group JID if message is from a group
        const groupJid = change.value?.metadata?.phone_number_id
          ? change.value?.contacts?.[0]?.wa_id !== msg.from
            ? msg.from
            : undefined
          : undefined;

        // Route to agent
        const route = await routeMessage(supabase, msg.from, msg.text.body, groupJid);
        if (!route) {
          await sendWhatsAppMessage(msg.from, "Desculpe, nao consegui processar sua mensagem. Configure regras de palavras-chave no app para direcionar mensagens aos agentes.");
          continue;
        }

        // Create conversation + send to ai-relay
        const { data: conv } = await supabase
          .from("conversations")
          .insert({ title: `WhatsApp: ${msg.text.body.slice(0, 50)}`, user_id: route.userId })
          .select("id")
          .single();

        if (!conv) continue;

        // Call ai-relay logic directly (same as the Edge Function does)
        const { data: agent } = await supabase
          .from("agents")
          .select("id, name, default_provider, default_model, persona_prompt")
          .eq("id", route.agentId)
          .maybeSingle();

        if (!agent) continue;

        // Store user message
        const now = new Date().toISOString();
        await supabase.from("messages").insert({
          conversation_id: conv.id,
          seq: 1,
          role: "user",
          agent_id: route.agentId,
          content: msg.text.body,
          user_id: route.userId,
          created_at: now,
          updated_at: now,
        });

        // Get API key for the agent's provider
        const providerKey = PROVIDER_ENV_KEY[agent.default_provider!];
        const apiKey = providerKey ? Deno.env.get(providerKey) : null;
        if (!apiKey || !agent.default_provider || !agent.default_model) {
          await sendWhatsAppMessage(msg.from, `[${agent.name}] Provider nao configurado. Configure a chave de API no Supabase.`);
          continue;
        }

        // Run autonomous loop
        try {
          const result = await runAutonomousLoop(
            agent.default_provider,
            agent.default_model,
            agent.persona_prompt ?? "Voce e um assistente util.",
            [{ role: "user", content: msg.text.body }],
            { userId: route.userId, agentId: route.agentId, conversationId: conv.id, supabase },
            apiKey,
          );

          // Store reply
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

          await sendWhatsAppMessage(msg.from, result.finalContent);
        } catch (err) {
          await sendWhatsAppMessage(msg.from, `[${agent.name}] Erro ao processar: ${(err as Error).message}`);
        }
      }
    }
  }

  return new Response("OK", { status: 200 });
});
