-- Applied via Supabase MCP (20260715194229).
CREATE TABLE IF NOT EXISTS public.quality_gate_logs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    gate_type       TEXT NOT NULL CHECK (gate_type IN ('pre_commit', 'pre_push')),
    branch_name     TEXT,
    report_id       TEXT,
    passed          BOOLEAN NOT NULL DEFAULT false,
    blocked_reasons TEXT[],
    warnings        TEXT[],
    overridden      BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);

ALTER TABLE public.quality_gate_logs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'quality_gate_logs'
      AND policyname = 'Users can view their own gate logs'
  ) THEN
    CREATE POLICY "Users can view their own gate logs"
    ON public.quality_gate_logs
    FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_quality_gate_logs_user
ON public.quality_gate_logs(user_id, created_at DESC);
