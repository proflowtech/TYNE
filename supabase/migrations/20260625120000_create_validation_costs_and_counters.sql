-- ============================================================================
-- validation_costs: admin-only cost tracking (NEVER exposed to users)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.validation_costs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL,
  tier            TEXT NOT NULL CHECK (tier IN ('free', 'pro', 'max')),
  model           TEXT NOT NULL,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  cost_usd        NUMERIC(10, 6) NOT NULL DEFAULT 0,
  validation_status TEXT,
  validation_id   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_validation_costs_user_tier_created
  ON public.validation_costs (user_id, tier, created_at);

CREATE INDEX IF NOT EXISTS idx_validation_costs_created
  ON public.validation_costs (created_at);

-- RLS: only service_role can read/write (admin dashboard uses service key)
ALTER TABLE public.validation_costs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role only"
  ON public.validation_costs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================================================
-- validation_counters: monthly per-user counter (read via record_validation rpc)
-- Kept for future direct counter queries; current flow uses usage_events.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.validation_counters (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL,
  tier          TEXT NOT NULL CHECK (tier IN ('free', 'pro', 'max')),
  count         INTEGER NOT NULL DEFAULT 0,
  limit_monthly INTEGER NOT NULL,
  reset_date    DATE NOT NULL DEFAULT date_trunc('month', now())::DATE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, reset_date)
);

CREATE INDEX IF NOT EXISTS idx_validation_counters_user
  ON public.validation_counters (user_id, reset_date);

ALTER TABLE public.validation_counters ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role only"
  ON public.validation_counters
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
