-- Applied via Supabase MCP (20260831193000).
-- Suppressions rot more dangerously than house rules: a stale suppression
-- silently hides a real bug, while a stale rule merely does nothing. Staleness
-- detection therefore has to cover both halves of `.tyne/learnings.md`.
--
-- The existing columns already generalize — for a suppression, rule_text is
-- the finding title and findings_count is how many findings it hid — so this
-- adds only the discriminator. Defaulting to 'rule' keeps every row written
-- before this migration correct.
ALTER TABLE public.house_rule_events
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'rule';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'house_rule_events_kind_check'
  ) THEN
    ALTER TABLE public.house_rule_events
      ADD CONSTRAINT house_rule_events_kind_check
      CHECK (kind IN ('rule', 'suppression'));
  END IF;
END $$;

-- Staleness is always asked per kind ("which suppressions are dead?"), so the
-- discriminator leads the index.
CREATE INDEX IF NOT EXISTS idx_house_rule_events_kind_hash
ON public.house_rule_events(user_id, kind, rule_hash, created_at DESC);
