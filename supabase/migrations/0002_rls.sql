-- Orun OS — Supabase RLS (0002_rls.sql)
--
-- UPDATED for mobile access: the desktop app (Electron main process) still
-- uses the `service_role` key, which bypasses RLS entirely — the policies
-- below don't affect it. But the mobile app is a genuinely different trust
-- boundary: it's not a controlled main process, it's a phone that can be
-- lost, decompiled, or have its storage inspected. It authenticates as a
-- real Supabase Auth user (signed in once, session token in Expo
-- SecureStore) and uses the `anon` key + that session — NEVER service_role.
--
-- Since Orun OS is single-user, these policies don't scope by `auth.uid()`
-- (no `user_id` column) — anyone who successfully authenticates as YOUR one
-- account can read/write everything, same as the desktop app can. The real
-- security boundary is "did they get past Supabase Auth", not per-row
-- ownership. If Orun OS ever supports multiple real users, add a `user_id`
-- column to every table and scope these policies with
-- `using (user_id = auth.uid())` instead of the blanket `authenticated` check.

alter table agents        enable row level security;
alter table conversations  enable row level security;
alter table messages        enable row level security;
alter table usage_events    enable row level security;
alter table tts_usage       enable row level security;
alter table automations     enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['agents', 'conversations', 'messages', 'usage_events', 'tts_usage', 'automations']
  loop
    execute format(
      'drop policy if exists "authenticated_full_access" on %I; create policy "authenticated_full_access" on %I for all to authenticated using (true) with check (true);',
      t, t
    );
  end loop;
end $$;

-- `anon` (unauthenticated) role still gets nothing — no policy for it, and
-- RLS defaults to deny. This is what protects the data if the anon key
-- alone ever leaks without a valid session attached to it.
