create table if not exists public.compliance_frameworks (
  id text primary key,
  name text not null,
  version text not null,
  description text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.compliance_controls (
  id uuid primary key default gen_random_uuid(),
  framework_id text not null references public.compliance_frameworks(id) on delete cascade,
  control_id text not null,
  name text not null,
  description text not null,
  severity text not null check (severity in ('critical', 'high', 'medium', 'low')),
  rule_config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (framework_id, control_id)
);

create table if not exists public.compliance_rules (
  id uuid primary key default gen_random_uuid(),
  control_id uuid not null references public.compliance_controls(id) on delete cascade,
  rule_type text not null check (rule_type in ('pattern', 'dataflow', 'ast', 'custom')),
  language text,
  pattern text,
  ast_query text,
  rule_config jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.custom_compliance_policies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  control_id text not null,
  severity text not null check (severity in ('critical', 'high', 'medium', 'low')),
  blocking boolean not null default false,
  remediation text,
  rule_config jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.compliance_reviews (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.validate_review_reports(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  framework text not null references public.compliance_frameworks(id),
  status text not null check (status in ('passed', 'warning', 'needs_work', 'blocked')),
  score integer not null check (score between 0 and 100),
  findings jsonb not null default '[]'::jsonb,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (review_id, framework)
);

alter table public.compliance_frameworks enable row level security;
alter table public.compliance_controls enable row level security;
alter table public.compliance_rules enable row level security;
alter table public.custom_compliance_policies enable row level security;
alter table public.compliance_reviews enable row level security;

create policy "Max users manage own custom compliance policies"
on public.custom_compliance_policies
for all
to authenticated
using (
  (select auth.uid()) = user_id
  and exists (
    select 1 from public.user_profiles
    where id = (select auth.uid()) and upper(tier) = 'MAX'
  )
)
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1 from public.user_profiles
    where id = (select auth.uid()) and upper(tier) = 'MAX'
  )
);

create policy "Users read own compliance reviews"
on public.compliance_reviews
for select
to authenticated
using ((select auth.uid()) = user_id);

create index if not exists compliance_controls_framework_idx
on public.compliance_controls(framework_id);

create index if not exists compliance_rules_control_enabled_idx
on public.compliance_rules(control_id)
where enabled;

create index if not exists custom_compliance_policies_user_enabled_idx
on public.custom_compliance_policies(user_id)
where enabled;

create index if not exists compliance_reviews_user_created_idx
on public.compliance_reviews(user_id, created_at desc);

insert into public.compliance_frameworks (id, name, version, description)
values
  ('HIPAA', 'HIPAA', '2013', 'Healthcare privacy and electronic PHI safeguards.'),
  ('SOC2', 'SOC 2', '2017 TSC', 'Trust Services Criteria for SaaS systems.'),
  ('PCI_DSS', 'PCI DSS', '4.0.1', 'Cardholder data security controls.'),
  ('GDPR', 'GDPR', '2016/679', 'European personal-data processing controls.'),
  ('ISO27001', 'ISO 27001', '2022', 'Information security management controls.'),
  ('NIST_CSF', 'NIST Cybersecurity Framework', '2.0', 'Identify, Protect, Detect, Respond, and Recover outcomes.'),
  ('NIST_800_53', 'NIST SP 800-53', 'Rev. 5', 'US government security and privacy controls.'),
  ('FEDRAMP', 'FedRAMP', 'Rev. 5', 'US government cloud authorization controls.'),
  ('CCPA_CPRA', 'CCPA / CPRA', '2023', 'California consumer privacy controls.'),
  ('SOX', 'SOX', '2002', 'Financial reporting integrity and audit controls.'),
  ('CUSTOM', 'Custom Enterprise Policies', '1', 'Max-tier organization-specific controls.')
on conflict (id) do update set
  name = excluded.name,
  version = excluded.version,
  description = excluded.description;

insert into public.compliance_controls (framework_id, control_id, name, description, severity)
values
  ('HIPAA', '164.312(a)', 'Access Control', 'Authorize access to electronic PHI.', 'critical'),
  ('HIPAA', '164.312(b)', 'Audit Controls', 'Record activity involving electronic PHI.', 'high'),
  ('HIPAA', '164.312(c)', 'Integrity Controls', 'Protect PHI from improper alteration.', 'high'),
  ('HIPAA', '164.312(e)', 'Transmission Security', 'Protect PHI in transit.', 'critical'),
  ('HIPAA', '164.502(b)', 'Minimum Necessary', 'Limit PHI disclosure to required fields.', 'high'),
  ('SOC2', 'CC6', 'Logical Access', 'Authentication, authorization, and least privilege.', 'high'),
  ('SOC2', 'CC7', 'Monitoring', 'Security event logging and monitoring.', 'high'),
  ('SOC2', 'CC8', 'Change Management', 'Test and review system changes.', 'medium'),
  ('SOC2', 'C1', 'Confidentiality', 'Protect confidential information from exposure.', 'critical'),
  ('PCI_DSS', '3.2.1', 'No CVV Storage', 'Do not retain sensitive authentication data.', 'critical'),
  ('PCI_DSS', '4.2.1', 'Secure Transmission', 'Protect cardholder data over open networks.', 'critical'),
  ('PCI_DSS', '10.2', 'Logging Protection', 'Do not expose cardholder data in logs.', 'critical'),
  ('GDPR', 'Art.5', 'Data Minimization', 'Limit personal data to what is necessary.', 'high'),
  ('GDPR', 'Art.6-7', 'Lawful Basis and Consent', 'Track lawful basis and consent for processing.', 'high'),
  ('GDPR', 'Art.17', 'Right to Erasure', 'Support deletion of personal data.', 'high'),
  ('GDPR', 'Art.20', 'Data Portability', 'Support personal-data export.', 'medium'),
  ('ISO27001', 'A.5.15', 'Access Control', 'Restrict access according to business requirements.', 'high'),
  ('ISO27001', 'A.8.24', 'Cryptography', 'Protect sensitive information with cryptography.', 'critical'),
  ('ISO27001', 'A.8.15', 'Logging', 'Produce and protect relevant event logs.', 'high'),
  ('NIST_CSF', 'PR.AA', 'Identity and Access', 'Manage identities and access.', 'high'),
  ('NIST_CSF', 'DE.CM', 'Continuous Monitoring', 'Monitor for adverse activity.', 'high'),
  ('NIST_CSF', 'RS.MA', 'Incident Management', 'Manage detected incidents.', 'medium'),
  ('NIST_CSF', 'RC.RP', 'Recovery Planning', 'Maintain restoration mechanisms.', 'medium'),
  ('NIST_800_53', 'AC-3', 'Access Enforcement', 'Enforce approved authorizations.', 'high'),
  ('NIST_800_53', 'AU-2', 'Event Logging', 'Identify and log auditable events.', 'high'),
  ('NIST_800_53', 'SC-8', 'Transmission Confidentiality', 'Protect transmitted information.', 'critical'),
  ('NIST_800_53', 'SI-10', 'Information Input Validation', 'Validate information inputs.', 'high'),
  ('FEDRAMP', 'AC-3', 'Access Enforcement', 'Enforce government-cloud access policy.', 'critical'),
  ('FEDRAMP', 'AU-2', 'Audit Events', 'Record security-relevant events.', 'high'),
  ('FEDRAMP', 'SC-8', 'Transmission Protection', 'Protect information in transit.', 'critical'),
  ('FEDRAMP', 'SI-4', 'System Monitoring', 'Monitor for attacks and indicators.', 'high'),
  ('CCPA_CPRA', '1798.100', 'Collection and Notice', 'Track collection and use of personal information.', 'high'),
  ('CCPA_CPRA', '1798.105', 'Right to Delete', 'Support deletion of consumer information.', 'high'),
  ('CCPA_CPRA', '1798.115', 'Disclosure Tracking', 'Track disclosures of personal information.', 'high'),
  ('SOX', 'ITGC-AC', 'Financial Access Control', 'Restrict access to financial systems.', 'critical'),
  ('SOX', 'ITGC-AU', 'Audit Trail', 'Maintain traceable financial activity.', 'critical'),
  ('SOX', 'ITGC-CM', 'Change Management', 'Test and approve financial-system changes.', 'high'),
  ('SOX', 'ITGC-IN', 'Data Integrity', 'Protect financial record integrity.', 'critical')
on conflict (framework_id, control_id) do update set
  name = excluded.name,
  description = excluded.description,
  severity = excluded.severity;

insert into public.compliance_rules (control_id, rule_type, rule_config)
select
  control.id,
  'dataflow',
  jsonb_build_object('engine', 'bundled', 'framework', control.framework_id, 'controlId', control.control_id)
from public.compliance_controls control
where not exists (
  select 1
  from public.compliance_rules rule
  where rule.control_id = control.id
    and rule.rule_config ->> 'engine' = 'bundled'
);
