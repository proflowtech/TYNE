-- ============================================================================
-- Tyne product data schema
-- Covers the Free/Pro feature set: projects, PM tasks, threads (goal sessions),
-- proof-points (subtasks), stitches (checkpoint commits), commit-cluster
-- sessions, time logs, validations, solo-mode plans, and PM integrations.
--
-- All rows are scoped by github_id (matching public.user_profiles.github_id).
-- Edge functions use the service_role key, which bypasses RLS. A self-select
-- policy is added on each table so an authenticated user can read their own
-- rows directly if the extension ever queries via the client SDK.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Helper: updated_at trigger
-- ---------------------------------------------------------------------------
create or replace function public.tyne_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc'::text, now());
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- projects  — a workspace / app the developer works on (TyneState.appName)
-- ---------------------------------------------------------------------------
create table if not exists public.projects (
  id          uuid primary key default gen_random_uuid(),
  github_id   text not null,
  name        text not null,
  repo_url    text,
  archived    boolean not null default false,
  created_at  timestamptz not null default timezone('utc'::text, now()),
  updated_at  timestamptz not null default timezone('utc'::text, now())
);
create index if not exists projects_github_id_idx on public.projects(github_id);
create trigger projects_touch before update on public.projects
  for each row execute function public.tyne_touch_updated_at();

-- ---------------------------------------------------------------------------
-- pm_integrations  — OAuth connection to one PM tool (Free: 1, Pro: many)
-- ---------------------------------------------------------------------------
create table if not exists public.pm_integrations (
  id            uuid primary key default gen_random_uuid(),
  github_id     text not null,
  provider      text not null check (provider in ('linear','jira','asana','notion','monday')),
  account_name  text,
  access_token  text,           -- encrypted at rest by Supabase Vault in prod
  refresh_token text,
  expires_at    timestamptz,
  scopes        text,
  created_at    timestamptz not null default timezone('utc'::text, now()),
  updated_at    timestamptz not null default timezone('utc'::text, now()),
  unique (github_id, provider)
);
create index if not exists pm_integrations_github_id_idx on public.pm_integrations(github_id);
create trigger pm_integrations_touch before update on public.pm_integrations
  for each row execute function public.tyne_touch_updated_at();

-- ---------------------------------------------------------------------------
-- tasks  — pulled from a PM tool, or created manually (solo mode)
-- ---------------------------------------------------------------------------
create table if not exists public.tasks (
  id           uuid primary key default gen_random_uuid(),
  github_id    text not null,
  project_id   uuid references public.projects(id) on delete set null,
  source       text not null default 'manual' check (source in ('linear','jira','asana','notion','monday','manual')),
  external_id  text,            -- e.g. 'PRO-102'
  external_url text,
  title        text not null,
  description  text,
  status       text not null default 'todo',
  priority     text,
  assignee     text,
  due_date     timestamptz,
  synced_at    timestamptz,
  created_at   timestamptz not null default timezone('utc'::text, now()),
  updated_at   timestamptz not null default timezone('utc'::text, now())
);
create index if not exists tasks_github_id_idx on public.tasks(github_id);
create index if not exists tasks_project_idx on public.tasks(project_id);
create unique index if not exists tasks_source_external_idx
  on public.tasks(github_id, source, external_id) where external_id is not null;
create trigger tasks_touch before update on public.tasks
  for each row execute function public.tyne_touch_updated_at();

-- ---------------------------------------------------------------------------
-- threads  — one goal-enforcement session (the core Tyne unit of work)
-- ---------------------------------------------------------------------------
create table if not exists public.threads (
  id                uuid primary key default gen_random_uuid(),
  github_id         text not null,
  project_id        uuid references public.projects(id) on delete set null,
  task_id           uuid references public.tasks(id) on delete set null,
  goal              text not null,
  branch_name       text,
  status            text not null default 'weaving' check (status in ('weaving','shipped','abandoned')),
  validation_state  text not null default 'none' check (validation_state in ('none','pass','partial','fail','override')),
  stitch_count      integer not null default 0,
  started_at        timestamptz not null default timezone('utc'::text, now()),
  shipped_at        timestamptz,
  created_at        timestamptz not null default timezone('utc'::text, now()),
  updated_at        timestamptz not null default timezone('utc'::text, now())
);
create index if not exists threads_github_id_idx on public.threads(github_id);
create index if not exists threads_status_idx on public.threads(github_id, status);
create trigger threads_touch before update on public.threads
  for each row execute function public.tyne_touch_updated_at();

-- ---------------------------------------------------------------------------
-- subtasks  — "proof points" within a thread (manual or AI-generated)
-- ---------------------------------------------------------------------------
create table if not exists public.subtasks (
  id                uuid primary key default gen_random_uuid(),
  thread_id         uuid not null references public.threads(id) on delete cascade,
  text              text not null,
  done              boolean not null default false,
  ai_generated      boolean not null default false,
  estimated_minutes integer,
  actual_minutes    integer,
  position          integer not null default 0,
  created_at        timestamptz not null default timezone('utc'::text, now())
);
create index if not exists subtasks_thread_idx on public.subtasks(thread_id);

-- ---------------------------------------------------------------------------
-- stitches  — checkpoint commits made on a thread's branch
-- ---------------------------------------------------------------------------
create table if not exists public.stitches (
  id            uuid primary key default gen_random_uuid(),
  thread_id     uuid not null references public.threads(id) on delete cascade,
  commit_hash   text not null,
  message       text,
  files_changed integer not null default 0,
  lines_added   integer not null default 0,
  lines_removed integer not null default 0,
  committed_at  timestamptz not null default timezone('utc'::text, now())
);
create index if not exists stitches_thread_idx on public.stitches(thread_id);

-- ---------------------------------------------------------------------------
-- sessions  — commit clusters (30-min window) for git-based time tracking
-- ---------------------------------------------------------------------------
create table if not exists public.sessions (
  id               uuid primary key default gen_random_uuid(),
  thread_id        uuid not null references public.threads(id) on delete cascade,
  started_at       timestamptz not null,
  ended_at         timestamptz not null,
  duration_seconds integer not null default 0,
  commit_count     integer not null default 0,
  created_at       timestamptz not null default timezone('utc'::text, now())
);
create index if not exists sessions_thread_idx on public.sessions(thread_id);

-- ---------------------------------------------------------------------------
-- time_logs  — auto (git) or manual time entries, optionally per-subtask
-- ---------------------------------------------------------------------------
create table if not exists public.time_logs (
  id          uuid primary key default gen_random_uuid(),
  github_id   text not null,
  thread_id   uuid references public.threads(id) on delete cascade,
  subtask_id  uuid references public.subtasks(id) on delete set null,
  source      text not null default 'auto' check (source in ('auto','manual')),
  minutes     integer not null default 0,
  note        text,
  logged_at   timestamptz not null default timezone('utc'::text, now())
);
create index if not exists time_logs_github_id_idx on public.time_logs(github_id);
create index if not exists time_logs_thread_idx on public.time_logs(thread_id);

-- ---------------------------------------------------------------------------
-- validations  — AI goal-validation runs (Free: basic, Pro: detailed)
-- ---------------------------------------------------------------------------
create table if not exists public.validations (
  id            uuid primary key default gen_random_uuid(),
  github_id     text not null,
  thread_id     uuid references public.threads(id) on delete cascade,
  result        text not null check (result in ('pass','partial','fail')),
  match_percent integer,
  risk          text check (risk in ('low','medium','high')),
  summary       text,
  details       jsonb,           -- per-subtask reasons, suggestions, missing reqs
  provider      text,            -- 'claude' | 'openai'
  byok          boolean not null default false,
  created_at    timestamptz not null default timezone('utc'::text, now())
);
create index if not exists validations_github_id_idx on public.validations(github_id);
create index if not exists validations_thread_idx on public.validations(thread_id);

-- ---------------------------------------------------------------------------
-- plans  — solo-mode high-level plans (Pro: AI goal + subtask generation)
-- ---------------------------------------------------------------------------
create table if not exists public.plans (
  id           uuid primary key default gen_random_uuid(),
  github_id    text not null,
  project_id   uuid references public.projects(id) on delete set null,
  title        text not null,
  body         text,
  ai_generated boolean not null default false,
  created_at   timestamptz not null default timezone('utc'::text, now()),
  updated_at   timestamptz not null default timezone('utc'::text, now())
);
create index if not exists plans_github_id_idx on public.plans(github_id);
create trigger plans_touch before update on public.plans
  for each row execute function public.tyne_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
--   service_role (edge functions) bypasses RLS automatically.
--   These policies let an authenticated user read their own rows directly.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'projects','pm_integrations','tasks','threads','time_logs','validations','plans'
  ]
  loop
    execute format('alter table public.%I enable row level security;', t);
    execute format($f$
      create policy "owner can read %1$s" on public.%1$I
      for select using (
        github_id = (select github_id from public.user_profiles where id = auth.uid())
      );
    $f$, t);
  end loop;

  -- child tables: scope through their parent thread
  foreach t in array array['subtasks','stitches','sessions']
  loop
    execute format('alter table public.%I enable row level security;', t);
    execute format($f$
      create policy "owner can read %1$s" on public.%1$I
      for select using (
        exists (
          select 1 from public.threads th
          join public.user_profiles up on up.github_id = th.github_id
          where th.id = %1$I.thread_id and up.id = auth.uid()
        )
      );
    $f$, t);
  end loop;
end $$;
