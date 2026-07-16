create table if not exists public.validate_review_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,

  repository_id text,
  repository_name text,

  thread_id text,
  issue_source text check (issue_source is null or issue_source in ('jira', 'linear', 'manual')),
  issue_id text,
  issue_identifier text,
  issue_title text,

  branch_name text not null,
  commit_sha text,
  base_sha text,
  head_sha text,
  review_scope text not null check (review_scope in ('staged_changes', 'unstaged_changes', 'last_commit', 'selected_commit')),

  status text not null check (status in ('passed', 'needs_work', 'blocked', 'context_limited')),
  score int not null check (score >= 0 and score <= 100),
  risk_level text not null check (risk_level in ('low', 'medium', 'high')),
  vibe_code_risk text check (vibe_code_risk is null or vibe_code_risk in ('low', 'medium', 'high')),
  confidence text not null check (confidence in ('high', 'medium', 'low')),

  summary text not null,

  completed_goals jsonb not null default '[]'::jsonb,
  pending_goals jsonb not null default '[]'::jsonb,
  findings jsonb not null default '[]'::jsonb,
  missing_tests jsonb not null default '[]'::jsonb,
  next_actions jsonb not null default '[]'::jsonb,
  visual_diff jsonb not null default '[]'::jsonb,
  full_report text,

  model_info jsonb,
  token_usage jsonb,

  created_at timestamptz not null default now()
);

alter table public.validate_review_reports enable row level security;

drop policy if exists "Users can read own validate review reports" on public.validate_review_reports;
create policy "Users can read own validate review reports"
on public.validate_review_reports
for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert own validate review reports" on public.validate_review_reports;
create policy "Users can insert own validate review reports"
on public.validate_review_reports
for insert
to authenticated
with check ((select auth.uid()) = user_id);

create index if not exists validate_review_reports_user_created_idx
on public.validate_review_reports(user_id, created_at desc);

create index if not exists validate_review_reports_thread_idx
on public.validate_review_reports(user_id, thread_id, created_at desc);

create index if not exists validate_review_reports_issue_idx
on public.validate_review_reports(user_id, issue_identifier, created_at desc);

create index if not exists validate_review_reports_branch_idx
on public.validate_review_reports(user_id, branch_name, created_at desc);

create index if not exists validate_review_reports_status_idx
on public.validate_review_reports(user_id, status, created_at desc);
