create or replace view public.admin_stats
with (security_invoker = true)
as
select
  (select count(*) from public.licenses where status = 'active') as active_licenses,
  (select count(*) from public.licenses where tier = 'solo' and status = 'active') as solo_count,
  (select count(*) from public.licenses where tier = 'team' and status = 'active') as team_count,
  (select count(*) from public.licenses where status = 'active' and tier = 'solo') * 9 +
  (select count(*) from public.licenses where status = 'active' and tier = 'team') * 29 as mrr_usd,
  (select coalesce(sum(call_count), 0) from public.ai_usage where month = to_char(now(), 'YYYY-MM')) as calls_this_month;
