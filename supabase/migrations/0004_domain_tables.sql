-- Orun OS — Domain tables (0004_domain_tables.sql)
--
-- Adds the 10 domain-specific tables described in the spec.
-- All carry updated_at + deleted_at for hybrid sync, and user_id for
-- per-user isolation (same pattern as 0003_user_isolation).

-- ─── Health ────────────────────────────────────────────────────────
create table if not exists health_log (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id),
  date date not null default current_date,
  kind text not null check (kind in ('meal', 'workout', 'metric', 'body_measurement', 'exam')),
  -- meal fields
  description text,
  calories integer,
  protein_g numeric(6,1),
  carbs_g numeric(6,1),
  fat_g numeric(6,1),
  -- workout fields
  exercise_name text,
  duration_min integer,
  calories_burned integer,
  -- metric fields
  metric text,            -- peso, pressao, frequencia_cardiaca, passos, sono
  value numeric(10,2),
  unit text,
  -- body_measurement fields
  height_cm numeric(5,1),
  chest_cm numeric(5,1),
  waist_cm numeric(5,1),
  hips_cm numeric(5,1),
  right_arm_cm numeric(5,1),
  left_arm_cm numeric(5,1),
  right_thigh_cm numeric(5,1),
  left_thigh_cm numeric(5,1),
  -- exam fields
  exam_type text,         -- sangue, urina, imagem, etc.
  exam_name text,
  exam_results jsonb,
  -- meta
  notes text,
  source text not null default 'mobile',  -- mobile | desktop | ai
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists idx_health_log_user_date on health_log (user_id, date);
create index if not exists idx_health_log_user_kind on health_log (user_id, kind);

-- ─── Finance ───────────────────────────────────────────────────────
create table if not exists finance_log (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id),
  date date not null default current_date,
  description text not null,
  amount numeric(12,2) not null,
  currency text not null default 'BRL',
  category text not null check (category in (
    'food', 'transport', 'housing', 'entertainment', 'health',
    'education', 'salary', 'investment', 'other'
  )),
  type text not null check (type in ('expense', 'income')),
  source text not null default 'mobile',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists idx_finance_log_user_date on finance_log (user_id, date);
create index if not exists idx_finance_log_user_category on finance_log (user_id, category);

-- ─── Marketing ─────────────────────────────────────────────────────
create table if not exists marketing_log (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id),
  date date not null default current_date,
  campaign_name text,
  objective text,
  channels jsonb,            -- ["instagram", "tiktok"]
  platform text,             -- instagram | tiktok | twitter
  format text,               -- reels | stories | carrossel | x_post | tiktok
  hook text,
  hashtags jsonb,
  cta text,
  post_title text,
  post_body text,
  image_url text,
  status text default 'draft',  -- draft | published | scheduled
  source text not null default 'mobile',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists idx_marketing_log_user_date on marketing_log (user_id, date);

-- ─── Developer Reviews ─────────────────────────────────────────────
create table if not exists developer_reviews (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id),
  date date not null default current_date,
  repo text,
  file_path text,
  summary text,
  issues_found integer default 0,
  severity text check (severity in ('low', 'medium', 'high', 'critical')),
  source text not null default 'mobile',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists idx_dev_reviews_user_date on developer_reviews (user_id, date);

-- ─── Teacher Progress ──────────────────────────────────────────────
create table if not exists teacher_progress (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id),
  date date not null default current_date,
  subject text not null,
  topic text,
  status text check (status in ('learning', 'reviewing', 'mastered')),
  score numeric(5,1),
  quiz_data jsonb,           -- questions + answers
  source text not null default 'mobile',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists idx_teacher_progress_user on teacher_progress (user_id, subject);

-- ─── Video Projects ────────────────────────────────────────────────
create table if not exists video_projects (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id),
  title text not null,
  template text,
  duration_sec numeric(10,1),
  status text default 'draft',  -- draft | rendering | done
  timeline jsonb,               -- clips, effects, transitions
  source text not null default 'mobile',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- ─── Image/3D Generations ──────────────────────────────────────────
create table if not exists image3d_generations (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id),
  engine text not null,        -- fal | stable-diffusion | flux
  prompt text not null,
  model_used text,
  output_url text,
  metadata jsonb,
  source text not null default 'mobile',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- ─── Memories (long-term) ──────────────────────────────────────────
create table if not exists memories (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id),
  key text not null,
  content text not null,
  tags jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists idx_memories_user on memories (user_id, key);

-- ─── Settings (server-side) ────────────────────────────────────────
create table if not exists settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- ─── WhatsApp Keyword Rules ────────────────────────────────────────
create table if not exists whatsapp_keyword_rules (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id),
  keywords jsonb not null,     -- ["urgente", "importante"]
  agent text not null,
  action text not null check (action in ('notify', 'task', 'summary')),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- ─── Job Scheduler ─────────────────────────────────────────────────
create table if not exists scheduled_jobs (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id),
  agent_id text not null,
  name text not null,
  cron_expression text not null,   -- "* * * * *" format
  prompt text not null,
  enabled boolean not null default true,
  last_run_at timestamptz,
  next_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists idx_scheduled_jobs_user on scheduled_jobs (user_id);
create index if not exists idx_scheduled_jobs_next_run on scheduled_jobs (next_run_at) where enabled = true;

-- ─── Job Run History ───────────────────────────────────────────────
create table if not exists job_runs (
  id uuid primary key default uuid_generate_v4(),
  job_id uuid not null references scheduled_jobs(id) on delete cascade,
  user_id uuid not null references auth.users(id),
  status text not null check (status in ('success', 'error', 'skipped')),
  result text,
  error_message text,
  duration_ms integer,
  ran_at timestamptz not null default now()
);

create index if not exists idx_job_runs_job on job_runs (job_id, ran_at desc);

-- ─── Triggers for updated_at ───────────────────────────────────────
do $$
declare
  t text;
begin
  foreach t in array array[
    'health_log', 'finance_log', 'marketing_log', 'developer_reviews',
    'teacher_progress', 'video_projects', 'image3d_generations',
    'memories', 'whatsapp_keyword_rules', 'scheduled_jobs'
  ]
  loop
    execute format(
      'drop trigger if exists trg_set_updated_at on %I; create trigger trg_set_updated_at before update on %I for each row execute function set_updated_at();',
      t, t
    );
  end loop;
end $$;

-- ─── RLS: per-user isolation ───────────────────────────────────────
do $$
declare
  t text;
begin
  foreach t in array array[
    'health_log', 'finance_log', 'marketing_log', 'developer_reviews',
    'teacher_progress', 'video_projects', 'image3d_generations',
    'memories', 'whatsapp_keyword_rules', 'scheduled_jobs', 'job_runs'
  ]
  loop
    execute format('alter table %I enable row level security;', t);
    execute format(
      'create policy "user_isolation" on %I for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());',
      t
    );
  end loop;
end $$;

-- settings table: blanket access (admin config, not per-user)
alter table settings enable row level security;
create policy "authenticated_full_access" on settings
  for all to authenticated using (true) with check (true);
