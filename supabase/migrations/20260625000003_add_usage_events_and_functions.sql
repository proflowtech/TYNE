-- Create usage_events table if missing and add validation usage helpers.

CREATE TABLE IF NOT EXISTS public.usage_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL CHECK (event_type IN ('validation', 'commit', 'run')),
    tokens INTEGER DEFAULT 0,
    cost_usd NUMERIC DEFAULT 0,
    metadata JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);

ALTER TABLE public.usage_events ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'usage_events'
      AND policyname = 'Users can view their own usage events'
  ) THEN
    CREATE POLICY "Users can view their own usage events"
    ON public.usage_events
    FOR SELECT
    USING (auth.uid() = user_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_usage_events_user_created
ON public.usage_events(user_id, event_type, created_at);

-- Drop legacy signatures before replacing so CREATE OR REPLACE succeeds.
DROP FUNCTION IF EXISTS public.record_validation(UUID, INTEGER, NUMERIC, JSONB);
DROP FUNCTION IF EXISTS public.record_validation(UUID, INTEGER, NUMERIC);
DROP FUNCTION IF EXISTS public.record_validation(UUID);

CREATE OR REPLACE FUNCTION public.validation_usage(uid UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  count INTEGER;
BEGIN
  SELECT COUNT(*) INTO count
  FROM public.usage_events
  WHERE user_id = uid
    AND event_type = 'validation'
    AND created_at >= date_trunc('month', now());
  RETURN count;
END;
$$;

CREATE OR REPLACE FUNCTION public.tier_validation_limit(t TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF t ILIKE 'CORE' OR t ILIKE 'free' THEN
    RETURN 5;
  END IF;
  IF t ILIKE 'PRO' THEN
    RETURN 50;
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_validation(
  uid UUID,
  p_tokens INTEGER,
  p_cost NUMERIC,
  p_metadata JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  used INTEGER;
  limit_val INTEGER;
  allowed BOOLEAN;
  new_remaining INTEGER;
BEGIN
  used := public.validation_usage(uid);
  limit_val := public.tier_validation_limit((SELECT tier FROM public.user_profiles WHERE id = uid));

  allowed := limit_val IS NULL OR used < limit_val;

  IF allowed THEN
    INSERT INTO public.usage_events (user_id, event_type, tokens, cost_usd, metadata)
    VALUES (uid, 'validation', p_tokens, p_cost, p_metadata);
  END IF;

  IF limit_val IS NULL THEN
    new_remaining := NULL;
  ELSE
    new_remaining := GREATEST(0, limit_val - used - 1);
  END IF;

  RETURN jsonb_build_object(
    'allowed', allowed,
    'used', used + CASE WHEN allowed THEN 1 ELSE 0 END,
    'limit', limit_val,
    'remaining', new_remaining
  );
END;
$$;
