import Database from 'better-sqlite3';
import { SupabaseClient } from '@supabase/supabase-js';
import { RealtimeClientOptions } from '@supabase/realtime-js';
import { z } from 'zod';

/** Tipos de dispositivo no ecossistema Orun (modelo hub-and-spoke). */
type DeviceType = "desktop" | "mobile" | "tv" | "shield";
/** Alvo de comando — os satélites que o hub controla. */
type SatelliteTarget = Extract<DeviceType, "tv" | "shield">;
/** Linha da tabela `devices` (registro + heartbeat de cada aparelho). */
interface Device {
    id: string;
    tipo: DeviceType;
    nome: string;
    versao: string | null;
    online: boolean;
    ultimo_seen: string;
    created_at: string;
    updated_at: string;
}
type CommandStatus = "pending" | "sent" | "acknowledged" | "done" | "failed";
/** Linha da tabela `commands` — fila hub -> satélite. */
interface Command {
    id: string;
    target: SatelliteTarget;
    /** Nulo = broadcast para qualquer satélite do tipo `target`. */
    device_id: string | null;
    action: string;
    params: Record<string, unknown>;
    status: CommandStatus;
    response: unknown | null;
    created_at: string;
    sent_at: string | null;
    completed_at: string | null;
}
/** Ações documentadas do contrato hub <-> satélite (não exaustivo). */
declare const SATELLITE_ACTIONS: {
    readonly power: readonly ["power.on", "power.off", "power.toggle"];
    readonly volume: readonly ["volume.up", "volume.down", "volume.set", "mute.toggle"];
    readonly media: readonly ["media.play", "media.pause", "media.stop", "media.next", "media.prev", "media.seek"];
    readonly input: readonly ["input.switch", "app.launch"];
    readonly status: readonly ["status.get"];
};
/** Dados enviados no heartbeat de um dispositivo. */
interface HeartbeatInput {
    nome?: string;
    versao?: string;
}

/**
 * UUID v4 — portável entre Electron main (Node) e React Native (Hermes).
 * Usa crypto.randomUUID() quando disponível e cai para uma implementação
 * pura em JS quando não está (ex.: Hermes sem crypto polyfill).
 */
declare function newUuid(): string;

type SyncableTable = "agents" | "conversations" | "messages" | "usage_events" | "tts_usage" | "automations";
/**
 * Call this right after any local INSERT/UPDATE (upsert) in your existing
 * repository code. It does NOT touch the network — it just queues the
 * intent. The sync worker (syncService.ts) drains this queue in the
 * background, so writes stay instant and offline-safe.
 *
 * Usage in your existing message-insert code:
 *   db.prepare("INSERT INTO messages (...) VALUES (...)").run(...);
 *   enqueueUpsert(db, "messages", message.id, message);
 */
declare function enqueueUpsert(db: Database.Database, table: SyncableTable, recordId: string, row: unknown): void;
/**
 * Call after a local soft-delete (UPDATE ... SET deleted_at = ...).
 * Hard deletes are avoided on purpose — a tombstone (deleted_at set) is what
 * lets the other "device" (or a future Supabase-only client) know to remove
 * the row too, instead of just silently never seeing it again.
 */
declare function enqueueDelete(db: Database.Database, table: SyncableTable, recordId: string): void;
/**
 * Safely allocates the next `seq` for a message in a conversation.
 * better-sqlite3 calls are synchronous, so this read-then-use is safe as
 * long as the INSERT happens right after, in the same synchronous call
 * stack — don't `await` anything between calling this and the INSERT, or
 * two concurrent async callers (e.g. two provider streams replying at once)
 * could read the same value and collide against the
 * UNIQUE(conversation_id, seq) constraint from the Supabase schema.
 *
 * Usage:
 *   const seq = nextMessageSeq(db, conversationId);
 *   db.prepare("INSERT INTO messages (id, conversation_id, seq, ...) VALUES (?, ?, ?, ...)").run(id, conversationId, seq, ...);
 *   enqueueUpsert(db, "messages", id, { id, conversation_id: conversationId, seq, ... });
 */
declare function nextMessageSeq(db: Database.Database, conversationId: string): number;

interface BackfillProgress {
    table: SyncableTable;
    pushed: number;
    total: number;
}
/**
 * One-time migration: pushes every existing row in the local SQLite tables
 * up to Supabase, in batches, BEFORE the regular sync loop starts.
 *
 * Run this once, manually, the first time you turn sync on. Do NOT run it
 * on every app start — it re-upserts everything every time, which is
 * harmless but wasteful once the regular SyncService has taken over.
 *
 * Usage:
 *   await backfill(db, supabase, (p) => console.log(`${p.table}: ${p.pushed}/${p.total}`));
 */
declare function backfill(db: Database.Database, supabase: SupabaseClient, onProgress?: (progress: BackfillProgress) => void): Promise<void>;

/**
 * Supabase client for Orun OS's hybrid sync.
 *
 * CRITICAL: this file must only ever run in the Electron MAIN process.
 * It uses the `service_role` key, which bypasses Row Level Security —
 * if this ever gets bundled into renderer/preload code, anyone who opens
 * DevTools on the app has full read/write access to your database.
 *
 * Pull both values from the OS keychain (the same mechanism you already
 * use for provider API keys), not from a renderer-accessible .env.
 */
interface SupabaseCredentials {
    url: string;
    serviceRoleKey: string;
    /**
     * WebSocket implementation (ex.: `require("ws")`) para runtimes sem
     * WebSocket nativo (Node < 22, Electron main). O SupabaseClient instancia
     * o RealtimeClient na criação e falha se WebSocket não existir — mesmo que
     * nenhum canal realtime seja usado (o SatelliteController é REST-only).
     */
    transport?: RealtimeClientOptions["transport"];
}
declare function getSupabaseClient(creds: SupabaseCredentials): SupabaseClient;
/** Call once at app startup, after reading credentials from the keychain. */
declare function initSupabaseFromKeychain(readSecret: (key: string) => Promise<string | null>): Promise<SupabaseClient<any, "public", "public", any, any> | null>;

/**
 * Hybrid sync engine. SQLite stays the source of truth for the app's normal
 * read/write path (instant, works offline). This engine runs on an interval
 * in the Electron main process and does two things:
 *
 *  1. PUSH — drains `sync_queue` (rows written locally) up to Supabase,
 *     with exponential backoff on failure and a dead-letter cutoff.
 *  2. PULL — fetches rows changed in Supabase since the last pull, paginated
 *     so a large backlog doesn't take many cycles to catch up.
 *
 * Conflict resolution: last-write-wins by `updated_at`. Fine for a
 * single-user app used from one device at a time.
 *
 * Optional Realtime: call `enableRealtime()` to also react to Postgres
 * changes over websocket, so cross-device updates arrive in near-real-time
 * instead of waiting for the next poll cycle. Polling keeps running
 * regardless — Realtime is a latency improvement, not a replacement (it can
 * silently miss events during a dropped connection; polling is the safety net).
 */
declare class SyncService {
    private db;
    private supabase;
    private intervalMs;
    private timer;
    private realtimeChannel;
    private running;
    private lastSuccessAt;
    private lastCycleError;
    constructor(db: Database.Database, supabase: SupabaseClient, intervalMs?: number);
    start(): void;
    stop(): void;
    runOnce(): Promise<void>;
    /**
     * Snapshot of sync health, meant to be polled from the UI (e.g. every few
     * seconds via IPC) to drive a StatusChip in Developer/Settings. Cheap —
     * just SQLite COUNT queries, no network calls.
     */
    getSyncStatus(): {
        pending: number;
        deadLetterCount: number;
        lastSuccessAt: string | null;
        lastError: string | null;
        isRunning: boolean;
        realtimeEnabled: boolean;
    };
    /** Rows that hit MAX_ATTEMPTS and stopped retrying automatically. Surface these in a Developer/Settings screen. */
    getDeadLetters(): Array<{
        id: number;
        table_name: string;
        record_id: string;
        op: string;
        last_error: string | null;
    }>;
    /** Reset dead-letter items (or all failed items) to try again immediately — e.g. a "Retry sync" button. */
    retryFailed(): void;
    private push;
    private pull;
    private pullTable;
    /**
     * Last-write-wins: only overwrite the local row if the remote copy is
     * newer. Adjust the column list per table to match your actual local
     * schema — this is intentionally generic so it's obvious where to edit.
     */
    private upsertLocalRow;
    /**
     * Subscribe to Postgres changes over websocket so remote updates (e.g.
     * from another session) arrive within ~1s instead of waiting for the next
     * poll. Polling continues regardless — this only shortens the common case.
     */
    enableRealtime(): void;
    disableRealtime(): void;
}

/**
 * Validates data crossing the IPC boundary from renderer -> main process
 * BEFORE it reaches SyncService/SQLite. The renderer is inherently less
 * trusted than the main process — even with contextIsolation and no
 * nodeIntegration, a bug elsewhere in the app (e.g. rendering unsanitized
 * WhatsApp message content) could let someone influence what a
 * `ipcMain.handle` call receives. Validating shape/type here means a
 * malformed or hostile payload gets rejected with a clear error instead of
 * silently corrupting the sync_queue or crashing the main process.
 *
 * Usage in your ipcMain handlers:
 *   ipcMain.handle("sync:enqueueUpsert", (_event, payload) => {
 *     const parsed = enqueueUpsertPayloadSchema.parse(payload); // throws on invalid input
 *     enqueueUpsert(db, parsed.table, parsed.recordId, parsed.row);
 *   });
 */
declare const syncableTableSchema: z.ZodEnum<{
    agents: "agents";
    conversations: "conversations";
    messages: "messages";
    usage_events: "usage_events";
    tts_usage: "tts_usage";
    automations: "automations";
}>;
declare const enqueueUpsertPayloadSchema: z.ZodObject<{
    table: z.ZodEnum<{
        agents: "agents";
        conversations: "conversations";
        messages: "messages";
        usage_events: "usage_events";
        tts_usage: "tts_usage";
        automations: "automations";
    }>;
    recordId: z.ZodString;
    row: z.ZodRecord<z.ZodString, z.ZodUnknown>;
}, z.core.$strip>;
declare const enqueueDeletePayloadSchema: z.ZodObject<{
    table: z.ZodEnum<{
        agents: "agents";
        conversations: "conversations";
        messages: "messages";
        usage_events: "usage_events";
        tts_usage: "tts_usage";
        automations: "automations";
    }>;
    recordId: z.ZodString;
}, z.core.$strip>;
/**
 * Validates chat message payloads crossing the IPC boundary.
 * Currently unused — reserved for when the Electron app is integrated
 * and chat messages flow through IPC handlers.
 */
declare const chatMessagePayloadSchema: z.ZodObject<{
    conversationId: z.ZodString;
    content: z.ZodString;
    role: z.ZodEnum<{
        user: "user";
        assistant: "assistant";
        system: "system";
    }>;
}, z.core.$strip>;
type EnqueueUpsertPayload = z.infer<typeof enqueueUpsertPayloadSchema>;
type EnqueueDeletePayload = z.infer<typeof enqueueDeletePayloadSchema>;
type ChatMessagePayload = z.infer<typeof chatMessagePayloadSchema>;

interface SatelliteControllerOptions {
    /** Id persistido deste dispositivo (gerado na primeira execução e salvo). */
    deviceId: string;
    deviceType: DeviceType;
}
interface SendCommandInput {
    target: SatelliteTarget;
    action: string;
    params?: Record<string, unknown>;
    /** Nulo = broadcast para qualquer satélite do tipo `target`. */
    deviceId?: string | null;
}
/**
 * Controle dos dispositivos do ecossistema via Supabase.
 *
 * Serve os DOIS lados do modelo hub-and-spoke:
 *  - Hub (desktop/mobile): `heartbeat()`, `listDevices()`, `sendCommand()`,
 *    `getCommand()` — envia comandos e acompanha o estado de tudo.
 *  - Satélite (TV/Shield): `heartbeat()`, `pollCommands()`,
 *    `updateCommandStatus()` — reporta presença e processa só o que é seu
 *    (nunca consulta linhas de outros satélites: cegos entre si por design).
 *
 * Credenciais: usa o MESMO client Supabase da engine de sync. Deve ser
 * instanciado apenas no processo principal de cada app, com service_role
 * lida do keychain — nunca no renderer.
 */
declare class SatelliteController {
    private readonly supabase;
    private readonly options;
    constructor(supabase: SupabaseClient, options: SatelliteControllerOptions);
    get deviceId(): string;
    get deviceType(): DeviceType;
    /** Registra/renova o heartbeat deste dispositivo (upsert em `devices`). */
    heartbeat(input?: HeartbeatInput): Promise<Device>;
    /** Marca este dispositivo como offline (chamar no shutdown do app). */
    markOffline(): Promise<void>;
    /** Hub: lista todos os dispositivos conhecidos (online primeiro). */
    listDevices(): Promise<Device[]>;
    /** Hub: enfileira um comando para um satélite. */
    sendCommand(input: SendCommandInput): Promise<Command>;
    /** Qualquer lado: consulta o estado de um comando. */
    getCommand(commandId: string): Promise<Command | null>;
    /**
     * Satélite: busca comandos pendentes endereçados a este dispositivo
     * (ou broadcast do seu tipo). Hubs não devem chamar — usam sendCommand.
     */
    pollCommands(): Promise<Command[]>;
    /** Satélite: confirma o resultado de um comando. */
    updateCommandStatus(commandId: string, status: CommandStatus, response?: unknown): Promise<void>;
}

export { type BackfillProgress, type ChatMessagePayload, type Command, type CommandStatus, type Device, type DeviceType, type EnqueueDeletePayload, type EnqueueUpsertPayload, type HeartbeatInput, SATELLITE_ACTIONS, SatelliteController, type SatelliteControllerOptions, type SatelliteTarget, type SendCommandInput, type SupabaseCredentials, SyncService, type SyncableTable, backfill, chatMessagePayloadSchema, enqueueDelete, enqueueDeletePayloadSchema, enqueueUpsert, enqueueUpsertPayloadSchema, getSupabaseClient, initSupabaseFromKeychain, newUuid, nextMessageSeq, syncableTableSchema };
