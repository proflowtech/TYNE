-- All tables: no public access. Service role key only.
alter table public.licenses enable row level security;
alter table public.ai_usage enable row level security;
alter table public.webhook_events enable row level security;

-- Service role bypasses RLS automatically. No additional policies needed.
-- Anon key: zero access (no policies = no access)
