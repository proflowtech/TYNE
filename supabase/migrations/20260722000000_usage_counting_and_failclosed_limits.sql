-- ════════════════════════════════════════════════════════════════════════════
-- Usage counting correctness + fail-closed tier limits
--
-- 1. validation_usage() now reads the SAME event bucket that Validate & Review and
--    managed deep-review actually enforce and increment ('combined_validate_review').
--    Previously it read event_type='validation', which was only written by an
--    advisory, client-controlled "record" call — so the usage panel undercounted
--    managed consumption and the counter could be left at 0. Reads and enforcement
--    now agree on one managed quota.
--
-- 2. tier_validation_limit() is now FAIL-CLOSED: only an explicit MAX tier maps to
--    NULL (unlimited managed validations). Every other value — including any
--    unexpected/empty tier that somehow bypasses the user_profiles CHECK constraint
--    — maps to the restrictive CORE limit instead of silently granting unlimited use.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.validation_usage(uid UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  cnt INTEGER;
BEGIN
  SELECT COALESCE(count, 0) INTO cnt
  FROM public.usage_counters
  WHERE user_id = uid
    AND event_type = 'combined_validate_review'
    AND month = date_trunc('month', now())::date;
  RETURN cnt;
END;
$$;

CREATE OR REPLACE FUNCTION public.tier_validation_limit(t TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- MAX is the only tier granted unlimited managed validations.
  IF t ILIKE 'MAX' THEN
    RETURN NULL;
  END IF;
  IF t ILIKE 'PRO' THEN
    RETURN 50;
  END IF;
  -- CORE / free and anything unexpected -> restrictive default (fail closed).
  RETURN 5;
END;
$$;

-- Preserve the service-role-only posture (CREATE OR REPLACE keeps existing grants,
-- but we re-assert them defensively).
REVOKE EXECUTE ON FUNCTION public.validation_usage(UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.tier_validation_limit(TEXT) FROM PUBLIC, anon, authenticated;
