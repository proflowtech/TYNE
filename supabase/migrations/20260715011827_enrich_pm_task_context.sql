alter table public.tyne_pm_task_contexts
  add column if not exists pm_context jsonb not null default '{}'::jsonb,
  add column if not exists developer_task_plan jsonb not null default '{}'::jsonb;

alter table public.linear_issue_contexts
  add column if not exists pm_context jsonb not null default '{}'::jsonb,
  add column if not exists developer_task_plan jsonb not null default '{}'::jsonb;

comment on column public.tyne_pm_task_contexts.pm_context is
  'Structured PM requirements, decisions, constraints, comments, attachments, and linked issues.';
comment on column public.linear_issue_contexts.pm_context is
  'Structured PM requirements, decisions, constraints, comments, attachments, and linked issues.';
