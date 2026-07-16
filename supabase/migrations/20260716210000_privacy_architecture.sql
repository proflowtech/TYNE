-- Phase 1 privacy architecture: mode + residency + evidence flags on validate_review_reports.

alter table public.validate_review_reports
  add column if not exists privacy_mode text not null default 'cloud',
  add column if not exists evidence_redacted boolean not null default false,
  add column if not exists data_residency text not null default 'us',
  add column if not exists source_processing_type text not null default 'cloud';

create index if not exists validate_review_reports_privacy_mode_idx
  on public.validate_review_reports (user_id, privacy_mode, created_at desc);

comment on column public.validate_review_reports.privacy_mode is
  'cloud | privacy_enhanced | local_compliance';
comment on column public.validate_review_reports.source_processing_type is
  'cloud | sanitized_cloud | local';
