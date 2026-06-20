create table if not exists public.ai_usage (
  id uuid primary key default gen_random_uuid(),
  license_key text not null references public.licenses(license_key) on delete cascade,
  month text not null, -- format: '2026-07'
  call_count integer not null default 0,
  last_used_at timestamptz not null default now(),
  unique(license_key, month)
);

create index if not exists ai_usage_license_month_idx on public.ai_usage(license_key, month);

-- Atomic increment function (prevents race conditions)
create or replace function public.increment_ai_usage(p_license_key text, p_month text)
returns integer
language plpgsql
as $$
declare
  new_count integer;
begin
  insert into public.ai_usage (license_key, month, call_count, last_used_at)
  values (p_license_key, p_month, 1, now())
  on conflict (license_key, month)
  do update set
    call_count = ai_usage.call_count + 1,
    last_used_at = now()
  returning call_count into new_count;

  return new_count;
end;
$$;
