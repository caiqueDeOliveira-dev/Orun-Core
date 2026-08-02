import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { RealtimeClientOptions } from "@supabase/realtime-js";

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
export interface SupabaseCredentials {
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

let client: SupabaseClient | null = null;

export function getSupabaseClient(creds: SupabaseCredentials): SupabaseClient {
  if (client) return client;

  const realtime = creds.transport ? { transport: creds.transport } : undefined;

  client = createClient(creds.url, creds.serviceRoleKey, {
    auth: {
      persistSession: false, // service_role is not a user session
      autoRefreshToken: false,
    },
    db: {
      schema: "public",
    },
    realtime,
  });

  return client;
}

/** Call once at app startup, after reading credentials from the keychain. */
export function initSupabaseFromKeychain(readSecret: (key: string) => Promise<string | null>) {
  return (async () => {
    const url = await readSecret("orun.supabase.url");
    const serviceRoleKey = await readSecret("orun.supabase.serviceRoleKey");

    if (!url || !serviceRoleKey) {
      console.warn(
        "[sync] Supabase credentials not found in keychain — hybrid sync disabled, running fully local."
      );
      return null;
    }

    return getSupabaseClient({ url, serviceRoleKey });
  })();
}
