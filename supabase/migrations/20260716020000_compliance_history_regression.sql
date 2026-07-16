-- Phase 2: compliance history for regression tracking across commits.

create table if not exists public.compliance_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  repository_id text,
  repository_name text,
  commit_hash text,
  framework text not null,
  status text not null,
  score integer not null check (score between 0 and 100),
  findings jsonb not null default '[]'::jsonb,
  coverage jsonb not null default '[]'::jsonb,
  review_id uuid references public.validate_review_reports(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists compliance_history_repo_framework_created_idx
  on public.compliance_history (repository_id, framework, created_at desc);

create index if not exists compliance_history_user_created_idx
  on public.compliance_history (user_id, created_at desc);

create index if not exists compliance_history_commit_idx
  on public.compliance_history (commit_hash)
  where commit_hash is not null;

alter table public.compliance_history enable row level security;

drop policy if exists "Users read own compliance history" on public.compliance_history;
create policy "Users read own compliance history"
on public.compliance_history
for select
to authenticated
using ((select auth.uid()) = user_id);

-- Inserts are performed by edge functions with service role.
