CREATE TABLE IF NOT EXISTS public.atlassian_report_oauth_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  state_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE TABLE IF NOT EXISTS public.atlassian_report_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL DEFAULT 'atlassian_personal_data_reporting',
  admin_user_id uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  atlassian_account_id text,
  account_email text,
  account_name text,
  access_token text NOT NULL,
  refresh_token text NOT NULL,
  scope text,
  expires_at timestamptz NOT NULL,
  last_refreshed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  UNIQUE(provider)
);

ALTER TABLE public.atlassian_report_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.atlassian_report_credentials ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'atlassian_report_oauth_states'
      AND policyname = 'Service role can manage Atlassian report OAuth states'
  ) THEN
    CREATE POLICY "Service role can manage Atlassian report OAuth states"
    ON public.atlassian_report_oauth_states
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'atlassian_report_credentials'
      AND policyname = 'Service role can manage Atlassian report credentials'
  ) THEN
    CREATE POLICY "Service role can manage Atlassian report credentials"
    ON public.atlassian_report_credentials
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
  END IF;
END $$;

REVOKE ALL ON TABLE public.atlassian_report_oauth_states FROM anon, authenticated;
REVOKE ALL ON TABLE public.atlassian_report_credentials FROM anon, authenticated;

CREATE INDEX IF NOT EXISTS idx_atlassian_report_oauth_states_admin_user_id
ON public.atlassian_report_oauth_states(admin_user_id);

CREATE INDEX IF NOT EXISTS idx_atlassian_report_oauth_states_expires_at
ON public.atlassian_report_oauth_states(expires_at);

CREATE INDEX IF NOT EXISTS idx_atlassian_report_credentials_admin_user_id
ON public.atlassian_report_credentials(admin_user_id);

CREATE INDEX IF NOT EXISTS idx_atlassian_report_credentials_expires_at
ON public.atlassian_report_credentials(expires_at);
