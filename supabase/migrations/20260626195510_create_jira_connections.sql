CREATE TABLE IF NOT EXISTS public.jira_connections (
  user_id UUID PRIMARY KEY REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  cloud_id TEXT,
  account_email TEXT,
  account_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

ALTER TABLE public.jira_connections ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'jira_connections'
      AND policyname = 'Service role can manage Jira connections'
  ) THEN
    CREATE POLICY "Service role can manage Jira connections"
    ON public.jira_connections
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
  END IF;
END $$;

REVOKE ALL ON TABLE public.jira_connections FROM anon, authenticated;

CREATE INDEX IF NOT EXISTS idx_jira_connections_updated_at
ON public.jira_connections(updated_at);
