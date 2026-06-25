-- Harden functions and policies discovered by Supabase security advisors.

-- Restrict RLS-only helper tables so no public role has direct access.
-- These tables are only accessed by the service role from Edge Functions.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'hardware_blocklist' AND policyname = 'Service role only'
  ) THEN
    CREATE POLICY "Service role only" ON public.hardware_blocklist FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'webhook_events' AND policyname = 'Service role only'
  ) THEN
    CREATE POLICY "Service role only" ON public.webhook_events FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Revoke direct execution of internal SECURITY DEFINER helpers from public/anonymous/authenticated roles.
-- Edge Functions call these via the service role key, so they remain accessible to the service role.
REVOKE EXECUTE ON FUNCTION public.record_validation(UUID, INTEGER, NUMERIC, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.validation_usage(UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.tier_validation_limit(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.decrement_user_credits(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated;

-- Pin search_path for security-definer functions to prevent search_path injection.
ALTER FUNCTION public.record_validation(UUID, INTEGER, NUMERIC, JSONB) SET search_path = '';
ALTER FUNCTION public.validation_usage(UUID) SET search_path = '';
ALTER FUNCTION public.tier_validation_limit(TEXT) SET search_path = '';
ALTER FUNCTION public.decrement_user_credits(TEXT) SET search_path = '';
ALTER FUNCTION public.handle_new_user() SET search_path = '';
