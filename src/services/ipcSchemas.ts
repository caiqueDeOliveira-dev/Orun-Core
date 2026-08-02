import { z } from "zod";

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

export const syncableTableSchema = z.enum([
  "agents",
  "conversations",
  "messages",
  "usage_events",
  "tts_usage",
  "automations",
]);

export const enqueueUpsertPayloadSchema = z.object({
  table: syncableTableSchema,
  recordId: z.string().min(1).max(200),
  // The row itself is intentionally loose (each table has different
  // columns) but bounded — reject absurdly large payloads outright rather
  // than let something try to smuggle megabytes through IPC as a "row".
  row: z.record(z.string(), z.unknown()).refine((row) => JSON.stringify(row).length <= 200_000, {
    message: "row payload exceeds 200KB — reject rather than silently truncate",
  }),
});

export const enqueueDeletePayloadSchema = z.object({
  table: syncableTableSchema,
  recordId: z.string().min(1).max(200),
});

/**
 * Validates chat message payloads crossing the IPC boundary.
 * Currently unused — reserved for when the Electron app is integrated
 * and chat messages flow through IPC handlers.
 */
export const chatMessagePayloadSchema = z.object({
  conversationId: z.string().min(1).max(200),
  content: z.string().min(1).max(50_000),
  role: z.enum(["user", "assistant", "system"]),
});

export type EnqueueUpsertPayload = z.infer<typeof enqueueUpsertPayloadSchema>;
export type EnqueueDeletePayload = z.infer<typeof enqueueDeletePayloadSchema>;
export type ChatMessagePayload = z.infer<typeof chatMessagePayloadSchema>;
