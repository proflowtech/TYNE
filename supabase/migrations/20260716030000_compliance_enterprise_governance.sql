-- Phase 3: enterprise governance — finding workflow + richer custom policies.

create table if not exists public.compliance_finding_workflow (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  report_id text not null,
  finding_id text not null,
  finding_title text not null default '',
  framework text,
  status text not null default 'open'
    check (status in ('open', 'assigned', 'in_progress', 'accepted_risk', 'resolved', 'rejected')),
  owner text,
  comments text,
  resolution text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, report_id, finding_id)
);

create index if not exists compliance_finding_workflow_report_idx
  on public.compliance_finding_workflow (user_id, report_id);

alter table public.compliance_finding_workflow enable row level security;

drop policy if exists "Users manage own compliance finding workflow" on public.compliance_finding_workflow;
create policy "Users manage own compliance finding workflow"
on public.compliance_finding_workflow
for all
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

-- Enrich custom enterprise policies (category + action live in columns; patterns stay in rule_config).
alter table public.custom_compliance_policies
  add column if not exists category text,
  add column if not exists action text
    check (action is null or action in ('block', 'review', 'inform'));

create index if not exists custom_compliance_policies_user_category_idx
  on public.custom_compliance_policies (user_id, category)
  where enabled;
