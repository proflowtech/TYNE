-- Audit-driven hardening: token encryption, atomic metering, tier fixes.
--
-- 1. Encrypted OAuth token columns for jira_connections and linear_connections.
-- 2. usage_counters table for atomic per-user-per-event-per-month counting.
-- 3. record_usage_atomic function using advisory locks (fixes race condition).
-- 4. Extended event_type CHECK to include 'code_review' and 'pm_intelligence'.
-- 5. Fix MAX users starting with zero api_credits_remaining.
-- 6. Normalized tier mapping function.

-- ════════════════════════════════════════════════════════════════════════════
-- 1. Encrypted OAuth token columns
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.jira_connections
  ADD COLUMN IF NOT EXISTS access_token_enc TEXT,
  ADD COLUMN IF NOT EXISTS refresh_token_enc TEXT;

ALTER TABLE public.linear_connections
  ADD COLUMN IF NOT EXISTS refresh_token_enc TEXT;

-- Mark old plaintext columns as deprecated (kept for backward-compat during migration).
COMMENT ON COLUMN public.jira_connections.access_token IS 'DEPRECATED: use access_token_enc (AES-GCM encrypted)';
COMMENT ON COLUMN public.jira_connections.refresh_token IS 'DEPRECATED: use refresh_token_enc (AES-GCM encrypted)';
COMMENT ON COLUMN public.linear_connections.access_token_encrypted IS 'Now stores AES-GCM encrypted tokens (was plaintext pre-hardening)';

-- ════════════════════════════════════════════════════════════════════════════
-- 2. usage_counters table for atomic counting
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.usage_counters (
  user_id   UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  month     DATE NOT NULL DEFAULT date_trunc('month', now())::date,
  count     INTEGER NOT NULL DEFAULT 0,
  tokens    BIGINT NOT NULL DEFAULT 0,
  cost_usd  NUMERIC NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, event_type, month)
);

ALTER TABLE public.usage_counters ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'usage_counters'
      AND policyname = 'Service role only counters'
  ) THEN
    CREATE POLICY "Service role only counters"
    ON public.usage_counters
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 3. Extend event_type CHECK on usage_events
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.usage_events DROP CONSTRAINT IF EXISTS usage_events_event_type_check;
ALTER TABLE public.usage_events ADD CONSTRAINT usage_events_event_type_check
  CHECK (event_type IN ('validation', 'commit', 'run', 'code_review', 'pm_intelligence', 'byok_validation', 'byok_code_review'));

-- ════════════════════════════════════════════════════════════════════════════
-- 4. Normalized tier mapping function
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.normalize_tier(raw_tier TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF raw_tier IS NULL THEN RETURN 'free'; END IF;
  IF raw_tier ILIKE 'MAX' THEN RETURN 'max'; END IF;
  IF raw_tier ILIKE 'PRO' THEN RETURN 'pro'; END IF;
  RETURN 'free';
END;
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- 5. Atomic record_usage function (fixes race condition)
-- ════════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.record_validation(UUID, INTEGER, NUMERIC, JSONB);
DROP FUNCTION IF EXISTS public.record_validation(UUID, INTEGER, NUMERIC);
DROP FUNCTION IF EXISTS public.record_validation(UUID);

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
  current_cnt  INTEGER;
  allowed      BOOLEAN;
  remaining_v  INTEGER;
  user_tier    TEXT;
BEGIN
  -- Acquire advisory lock to serialize per-user-per-event increments.
  -- This prevents the race where two concurrent transactions both read
  -- count=4, both pass the limit check, and both insert (exceeding the cap).
  PERFORM pg_advisory_xact_lock(hashtext(uid::text || ':' || p_event));

  -- Read current monthly count from the counters table.
  SELECT COALESCE(count, 0) INTO current_cnt
  FROM public.usage_counters
  WHERE user_id = uid AND event_type = p_event AND month = date_trunc('month', now())::date;

  -- Get the user's tier and limit.
  SELECT tier INTO user_tier FROM public.user_profiles WHERE id = uid;
  limit_val := public.tier_validation_limit(COALESCE(user_tier, 'CORE'));

  -- Determine whether this increment is allowed.
  allowed := limit_val IS NULL OR current_cnt < limit_val;

  IF allowed THEN
    -- Atomically upsert the counter.
    INSERT INTO public.usage_counters (user_id, event_type, month, count, tokens, cost_usd)
    VALUES (uid, p_event, date_trunc('month', now())::date, 1, p_tokens, p_cost)
    ON CONFLICT (user_id, event_type, month)
    DO UPDATE SET
      count    = public.usage_counters.count + 1,
      tokens   = public.usage_counters.tokens + EXCLUDED.tokens,
      cost_usd = public.usage_counters.cost_usd + EXCLUDED.cost_usd;

    -- Record the detail event.
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

-- Backward-compat wrapper: record_validation delegates to record_usage_atomic.
CREATE OR REPLACE FUNCTION public.record_validation(
  uid        UUID,
  p_tokens   INTEGER DEFAULT 0,
  p_cost     NUMERIC DEFAULT 0,
  p_metadata JSONB   DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN public.record_usage_atomic(uid, 'validation', p_tokens, p_cost, p_metadata);
END;
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- 6. Update validation_usage to read from counters (faster than COUNT on events)
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
    AND event_type = 'validation'
    AND month = date_trunc('month', now())::date;
  RETURN cnt;
END;
$$;

-- Generic usage counter for any event type.
CREATE OR REPLACE FUNCTION public.usage_count(uid UUID, evt TEXT)
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
    AND event_type = evt
    AND month = date_trunc('month', now())::date;
  RETURN cnt;
END;
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- 7. Fix MAX users starting with zero api_credits_remaining
-- ════════════════════════════════════════════════════════════════════════════

-- Grant 100 credits to existing MAX users who have 0.
UPDATE public.user_profiles
SET api_credits_remaining = 100
WHERE tier = 'MAX'
  AND (api_credits_remaining IS NULL OR api_credits_remaining = 0);

-- Set a default of 100 for new MAX users via a trigger.
CREATE OR REPLACE FUNCTION public.grant_max_credits_on_signup()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.tier = 'MAX' AND (NEW.api_credits_remaining IS NULL OR NEW.api_credits_remaining = 0) THEN
    NEW.api_credits_remaining := 100;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_grant_max_credits ON public.user_profiles;
CREATE TRIGGER trg_grant_max_credits
  BEFORE INSERT OR UPDATE OF tier ON public.user_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.grant_max_credits_on_signup();

-- ════════════════════════════════════════════════════════════════════════════
-- 8. Revoke EXECUTE on new functions from public/anon/authenticated
-- ════════════════════════════════════════════════════════════════════════════

REVOKE EXECUTE ON FUNCTION public.record_usage_atomic(UUID, TEXT, INTEGER, NUMERIC, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.record_validation(UUID, INTEGER, NUMERIC, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.usage_count(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.normalize_tier(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.grant_max_credits_on_signup() FROM PUBLIC, anon, authenticated;
