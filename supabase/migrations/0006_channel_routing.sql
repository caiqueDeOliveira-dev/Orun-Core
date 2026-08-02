-- Orun OS — Channel-based routing (0006_channel_routing.sql)
--
-- Adds group_jid (WhatsApp group ID) and channel (whatsapp|telegram|dm)
-- columns to whatsapp_keyword_rules for per-group agent routing.
-- Also renames the table conceptually to support multiple channels.

-- Add new columns
alter table whatsapp_keyword_rules add column if not exists group_jid text;
alter table whatsapp_keyword_rules add column if not exists channel text not null default 'dm'
  check (channel in ('dm', 'group', 'telegram'));

-- Index for fast group_jid lookups
create index if not exists idx_wkr_group_jid on whatsapp_keyword_rules (group_jid) where group_jid is not null and enabled = true;
create index if not exists idx_wkr_channel on whatsapp_keyword_rules (channel) where enabled = true;
