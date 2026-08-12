-- finding_feedback.repository_id is written/filtered by tyne-validate-review.
ALTER TABLE public.finding_feedback
  ADD COLUMN IF NOT EXISTS repository_id text;

CREATE INDEX IF NOT EXISTS finding_feedback_repo_idx
  ON public.finding_feedback (repository_id)
  WHERE repository_id IS NOT NULL;
