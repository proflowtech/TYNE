-- Contact fields for beta bug follow-up communication.
alter table public.beta_bug_reports
  add column if not exists user_email text,
  add column if not exists github_username text,
  add column if not exists github_id text;

comment on column public.beta_bug_reports.user_email is 'Contact email for beta follow-up with the reporter.';
comment on column public.beta_bug_reports.github_username is 'GitHub username of the reporter at submit time.';
comment on column public.beta_bug_reports.github_id is 'GitHub id of the reporter at submit time.';

create index if not exists beta_bug_reports_email_idx
  on public.beta_bug_reports (user_email, created_at desc)
  where user_email is not null;
