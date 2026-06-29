CREATE TABLE IF NOT EXISTS public.tyne_pm_task_contexts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  jira_cloud_id text NOT NULL,
  jira_issue_key text NOT NULL,
  repository_id text,
  goal text,
  subtasks jsonb NOT NULL DEFAULT '[]'::jsonb,
  acceptance_criteria jsonb NOT NULL DEFAULT '[]'::jsonb,
  proof_point_templates jsonb NOT NULL DEFAULT '[]'::jsonb,
  validation_steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_jira_snapshot jsonb,
  model_provider text,
  model_name text,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  UNIQUE(user_id, jira_cloud_id, jira_issue_key, repository_id)
);

ALTER TABLE public.tyne_pm_task_contexts ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'tyne_pm_task_contexts'
      AND policyname = 'Service role can manage PM task contexts'
  ) THEN
    CREATE POLICY "Service role can manage PM task contexts"
    ON public.tyne_pm_task_contexts
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
  END IF;
END $$;

REVOKE ALL ON TABLE public.tyne_pm_task_contexts FROM anon, authenticated;

CREATE INDEX IF NOT EXISTS idx_tyne_pm_task_contexts_user_id
ON public.tyne_pm_task_contexts(user_id);

CREATE INDEX IF NOT EXISTS idx_tyne_pm_task_contexts_jira_cloud_id
ON public.tyne_pm_task_contexts(jira_cloud_id);

CREATE INDEX IF NOT EXISTS idx_tyne_pm_task_contexts_jira_issue_key
ON public.tyne_pm_task_contexts(jira_issue_key);

CREATE INDEX IF NOT EXISTS idx_tyne_pm_task_contexts_repository_id
ON public.tyne_pm_task_contexts(repository_id);
