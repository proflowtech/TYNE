-- Finding feedback (false positive suppression) + quality gate logs.

-- ════════════════════════════════════════════════════════════════════════════
-- 1. finding_feedback — stores per-finding verdicts for learning
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.finding_feedback (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    report_id       TEXT NOT NULL,
    finding_id      TEXT NOT NULL,
    verdict         TEXT NOT NULL CHECK (verdict IN ('accepted', 'dismissed', 'not_relevant', 'wrong')),
    finding_title   TEXT NOT NULL DEFAULT '',
    finding_file    TEXT,
    finding_category TEXT,
    finding_severity TEXT,
    comment         TEXT,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);

ALTER TABLE public.finding_feedback ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'finding_feedback'
      AND policyname = 'Users can manage their own feedback'
  ) THEN
    CREATE POLICY "Users can manage their own feedback"
    ON public.finding_feedback
    FOR ALL
    TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_finding_feedback_user_finding
ON public.finding_feedback(user_id, finding_title);
CREATE INDEX IF NOT EXISTS idx_finding_feedback_user_file
ON public.finding_feedback(user_id, finding_file);
CREATE INDEX IF NOT EXISTS idx_finding_feedback_report
ON public.finding_feedback(report_id);

-- ════════════════════════════════════════════════════════════════════════════
-- 2. quality_gate_logs — stores gate evaluations before commit/push
-- ════════════════════════════════════════════════════════════════════════════

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
