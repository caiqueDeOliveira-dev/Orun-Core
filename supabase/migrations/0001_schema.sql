-- Orun OS — Supabase schema (0001_schema.sql)
-- Mirrors the current SQLite structure. Every syncable table carries
-- updated_at + deleted_at (soft delete) so the hybrid sync engine can do
-- incremental pulls and tombstone-based deletes.

create extension if not exists "uuid-ossp";

-- Agents (18 currently: Hampton + 17 specialized agents)
create table if not exists agents (
  id text primary key,                -- stable slug, e.g. 'hampton', 'nutritionist'
  name text not null,
  role text not null,
  is_core boolean not null default false,
  persona_prompt text,
  default_provider text,              -- ollama | claude | openai | openrouter | groq | github
  default_model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- Conversations
create table if not exists conversations (
  id uuid primary key default uuid_generate_v4(),
  title text not null default 'Nova conversa',
  agent_id text references agents(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- Messages
-- `seq` replaces reliance on created_at for ordering (same fix your test
-- suite caught locally with SQLite rowid) — assigned client-side as a
-- monotonically increasing integer per conversation.
create table if not exists messages (
  id uuid primary key default uuid_generate_v4(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  seq bigint not null,
  role text not null check (role in ('user', 'assistant', 'system')),
  agent_id text references agents(id),
  content text not null,
  provider text,
  model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (conversation_id, seq)
);

create index if not exists idx_messages_conversation on messages (conversation_id, seq);
create index if not exists idx_messages_updated_at on messages (updated_at);

-- Provider usage tracking (cost/usage dashboard — Finance screen)
create table if not exists usage_events (
  id uuid primary key default uuid_generate_v4(),
  provider text not null,
  agent_id text references agents(id),
  tokens_in integer not null default 0,
  tokens_out integer not null default 0,
  cost_usd numeric(10, 5) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists idx_usage_events_provider on usage_events (provider, created_at);

-- TTS character usage tracking
create table if not exists tts_usage (
  id uuid primary key default uuid_generate_v4(),
  engine text not null,              -- elevenlabs | google | azure | xtts | piper | bark | f5
  characters integer not null default 0,
  cost_usd numeric(10, 5) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- Automations (n8n, WhatsApp/Baileys, node-cron jobs)
create table if not exists automations (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  kind text not null,                -- n8n_webhook | whatsapp | cron
  enabled boolean not null default true,
  config jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- Generic "updated_at auto-touch" trigger, applied to every syncable table.
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

do $$
declare
  t text;
begin
  foreach t in array array['agents', 'conversations', 'messages', 'usage_events', 'tts_usage', 'automations']
  loop
    execute format(
      'drop trigger if exists trg_set_updated_at on %I; create trigger trg_set_updated_at before update on %I for each row execute function set_updated_at();',
      t, t
    );
  end loop;
end $$;

-- Realtime (optional): if you use SyncService.enableRealtime() on the app
-- side, Supabase also needs each table added to the `supabase_realtime`
-- publication. Either toggle "Enable Realtime" per table in the Dashboard
-- (Database -> Replication), or run:
--
-- alter publication supabase_realtime add table agents, conversations, messages, usage_events, tts_usage, automations;
--
-- This is NOT required for the regular polling sync to work — only for the
-- optional low-latency websocket path.
