-- Phase 3 privacy: direct BYOK + residency execution path metadata.

alter table public.validate_review_reports
  add column if not exists llm_execution_path text not null default 'managed',
  add column if not exists byok_direct boolean not null default false;

comment on column public.validate_review_reports.llm_execution_path is
  'managed | direct_byok | local';
comment on column public.validate_review_reports.byok_direct is
  'True when the LLM ran on-device via Direct BYOK (key never reached Tyne cloud).';

create index if not exists validate_review_reports_llm_path_idx
  on public.validate_review_reports (user_id, llm_execution_path, created_at desc);
