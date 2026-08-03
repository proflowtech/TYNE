-- Beta-launch in-product bug / feedback reports from the Tyne extension.
create table if not exists public.beta_bug_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  kind text not null default 'bug' check (kind in ('bug', 'confusing', 'idea')),
  message text not null check (char_length(trim(message)) >= 3 and char_length(message) <= 4000),
  page text,
  task_id text,
  task_title text,
  extension_version text,
  vscode_version text,
  os text,
  machine_id text,
  client_meta jsonb not null default '{}'::jsonb,
  status text not null default 'new' check (status in ('new', 'triaged', 'resolved', 'wontfix')),
  created_at timestamptz not null default now()
);

alter table public.beta_bug_reports enable row level security;

drop policy if exists "Users can insert own beta bugs" on public.beta_bug_reports;
create policy "Users can insert own beta bugs"
on public.beta_bug_reports
for insert
to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "Users can read own beta bugs" on public.beta_bug_reports;
create policy "Users can read own beta bugs"
on public.beta_bug_reports
for select
to authenticated
using ((select auth.uid()) = user_id);

create index if not exists beta_bug_reports_created_idx
  on public.beta_bug_reports (created_at desc);

create index if not exists beta_bug_reports_user_created_idx
  on public.beta_bug_reports (user_id, created_at desc);

create index if not exists beta_bug_reports_status_idx
  on public.beta_bug_reports (status, created_at desc);

grant select, insert on public.beta_bug_reports to authenticated;
grant all on public.beta_bug_reports to service_role;

comment on table public.beta_bug_reports is 'Beta-launch in-product bug / feedback reports from the Tyne extension.';
