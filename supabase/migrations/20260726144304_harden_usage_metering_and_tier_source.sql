-- Harden usage metering:
-- 1. First-month row must initialize current_cnt to 0 (not NULL).
-- 2. Allow the event names managed features actually write.
-- 3. Make validation_usage() read the same bucket as enforcement.
-- 4. Fail-closed tier limits (only MAX is unlimited).

ALTER TABLE public.usage_events DROP CONSTRAINT IF EXISTS usage_events_event_type_check;
ALTER TABLE public.usage_events ADD CONSTRAINT usage_events_event_type_check
  CHECK (event_type IN (
    'validation',
    'commit',
    'run',
    'code_review',
    'pm_intelligence',
    'byok_validation',
    'byok_code_review',
    'combined_validate_review',
    'story_decomposition'
  ));

CREATE OR REPLACE FUNCTION public.record_usage_atomic(
  uid        UUID,
  p_event    TEXT,
  p_tokens   INTEGER DEFAULT 0,
  p_cost     NUMERIC DEFAULT 0,
  p_metadata JSONB   DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  limit_val    INTEGER;
  current_cnt  INTEGER := 0;
  allowed      BOOLEAN;
  remaining_v  INTEGER;
  user_tier    TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(uid::text || ':' || p_event));

  -- No matching row => NULL INTO; coalesce so first use is allowed=true, not NULL.
  SELECT count INTO current_cnt
  FROM public.usage_counters
  WHERE user_id = uid
    AND event_type = p_event
    AND month = date_trunc('month', now())::date;
  current_cnt := COALESCE(current_cnt, 0);

  SELECT tier INTO user_tier FROM public.user_profiles WHERE id = uid;
  limit_val := public.tier_validation_limit(COALESCE(user_tier, 'CORE'));

  allowed := limit_val IS NULL OR current_cnt < limit_val;

  IF allowed THEN
    INSERT INTO public.usage_counters (user_id, event_type, month, count, tokens, cost_usd)
    VALUES (uid, p_event, date_trunc('month', now())::date, 1, p_tokens, p_cost)
    ON CONFLICT (user_id, event_type, month)
    DO UPDATE SET
      count    = public.usage_counters.count + 1,
      tokens   = public.usage_counters.tokens + EXCLUDED.tokens,
      cost_usd = public.usage_counters.cost_usd + EXCLUDED.cost_usd;

    INSERT INTO public.usage_events (user_id, event_type, tokens, cost_usd, metadata)
    VALUES (uid, p_event, p_tokens, p_cost, p_metadata);

    current_cnt := current_cnt + 1;
  END IF;

  remaining_v := CASE WHEN limit_val IS NULL THEN NULL ELSE GREATEST(0, limit_val - current_cnt) END;

  RETURN jsonb_build_object(
    'allowed',   allowed,
    'used',      current_cnt,
    'limit',     limit_val,
    'remaining', remaining_v
  );
END;
$$;

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
  RETURN COALESCE(cnt, 0);
END;
$$;

-- Keep the legacy wrapper pointed at the same bucket as enforcement.
CREATE OR REPLACE FUNCTION public.record_validation(
  uid UUID,
  p_tokens INTEGER DEFAULT 0,
  p_cost NUMERIC DEFAULT 0,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN public.record_usage_atomic(uid, 'combined_validate_review', p_tokens, p_cost, p_metadata);
END;
$$;

CREATE OR REPLACE FUNCTION public.tier_validation_limit(t TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF t ILIKE 'MAX' THEN
    RETURN NULL;
  END IF;
  IF t ILIKE 'PRO' THEN
    RETURN 50;
  END IF;
  RETURN 5;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_usage_atomic(UUID, TEXT, INTEGER, NUMERIC, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.validation_usage(UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.tier_validation_limit(TEXT) FROM PUBLIC, anon, authenticated;
