-- Enterprise compliance hardening: DB as policy source, safer statuses, indexes, RLS.

alter table public.compliance_frameworks
  add column if not exists updated_at timestamptz not null default now();

alter table public.compliance_controls
  add column if not exists version text not null default '1';

alter table public.compliance_rules
  add column if not exists rule_id text,
  add column if not exists severity text check (severity in ('critical', 'high', 'medium', 'low')),
  add column if not exists blocking boolean not null default false;

-- Unique executable rule identity per control (nullable rule_id allowed for legacy stubs).
create unique index if not exists compliance_rules_control_rule_uidx
  on public.compliance_rules(control_id, rule_id)
  where rule_id is not null;

create index if not exists compliance_reviews_review_id_idx
  on public.compliance_reviews(review_id);

create index if not exists compliance_frameworks_enabled_idx
  on public.compliance_frameworks(enabled)
  where enabled;

-- Expand assessment status vocabulary (keep legacy values for old rows).
alter table public.compliance_reviews drop constraint if exists compliance_reviews_status_check;
alter table public.compliance_reviews
  add constraint compliance_reviews_status_check
  check (status in (
    'passed', 'warning', 'needs_work', 'blocked',
    'no_violations', 'issues_detected', 'review_required', 'not_enabled'
  ));

update public.compliance_frameworks
set version = '2026.1', updated_at = now()
where id = 'HIPAA';

-- Catalogs are readable by authenticated clients (engine uses service role; UI may list frameworks).
drop policy if exists "Authenticated read compliance frameworks" on public.compliance_frameworks;
create policy "Authenticated read compliance frameworks"
on public.compliance_frameworks
for select
to authenticated
using (enabled = true);

drop policy if exists "Authenticated read compliance controls" on public.compliance_controls;
create policy "Authenticated read compliance controls"
on public.compliance_controls
for select
to authenticated
using (
  exists (
    select 1 from public.compliance_frameworks f
    where f.id = framework_id and f.enabled = true
  )
);

drop policy if exists "Authenticated read compliance rules" on public.compliance_rules;
create policy "Authenticated read compliance rules"
on public.compliance_rules
for select
to authenticated
using (enabled = true);
