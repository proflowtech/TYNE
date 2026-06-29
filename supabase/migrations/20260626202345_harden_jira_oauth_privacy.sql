-- Harden Jira OAuth for Atlassian public distribution.
-- This migration is intentionally additive/idempotent and refuses to coerce
-- unsafe user_id values instead of destroying production data.

DO $$
DECLARE
  invalid_user_ids integer;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'jira_connections'
      AND column_name = 'user_id'
      AND udt_name <> 'uuid'
  ) THEN
    SELECT count(*)
    INTO invalid_user_ids
    FROM public.jira_connections
    WHERE user_id IS NOT NULL
      AND user_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

    IF invalid_user_ids > 0 THEN
      RAISE EXCEPTION 'Cannot migrate jira_connections.user_id to uuid: % non-UUID values found', invalid_user_ids;
    END IF;

    ALTER TABLE public.jira_connections
      ALTER COLUMN user_id TYPE uuid USING user_id::uuid;
  END IF;
END $$;

ALTER TABLE public.jira_connections
  ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS atlassian_account_id text,
  ADD COLUMN IF NOT EXISTS atlassian_personal_data_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS personal_data_last_reported_at timestamptz,
  ADD COLUMN IF NOT EXISTS personal_data_next_report_at timestamptz,
  ADD COLUMN IF NOT EXISTS personal_data_reporting_status text,
  ADD COLUMN IF NOT EXISTS personal_data_erased_at timestamptz,
  ADD COLUMN IF NOT EXISTS personal_data_report_error text;

UPDATE public.jira_connections
SET id = gen_random_uuid()
WHERE id IS NULL;

ALTER TABLE public.jira_connections
  ALTER COLUMN id SET NOT NULL,
  ALTER COLUMN id SET DEFAULT gen_random_uuid(),
  ALTER COLUMN created_at SET DEFAULT timezone('utc'::text, now()),
  ALTER COLUMN updated_at SET DEFAULT timezone('utc'::text, now());

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'jira_connections_id_key'
      AND conrelid = 'public.jira_connections'::regclass
  ) THEN
    ALTER TABLE public.jira_connections
      ADD CONSTRAINT jira_connections_id_key UNIQUE (id);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'jira_connections_user_id_fkey'
      AND conrelid = 'public.jira_connections'::regclass
  ) THEN
    ALTER TABLE public.jira_connections
      ADD CONSTRAINT jira_connections_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES public.user_profiles(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_jira_connections_user_id
ON public.jira_connections(user_id);

CREATE INDEX IF NOT EXISTS idx_jira_connections_cloud_id
ON public.jira_connections(cloud_id);

CREATE INDEX IF NOT EXISTS idx_jira_connections_atlassian_account_id
ON public.jira_connections(atlassian_account_id)
WHERE atlassian_account_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.jira_oauth_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  state_hash text NOT NULL UNIQUE,
  redirect_after_success text,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE TABLE IF NOT EXISTS public.jira_oauth_exchanges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  exchange_code_hash text NOT NULL UNIQUE,
  jira_connection_id uuid REFERENCES public.jira_connections(id) ON DELETE CASCADE,
  state_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now())
);

ALTER TABLE public.jira_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jira_oauth_exchanges ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'jira_oauth_states'
      AND policyname = 'Service role can manage Jira OAuth states'
  ) THEN
    CREATE POLICY "Service role can manage Jira OAuth states"
    ON public.jira_oauth_states
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'jira_oauth_exchanges'
      AND policyname = 'Service role can manage Jira OAuth exchanges'
  ) THEN
    CREATE POLICY "Service role can manage Jira OAuth exchanges"
    ON public.jira_oauth_exchanges
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
  END IF;
END $$;

REVOKE ALL ON TABLE public.jira_connections FROM anon, authenticated;
REVOKE ALL ON TABLE public.jira_oauth_states FROM anon, authenticated;
REVOKE ALL ON TABLE public.jira_oauth_exchanges FROM anon, authenticated;

CREATE INDEX IF NOT EXISTS idx_jira_oauth_states_user_id
ON public.jira_oauth_states(user_id);

CREATE INDEX IF NOT EXISTS idx_jira_oauth_states_expires_at
ON public.jira_oauth_states(expires_at);

CREATE INDEX IF NOT EXISTS idx_jira_oauth_exchanges_user_id
ON public.jira_oauth_exchanges(user_id);

CREATE INDEX IF NOT EXISTS idx_jira_oauth_exchanges_expires_at
ON public.jira_oauth_exchanges(expires_at);
