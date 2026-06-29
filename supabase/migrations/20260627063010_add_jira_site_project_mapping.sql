ALTER TABLE public.jira_connections
  ADD COLUMN IF NOT EXISTS site_name text,
  ADD COLUMN IF NOT EXISTS site_url text,
  ALTER COLUMN cloud_id DROP NOT NULL;

ALTER TABLE public.jira_oauth_exchanges
  ADD COLUMN IF NOT EXISTS available_sites jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS public.jira_project_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  repository_id text NOT NULL,
  repository_name text,
  workspace_path_hash text,
  cloud_id text NOT NULL,
  site_name text,
  site_url text,
  project_id text NOT NULL,
  project_key text NOT NULL,
  project_name text NOT NULL,
  project_avatar_url text,
  is_default boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  UNIQUE(user_id, repository_id, cloud_id, project_id)
);

ALTER TABLE public.jira_project_mappings ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'jira_project_mappings'
      AND policyname = 'Service role can manage Jira project mappings'
  ) THEN
    CREATE POLICY "Service role can manage Jira project mappings"
    ON public.jira_project_mappings
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
  END IF;
END $$;

REVOKE ALL ON TABLE public.jira_project_mappings FROM anon, authenticated;

CREATE INDEX IF NOT EXISTS idx_jira_project_mappings_user_id
ON public.jira_project_mappings(user_id);

CREATE INDEX IF NOT EXISTS idx_jira_project_mappings_cloud_id
ON public.jira_project_mappings(cloud_id);

CREATE INDEX IF NOT EXISTS idx_jira_project_mappings_project_key
ON public.jira_project_mappings(project_key);

CREATE INDEX IF NOT EXISTS idx_jira_project_mappings_repository_id
ON public.jira_project_mappings(repository_id);
