create table if not exists public.licenses (
  id uuid primary key default gen_random_uuid(),
  license_key text unique not null default gen_random_uuid()::text,
  user_email text not null,
  tier text not null check (tier in ('solo', 'team')),
  status text not null default 'active' check (status in ('active', 'cancelled', 'expired', 'trial')),
  dodo_subscription_id text unique,
  dodo_customer_id text,
  calls_limit integer not null default 200,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  cancelled_at timestamptz,
  trial_ends_at timestamptz
);

create index if not exists licenses_license_key_idx on public.licenses(license_key);
create index if not exists licenses_user_email_idx on public.licenses(user_email);
create index if not exists licenses_status_idx on public.licenses(status);

-- Tier limits reference
-- solo: $9/month, 200 AI calls/month
-- team: $29/month, 500 AI calls/month
