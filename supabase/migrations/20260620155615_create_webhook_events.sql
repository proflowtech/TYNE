create table if not exists public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'dodo',
  event_type text not null,
  payload jsonb not null,
  processed boolean default false,
  error text,
  created_at timestamptz not null default now()
);
