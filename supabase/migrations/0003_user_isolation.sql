-- Orun OS — User isolation (0003_user_isolation.sql)
--
-- Adds user_id to conversations, messages, and automations so each
-- Supabase Auth user only sees their own data. The `agents` table stays
-- shared (all users see the same agents configured by the admin).
-- `usage_events` and `tts_usage` also stay shared (cost tracking is global).

-- 1) Add user_id columns
alter table conversations add column if not exists user_id uuid references auth.users(id);
alter table messages add column if not exists user_id uuid references auth.users(id);
alter table automations add column if not exists user_id uuid references auth.users(id);

-- 2) Backfill existing rows with the first authenticated user
--    (run this ONCE — safe to re-run due to IS NULL check)
do $$
declare
  first_user uuid;
begin
  select id into first_user from auth.users order by created_at asc limit 1;

  if first_user is not null then
    update conversations set user_id = first_user where user_id is null;
    update messages set user_id = first_user where user_id is null;
    update automations set user_id = first_user where user_id is null;
  end if;
end $$;

-- 3) Create indexes for user_id lookups
create index if not exists idx_conversations_user on conversations (user_id);
create index if not exists idx_messages_user on messages (user_id);
create index if not exists idx_automations_user on automations (user_id);

-- 4) Drop old blanket RLS policies
do $$
declare
  t text;
begin
  foreach t in array array['conversations', 'messages', 'automations']
  loop
    execute format('drop policy if exists "authenticated_full_access" on %I', t);
  end loop;
end $$;

-- 5) Create scoped RLS policies: each user only sees their own data
create policy "user_isolation" on conversations
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "user_isolation" on messages
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "user_isolation" on automations
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- 6) agents, usage_events, tts_usage keep the old blanket policy (shared)
--    (no change needed — they still have "authenticated_full_access")
