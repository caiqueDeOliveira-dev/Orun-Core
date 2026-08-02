'use strict';

var supabaseJs = require('@supabase/supabase-js');
var zod = require('zod');

// src/types/satellites.ts
var SATELLITE_ACTIONS = {
  power: ["power.on", "power.off", "power.toggle"],
  volume: ["volume.up", "volume.down", "volume.set", "mute.toggle"],
  media: ["media.play", "media.pause", "media.stop", "media.next", "media.prev", "media.seek"],
  input: ["input.switch", "app.launch"],
  status: ["status.get"]
};

// src/util/uuid.ts
function newUuid() {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = Math.random() * 16 | 0;
    const v = ch === "x" ? r : r & 3 | 8;
    return v.toString(16);
  });
}

// src/services/outbox.ts
function enqueueUpsert(db, table, recordId, row) {
  db.prepare(
    `INSERT INTO sync_queue (table_name, record_id, op, payload) VALUES (?, ?, 'upsert', ?)`
  ).run(table, recordId, JSON.stringify(row));
}
function enqueueDelete(db, table, recordId) {
  db.prepare(
    `INSERT INTO sync_queue (table_name, record_id, op, payload) VALUES (?, ?, 'delete', NULL)`
  ).run(table, recordId);
}
function nextMessageSeq(db, conversationId) {
  const row = db.prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE conversation_id = ?`).get(conversationId);
  return row.next;
}

// src/services/backfill.ts
var TABLES = [
  "agents",
  "conversations",
  "messages",
  "usage_events",
  "tts_usage",
  "automations"
];
var BATCH_SIZE = 500;
async function backfill(db, supabase, onProgress) {
  for (const table of TABLES) {
    const total = db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get().c;
    let pushed = 0;
    while (pushed < total) {
      const rows = db.prepare(`SELECT * FROM ${table} ORDER BY rowid LIMIT ? OFFSET ?`).all(BATCH_SIZE, pushed);
      if (rows.length === 0) break;
      const cleaned = rows.map((row) => sanitizeForSupabase(row));
      const { error } = await supabase.from(table).upsert(cleaned, { onConflict: "id" });
      if (error) {
        throw new Error(`Backfill failed on ${table} (offset ${pushed}): ${error.message}`);
      }
      pushed += rows.length;
      onProgress?.({ table, pushed, total });
    }
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const upsertMeta = db.prepare(
    `INSERT INTO sync_meta (table_name, last_pulled_at) VALUES (?, ?)
     ON CONFLICT(table_name) DO UPDATE SET last_pulled_at = excluded.last_pulled_at`
  );
  const tx = db.transaction(() => {
    for (const table of TABLES) upsertMeta.run(table, now);
  });
  tx();
}
function sanitizeForSupabase(row) {
  const { rowid, ...rest } = row;
  return rest;
}
var client = null;
function getSupabaseClient(creds) {
  if (client) return client;
  client = supabaseJs.createClient(creds.url, creds.serviceRoleKey, {
    auth: {
      persistSession: false,
      // service_role is not a user session
      autoRefreshToken: false
    },
    db: {
      schema: "public"
    }
  });
  return client;
}
function initSupabaseFromKeychain(readSecret) {
  return (async () => {
    const url = await readSecret("orun.supabase.url");
    const serviceRoleKey = await readSecret("orun.supabase.serviceRoleKey");
    if (!url || !serviceRoleKey) {
      console.warn(
        "[sync] Supabase credentials not found in keychain \u2014 hybrid sync disabled, running fully local."
      );
      return null;
    }
    return getSupabaseClient({ url, serviceRoleKey });
  })();
}

// src/services/syncService.ts
var SYNCABLE_TABLES = [
  "agents",
  "conversations",
  "messages",
  "usage_events",
  "tts_usage",
  "automations"
];
var TABLE_PUSH_PRIORITY = {
  agents: 0,
  conversations: 1,
  messages: 2,
  usage_events: 2,
  tts_usage: 2,
  automations: 2
};
var PAGE_SIZE = 500;
var MAX_ATTEMPTS = 8;
var BASE_DELAY_MS = 15e3;
var MAX_DELAY_MS = 60 * 6e4;
function backoffDelay(attempts) {
  return Math.min(BASE_DELAY_MS * 2 ** attempts, MAX_DELAY_MS);
}
var SyncService = class {
  constructor(db, supabase, intervalMs = 15e3) {
    this.db = db;
    this.supabase = supabase;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.realtimeChannel = null;
    this.running = false;
    this.lastSuccessAt = null;
    this.lastCycleError = null;
  }
  start() {
    if (this.timer) return;
    this.runOnce().catch((err) => console.error("[sync] initial run failed", err));
    this.timer = setInterval(() => {
      this.runOnce().catch((err) => console.error("[sync] cycle failed", err));
    }, this.intervalMs);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.disableRealtime();
  }
  async runOnce() {
    if (this.running) return;
    this.running = true;
    try {
      await this.push();
      await this.pull();
      this.lastSuccessAt = (/* @__PURE__ */ new Date()).toISOString();
      this.lastCycleError = null;
    } catch (err) {
      this.lastCycleError = String(err?.message ?? err);
      throw err;
    } finally {
      this.running = false;
    }
  }
  /**
   * Snapshot of sync health, meant to be polled from the UI (e.g. every few
   * seconds via IPC) to drive a StatusChip in Developer/Settings. Cheap —
   * just SQLite COUNT queries, no network calls.
   */
  getSyncStatus() {
    const pending = this.db.prepare(`SELECT COUNT(*) as c FROM sync_queue WHERE attempts < ?`).get(MAX_ATTEMPTS).c;
    const deadLetterCount = this.db.prepare(`SELECT COUNT(*) as c FROM sync_queue WHERE attempts >= ?`).get(MAX_ATTEMPTS).c;
    return {
      pending,
      deadLetterCount,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastCycleError,
      isRunning: this.running,
      realtimeEnabled: this.realtimeChannel !== null
    };
  }
  /** Rows that hit MAX_ATTEMPTS and stopped retrying automatically. Surface these in a Developer/Settings screen. */
  getDeadLetters() {
    return this.db.prepare(`SELECT * FROM sync_queue WHERE attempts >= ? ORDER BY id ASC`).all(MAX_ATTEMPTS);
  }
  /** Reset dead-letter items (or all failed items) to try again immediately — e.g. a "Retry sync" button. */
  retryFailed() {
    this.db.prepare(`UPDATE sync_queue SET attempts = 0, next_attempt_at = NULL, last_error = NULL`).run();
  }
  // ---- PUSH: local outbox -> Supabase, with backoff ----------------------
  async push() {
    const nowIso = (/* @__PURE__ */ new Date()).toISOString();
    const pending = this.db.prepare(
      `SELECT * FROM sync_queue
         WHERE attempts < ? AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY id ASC LIMIT 200`
    ).all(MAX_ATTEMPTS, nowIso);
    pending.sort((a, b) => TABLE_PUSH_PRIORITY[a.table_name] - TABLE_PUSH_PRIORITY[b.table_name]);
    for (const item of pending) {
      try {
        if (item.op === "upsert") {
          const row = JSON.parse(item.payload ?? "{}");
          const { error } = await this.supabase.from(item.table_name).upsert(row, { onConflict: "id" });
          if (error) throw error;
        } else {
          const { error } = await this.supabase.from(item.table_name).update({ deleted_at: (/* @__PURE__ */ new Date()).toISOString() }).eq("id", item.record_id);
          if (error) throw error;
        }
        this.db.prepare(`DELETE FROM sync_queue WHERE id = ?`).run(item.id);
      } catch (err) {
        const attempts = item.attempts + 1;
        const nextAttemptAt = new Date(Date.now() + backoffDelay(attempts)).toISOString();
        this.db.prepare(
          `UPDATE sync_queue SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?`
        ).run(attempts, nextAttemptAt, String(err?.message ?? err), item.id);
        if (attempts >= MAX_ATTEMPTS) {
          console.error(
            `[sync] item #${item.id} (${item.table_name}/${item.record_id}) hit max attempts and is now a dead letter:`,
            err
          );
        }
      }
    }
  }
  // ---- PULL: Supabase -> local SQLite, paginated -------------------------
  async pull() {
    for (const table of SYNCABLE_TABLES) {
      await this.pullTable(table);
    }
  }
  async pullTable(table) {
    let since = this.db.prepare(`SELECT last_pulled_at FROM sync_meta WHERE table_name = ?`).get(table)?.last_pulled_at ?? "1970-01-01T00:00:00.000Z";
    for (; ; ) {
      const { data, error } = await this.supabase.from(table).select("*").gt("updated_at", since).order("updated_at", { ascending: true }).limit(PAGE_SIZE);
      if (error) {
        console.error(`[sync] pull failed for ${table}`, error);
        return;
      }
      if (!data || data.length === 0) return;
      const upsertLocal = this.db.transaction((rows) => {
        for (const row of rows) this.upsertLocalRow(table, row);
      });
      upsertLocal(data);
      since = data[data.length - 1].updated_at;
      this.db.prepare(
        `INSERT INTO sync_meta (table_name, last_pulled_at) VALUES (?, ?)
           ON CONFLICT(table_name) DO UPDATE SET last_pulled_at = excluded.last_pulled_at`
      ).run(table, since);
      if (data.length < PAGE_SIZE) return;
    }
  }
  /**
   * Last-write-wins: only overwrite the local row if the remote copy is
   * newer. Adjust the column list per table to match your actual local
   * schema — this is intentionally generic so it's obvious where to edit.
   */
  upsertLocalRow(table, remote) {
    const local = this.db.prepare(`SELECT updated_at FROM ${table} WHERE id = ?`).get(remote.id);
    if (local && new Date(local.updated_at) >= new Date(remote.updated_at)) {
      return;
    }
    const columns = Object.keys(remote);
    const placeholders = columns.map(() => "?").join(", ");
    const updates = columns.map((c) => `${c} = excluded.${c}`).join(", ");
    this.db.prepare(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})
         ON CONFLICT(id) DO UPDATE SET ${updates}`
    ).run(
      ...columns.map((c) => {
        const value = remote[c];
        if (value === null || value === void 0) return null;
        return typeof value === "object" ? JSON.stringify(value) : value;
      })
    );
  }
  // ---- Realtime (optional) -----------------------------------------------
  /**
   * Subscribe to Postgres changes over websocket so remote updates (e.g.
   * from another session) arrive within ~1s instead of waiting for the next
   * poll. Polling continues regardless — this only shortens the common case.
   */
  enableRealtime() {
    if (this.realtimeChannel) return;
    let channel = this.supabase.channel("orun-sync");
    for (const table of SYNCABLE_TABLES) {
      channel = channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table },
        () => {
          this.pullTable(table).catch((err) => console.error(`[sync] realtime-triggered pull failed for ${table}`, err));
        }
      );
    }
    channel.subscribe((status) => {
      console.log(`[sync] realtime channel status: ${status}`);
    });
    this.realtimeChannel = channel;
  }
  disableRealtime() {
    if (this.realtimeChannel) {
      this.supabase.removeChannel(this.realtimeChannel);
      this.realtimeChannel = null;
    }
  }
};
var syncableTableSchema = zod.z.enum([
  "agents",
  "conversations",
  "messages",
  "usage_events",
  "tts_usage",
  "automations"
]);
var enqueueUpsertPayloadSchema = zod.z.object({
  table: syncableTableSchema,
  recordId: zod.z.string().min(1).max(200),
  // The row itself is intentionally loose (each table has different
  // columns) but bounded — reject absurdly large payloads outright rather
  // than let something try to smuggle megabytes through IPC as a "row".
  row: zod.z.record(zod.z.string(), zod.z.unknown()).refine((row) => JSON.stringify(row).length <= 2e5, {
    message: "row payload exceeds 200KB \u2014 reject rather than silently truncate"
  })
});
var enqueueDeletePayloadSchema = zod.z.object({
  table: syncableTableSchema,
  recordId: zod.z.string().min(1).max(200)
});
var chatMessagePayloadSchema = zod.z.object({
  conversationId: zod.z.string().min(1).max(200),
  content: zod.z.string().min(1).max(5e4),
  role: zod.z.enum(["user", "assistant", "system"])
});

// src/control/satelliteController.ts
var SatelliteController = class {
  constructor(supabase, options) {
    this.supabase = supabase;
    this.options = options;
  }
  get deviceId() {
    return this.options.deviceId;
  }
  get deviceType() {
    return this.options.deviceType;
  }
  /** Registra/renova o heartbeat deste dispositivo (upsert em `devices`). */
  async heartbeat(input = {}) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const row = {
      id: this.options.deviceId,
      tipo: this.options.deviceType,
      nome: input.nome ?? defaultName(this.options.deviceType),
      versao: input.versao ?? null,
      online: true,
      ultimo_seen: now,
      updated_at: now
    };
    const { data, error } = await this.supabase.from("devices").upsert(row, { onConflict: "id" }).select().single();
    if (error) throw error;
    return data;
  }
  /** Marca este dispositivo como offline (chamar no shutdown do app). */
  async markOffline() {
    const { error } = await this.supabase.from("devices").update({ online: false, ultimo_seen: (/* @__PURE__ */ new Date()).toISOString() }).eq("id", this.options.deviceId);
    if (error) throw error;
  }
  /** Hub: lista todos os dispositivos conhecidos (online primeiro). */
  async listDevices() {
    const { data, error } = await this.supabase.from("devices").select("*").order("online", { ascending: false }).order("ultimo_seen", { ascending: false });
    if (error) throw error;
    return data ?? [];
  }
  /** Hub: enfileira um comando para um satélite. */
  async sendCommand(input) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const row = {
      id: newUuid(),
      target: input.target,
      device_id: input.deviceId ?? null,
      action: input.action,
      params: input.params ?? {},
      status: "pending",
      response: null,
      created_at: now,
      sent_at: null,
      completed_at: null
    };
    const { data, error } = await this.supabase.from("commands").insert(row).select().single();
    if (error) throw error;
    return data;
  }
  /** Qualquer lado: consulta o estado de um comando. */
  async getCommand(commandId) {
    const { data, error } = await this.supabase.from("commands").select("*").eq("id", commandId).maybeSingle();
    if (error) throw error;
    return data ?? null;
  }
  /**
   * Satélite: busca comandos pendentes endereçados a este dispositivo
   * (ou broadcast do seu tipo). Hubs não devem chamar — usam sendCommand.
   */
  async pollCommands() {
    if (this.options.deviceType === "desktop" || this.options.deviceType === "mobile") {
      throw new Error(
        "pollCommands \xE9 para sat\xE9lites (tv/shield). Hubs usam listDevices() + sendCommand()."
      );
    }
    const { data, error } = await this.supabase.from("commands").select("*").eq("target", this.options.deviceType).eq("status", "pending").or(`device_id.is.null,device_id.eq.${this.options.deviceId}`).order("created_at", { ascending: true });
    if (error) throw error;
    return data ?? [];
  }
  /** Satélite: confirma o resultado de um comando. */
  async updateCommandStatus(commandId, status, response) {
    const patch = { status };
    if (status === "sent") patch.sent_at = (/* @__PURE__ */ new Date()).toISOString();
    if (status === "done" || status === "failed") patch.completed_at = (/* @__PURE__ */ new Date()).toISOString();
    if (response !== void 0) patch.response = response;
    const { error } = await this.supabase.from("commands").update(patch).eq("id", commandId);
    if (error) throw error;
  }
};
function defaultName(type) {
  switch (type) {
    case "desktop":
      return "Orun OS (desktop)";
    case "mobile":
      return "Orun OS (mobile)";
    case "tv":
      return "Orun TV";
    case "shield":
      return "Orun Shield";
  }
}

exports.SATELLITE_ACTIONS = SATELLITE_ACTIONS;
exports.SatelliteController = SatelliteController;
exports.SyncService = SyncService;
exports.backfill = backfill;
exports.chatMessagePayloadSchema = chatMessagePayloadSchema;
exports.enqueueDelete = enqueueDelete;
exports.enqueueDeletePayloadSchema = enqueueDeletePayloadSchema;
exports.enqueueUpsert = enqueueUpsert;
exports.enqueueUpsertPayloadSchema = enqueueUpsertPayloadSchema;
exports.getSupabaseClient = getSupabaseClient;
exports.initSupabaseFromKeychain = initSupabaseFromKeychain;
exports.newUuid = newUuid;
exports.nextMessageSeq = nextMessageSeq;
exports.syncableTableSchema = syncableTableSchema;
//# sourceMappingURL=index.cjs.map
//# sourceMappingURL=index.cjs.map