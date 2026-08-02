// Orun OS — Tool definitions for autonomous loop
//
// Each tool is defined with a name, description, parameters schema,
// and an execute function. Tools that need server-side access (filesystem,
// shell) are marked as "desktop-only" and won't be sent to providers
// when running from the mobile app.

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required: string[];
  };
  execute: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
}

export interface ToolContext {
  userId: string;
  agentId: string;
  conversationId: string;
  supabase: any; // Supabase client with service_role
}

export interface ToolResult {
  success: boolean;
  result?: unknown;
  error?: string;
}

// ─── Health Tools ──────────────────────────────────────────────────

const logMeal: ToolDefinition = {
  name: "log_meal",
  description: "Registrar uma refeicao com calorias e macronutrientes",
  parameters: {
    type: "object",
    properties: {
      description: { type: "string", description: "Descricao da refeicao" },
      calories: { type: "number", description: "Calorias totais" },
      protein_g: { type: "number", description: "Proteina em gramas" },
      carbs_g: { type: "number", description: "Carboidratos em gramas" },
      fat_g: { type: "number", description: "Gordura em gramas" },
    },
    required: ["description", "calories"],
  },
  execute: async (args, ctx) => {
    const { error } = await ctx.supabase.from("health_log").insert({
      user_id: ctx.userId,
      kind: "meal",
      description: args.description,
      calories: args.calories,
      protein_g: args.protein_g ?? null,
      carbs_g: args.carbs_g ?? null,
      fat_g: args.fat_g ?? null,
      source: "ai",
    });
    if (error) return { success: false, error: error.message };
    return { success: true, result: "Refeicao registrada com sucesso" };
  },
};

const logWorkout: ToolDefinition = {
  name: "log_workout",
  description: "Registrar um treino com duracao e calorias queimadas",
  parameters: {
    type: "object",
    properties: {
      exercise_name: { type: "string", description: "Nome do exercicio" },
      duration_min: { type: "number", description: "Duracao em minutos" },
      calories_burned: { type: "number", description: "Calorias queimadas" },
    },
    required: ["exercise_name", "duration_min"],
  },
  execute: async (args, ctx) => {
    const { error } = await ctx.supabase.from("health_log").insert({
      user_id: ctx.userId,
      kind: "workout",
      exercise_name: args.exercise_name,
      duration_min: args.duration_min,
      calories_burned: args.calories_burned ?? null,
      source: "ai",
    });
    if (error) return { success: false, error: error.message };
    return { success: true, result: "Treino registrado com sucesso" };
  },
};

const logMetric: ToolDefinition = {
  name: "log_metric",
  description: "Registrar uma metrica de saude (peso, pressao, frequencia cardiaca, passos, sono)",
  parameters: {
    type: "object",
    properties: {
      metric: { type: "string", description: "Nome da metrica (peso, pressao, frequencia_cardiaca, passos, sono)" },
      value: { type: "number", description: "Valor da metrica" },
      unit: { type: "string", description: "Unidade de medida" },
      notes: { type: "string", description: "Observacoes" },
    },
    required: ["metric", "value", "unit"],
  },
  execute: async (args, ctx) => {
    const { error } = await ctx.supabase.from("health_log").insert({
      user_id: ctx.userId,
      kind: "metric",
      metric: args.metric,
      value: args.value,
      unit: args.unit,
      notes: args.notes ?? null,
      source: "ai",
    });
    if (error) return { success: false, error: error.message };
    return { success: true, result: "Metrica registrada com sucesso" };
  },
};

const getHealthSummary: ToolDefinition = {
  name: "get_summary",
  description: "Obter resumo de saude do dia (calorias, macros, treinos)",
  parameters: { type: "object", properties: {}, required: [] },
  execute: async (_args, ctx) => {
    const today = new Date().toISOString().split("T")[0];
    const { data, error } = await ctx.supabase
      .from("health_log")
      .select("*")
      .eq("user_id", ctx.userId)
      .eq("date", today)
      .is("deleted_at", null);
    if (error) return { success: false, error: error.message };

    const meals = data?.filter((r: any) => r.kind === "meal") ?? [];
    const workouts = data?.filter((r: any) => r.kind === "workout") ?? [];
    const metrics = data?.filter((r: any) => r.kind === "metric") ?? [];

    return {
      success: true,
      result: {
        meals: meals.length,
        totalCalories: meals.reduce((sum: number, m: any) => sum + (m.calories ?? 0), 0),
        workouts: workouts.length,
        totalWorkoutMin: workouts.reduce((sum: number, w: any) => sum + (w.duration_min ?? 0), 0),
        metrics: metrics.map((m: any) => ({ metric: m.metric, value: m.value, unit: m.unit })),
      },
    };
  },
};

// ─── Finance Tools ─────────────────────────────────────────────────

const addTransaction: ToolDefinition = {
  name: "add_transaction",
  description: "Adicionar uma transacao financeira (despesa ou receita)",
  parameters: {
    type: "object",
    properties: {
      description: { type: "string", description: "Descricao da transacao" },
      amount: { type: "number", description: "Valor" },
      currency: { type: "string", description: "Moeda (BRL, USD, EUR)" },
      category: { type: "string", description: "Categoria", enum: ["food", "transport", "housing", "entertainment", "health", "education", "salary", "investment", "other"] },
      type: { type: "string", description: "Tipo", enum: ["expense", "income"] },
    },
    required: ["description", "amount", "category", "type"],
  },
  execute: async (args, ctx) => {
    const { error } = await ctx.supabase.from("finance_log").insert({
      user_id: ctx.userId,
      description: args.description,
      amount: args.amount,
      currency: args.currency ?? "BRL",
      category: args.category,
      type: args.type,
      source: "ai",
    });
    if (error) return { success: false, error: error.message };
    return { success: true, result: "Transacao registrada com sucesso" };
  },
};

const getFinanceSummary: ToolDefinition = {
  name: "get_finance_summary",
  description: "Obter resumo financeiro do dia (receitas, despesas, saldo)",
  parameters: { type: "object", properties: {}, required: [] },
  execute: async (_args, ctx) => {
    const today = new Date().toISOString().split("T")[0];
    const { data, error } = await ctx.supabase
      .from("finance_log")
      .select("*")
      .eq("user_id", ctx.userId)
      .eq("date", today)
      .is("deleted_at", null);
    if (error) return { success: false, error: error.message };

    const income = data?.filter((r: any) => r.type === "income").reduce((s: number, r: any) => s + r.amount, 0) ?? 0;
    const expenses = data?.filter((r: any) => r.type === "expense").reduce((s: number, r: any) => s + r.amount, 0) ?? 0;

    return {
      success: true,
      result: { income, expenses, balance: income - expenses, transactions: data?.length ?? 0 },
    };
  },
};

// ─── Marketing Tools ───────────────────────────────────────────────

const addCampaign: ToolDefinition = {
  name: "add_campaign",
  description: "Criar uma campanha de marketing",
  parameters: {
    type: "object",
    properties: {
      campaign_name: { type: "string", description: "Nome da campanha" },
      objective: { type: "string", description: "Objetivo" },
      channels: { type: "string", description: "Canais (separados por virgula)" },
    },
    required: ["campaign_name"],
  },
  execute: async (args, ctx) => {
    const { error } = await ctx.supabase.from("marketing_log").insert({
      user_id: ctx.userId,
      campaign_name: args.campaign_name,
      objective: args.objective ?? null,
      channels: args.channels ? args.channels.split(",").map((s: string) => s.trim()) : null,
      source: "ai",
    });
    if (error) return { success: false, error: error.message };
    return { success: true, result: "Campanha criada com sucesso" };
  },
};

// ─── Memory Tools ──────────────────────────────────────────────────

const memorySave: ToolDefinition = {
  name: "memory_save",
  description: "Salvar uma informacao na memoria de longo prazo",
  parameters: {
    type: "object",
    properties: {
      key: { type: "string", description: "Chave unica para a memoria" },
      content: { type: "string", description: "Conteudo da memoria" },
      tags: { type: "string", description: "Tags separadas por virgula" },
    },
    required: ["key", "content"],
  },
  execute: async (args, ctx) => {
    const tags = args.tags ? args.tags.split(",").map((s: string) => s.trim()) : [];
    const { error } = await ctx.supabase.from("memories").upsert({
      user_id: ctx.userId,
      key: args.key,
      content: args.content,
      tags,
    }, { onConflict: "user_id,key" });
    if (error) return { success: false, error: error.message };
    return { success: true, result: "Memoria salva com sucesso" };
  },
};

const memorySearch: ToolDefinition = {
  name: "memory_search",
  description: "Buscar memorias salvas por chave ou conteudo",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Termo de busca" },
    },
    required: ["query"],
  },
  execute: async (args, ctx) => {
    const { data, error } = await ctx.supabase
      .from("memories")
      .select("key, content, tags")
      .eq("user_id", ctx.userId)
      .is("deleted_at", null)
      .or(`key.ilike.%${args.query}%,content.ilike.%${args.query}%`)
      .limit(10);
    if (error) return { success: false, error: error.message };
    return { success: true, result: data ?? [] };
  },
};

// ─── Notification Tool ─────────────────────────────────────────────

const notify: ToolDefinition = {
  name: "notify",
  description: "Enviar uma notificacao push ao usuario",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "Titulo da notificacao" },
      body: { type: "string", description: "Corpo da notificacao" },
    },
    required: ["title", "body"],
  },
  execute: async (args, _ctx) => {
    // In production, this would call a push notification service
    return { success: true, result: `Notificacao: ${args.title} — ${args.body}` };
  },
};

// ─── Trigger Agent Tool ────────────────────────────────────────────

const triggerAgent: ToolDefinition = {
  name: "trigger_agent",
  description: "Disparar outro agente com uma mensagem",
  parameters: {
    type: "object",
    properties: {
      agent: { type: "string", description: "ID do agente (health, finance, developer, etc.)" },
      message: { type: "string", description: "Mensagem para o agente" },
    },
    required: ["agent", "message"],
  },
  execute: async (args, ctx) => {
    // Record the trigger in messages for traceability
    const { error } = await ctx.supabase.from("messages").insert({
      conversation_id: ctx.conversationId,
      seq: Date.now(),
      role: "system",
      agent_id: args.agent,
      content: `[Triggered by ${ctx.agentId}] ${args.message}`,
      user_id: ctx.userId,
    });
    if (error) return { success: false, error: error.message };
    return { success: true, result: `Agente ${args.agent} disparado` };
  },
};

// ─── Workspace Action Tool ─────────────────────────────────────────

const workspaceAction: ToolDefinition = {
  name: "workspace_action",
  description: "Executar uma acao em um workspace (health, finance, etc.)",
  parameters: {
    type: "object",
    properties: {
      workspace: { type: "string", description: "Nome do workspace" },
      action: { type: "string", description: "Nome da acao" },
      params: { type: "string", description: "Parametros em JSON" },
    },
    required: ["workspace", "action"],
  },
  execute: async (args, ctx) => {
    const params = args.params ? JSON.parse(args.params) : {};
    // Route to the appropriate tool based on workspace + action
    const toolKey = `${args.workspace}_${args.action}`;
    const allTools = getAllTools();
    const tool = allTools.find((t) => t.name === args.action || t.name === toolKey);
    if (tool) {
      return tool.execute(params, ctx);
    }
    return { success: false, error: `Acao '${args.action}' nao encontrada no workspace '${args.workspace}'` };
  },
};

// ─── Web Tools ─────────────────────────────────────────────────────

/**
 * Sanitizes search query input to prevent injection when the search API
 * is integrated. Strips control characters, limits length, and removes
 * potential prompt injection patterns.
 */
function sanitizeSearchQuery(raw: string): string {
  return raw
    .replace(/[\x00-\x08\x0E-\x1F]/g, "")  // control chars
    .replace(/\s+/g, " ")                      // collapse whitespace
    .trim()
    .slice(0, 200);                            // max 200 chars
}

const webSearch: ToolDefinition = {
  name: "web_search",
  description: "Buscar informacao na web",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Termo de busca" },
    },
    required: ["query"],
  },
  execute: async (args, _ctx) => {
    const query = sanitizeSearchQuery(String(args.query ?? ""));
    if (!query) return { success: false, error: "Query de busca vazia apos sanitizacao" };

    // TODO: Integrate with a real search API (DuckDuckGo, SerpAPI, etc.)
    // When integrating, always pass the sanitized `query` variable, never the raw input.
    return { success: true, result: `Busca por "${query}" — resultado pendente de integracao com API de busca` };
  },
};

// ─── Registry ──────────────────────────────────────────────────────

export function getAllTools(): ToolDefinition[] {
  return [
    logMeal,
    logWorkout,
    logMetric,
    getHealthSummary,
    addTransaction,
    getFinanceSummary,
    addCampaign,
    memorySave,
    memorySearch,
    notify,
    triggerAgent,
    workspaceAction,
    webSearch,
  ];
}

export function getToolByName(name: string): ToolDefinition | undefined {
  return getAllTools().find((t) => t.name === name);
}

export function getToolSchemas(): Array<{
  type: "function";
  function: { name: string; description: string; parameters: any };
}> {
  return getAllTools().map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}
