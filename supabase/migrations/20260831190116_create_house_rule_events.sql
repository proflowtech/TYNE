-- Telemetry for team house rules from `.tyne/learnings.md`.
--
-- The rules themselves deliberately stay in the repo file: that is what makes
-- them reviewable in a PR, attributable via git blame, and inherited by every
-- clone. This table records only *usage* — which rules were evaluated and
-- whether they produced findings — so a rule that has been checked many times
-- and never fired can be surfaced as stale and deleted.
--
-- Identity is the hash of the rule's normalized text, NOT the HR<n> id: those
-- ids are assigned per parse and shift whenever the file is edited, so they
-- cannot key a row that must survive across reviews.
CREATE TABLE IF NOT EXISTS public.house_rule_events (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    repository_id    TEXT,
    rule_hash        TEXT NOT NULL,
    -- Kept for display so a stale-rule prompt can quote the rule verbatim
    -- without the client having to re-read the file.
    rule_text        TEXT NOT NULL,
    rule_scope       TEXT,
    -- 0 means the rule was sent to the model and produced nothing. That is the
    -- signal staleness detection is built on, so these rows are recorded too.
    findings_count   INTEGER NOT NULL DEFAULT 0,
    report_id        TEXT,
    created_at       TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);

ALTER TABLE public.house_rule_events ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'house_rule_events'
      AND policyname = 'Users can view their own house rule events'
  ) THEN
    CREATE POLICY "Users can view their own house rule events"
    ON public.house_rule_events
    FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);
  END IF;
END $$;

-- Staleness query shape: rules for one user/repo, newest first.
CREATE INDEX IF NOT EXISTS idx_house_rule_events_user_rule
ON public.house_rule_events(user_id, rule_hash, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_house_rule_events_repo
ON public.house_rule_events(repository_id, created_at DESC)
WHERE repository_id IS NOT NULL;
