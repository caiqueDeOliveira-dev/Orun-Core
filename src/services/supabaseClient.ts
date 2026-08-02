import { createClient, SupabaseClient } from "@supabase/supabase-js";

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
}

let client: SupabaseClient | null = null;

export function getSupabaseClient(creds: SupabaseCredentials): SupabaseClient {
  if (client) return client;

  client = createClient(creds.url, creds.serviceRoleKey, {
    auth: {
      persistSession: false, // service_role is not a user session
      autoRefreshToken: false,
    },
    db: {
      schema: "public",
    },
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
