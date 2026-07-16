alter table public.validate_review_reports
add column if not exists section_scores jsonb not null default '[]'::jsonb,
add column if not exists architecture_flow jsonb not null default '{}'::jsonb;
