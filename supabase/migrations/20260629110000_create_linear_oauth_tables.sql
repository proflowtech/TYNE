CREATE TABLE IF NOT EXISTS public.linear_oauth_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  state_hash text UNIQUE NOT NULL,
  redirect_after_success text,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.linear_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  linear_workspace_id text,
  linear_workspace_name text,
  linear_user_id text,
  linear_user_email text,
  linear_user_name text,
  access_token_encrypted text NOT NULL,
  refresh_token_encrypted text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, linear_workspace_id)
);

CREATE TABLE IF NOT EXISTS public.linear_oauth_exchanges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  exchange_code_hash text UNIQUE NOT NULL,
  linear_connection_id uuid REFERENCES public.linear_connections(id) ON DELETE CASCADE,
  available_teams jsonb NOT NULL DEFAULT '[]'::jsonb,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.linear_team_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  repository_id text NOT NULL,
  repository_name text,
  workspace_path_hash text,
  linear_workspace_id text NOT NULL,
  linear_workspace_name text,
  linear_team_id text NOT NULL,
  linear_team_key text,
  linear_team_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, repository_id, linear_workspace_id, linear_team_id)
);

CREATE TABLE IF NOT EXISTS public.linear_issue_contexts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  repository_id text,
  linear_workspace_id text,
  linear_issue_id text NOT NULL,
  linear_issue_identifier text NOT NULL,
  goal text,
  subtasks jsonb NOT NULL DEFAULT '[]'::jsonb,
  acceptance_criteria jsonb NOT NULL DEFAULT '[]'::jsonb,
  proof_point_templates jsonb NOT NULL DEFAULT '[]'::jsonb,
  validation_steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_linear_snapshot jsonb,
  model_provider text,
  model_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, repository_id, linear_issue_id)
);

ALTER TABLE public.linear_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.linear_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.linear_oauth_exchanges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.linear_team_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.linear_issue_contexts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.linear_oauth_states FROM anon, authenticated;
REVOKE ALL ON TABLE public.linear_connections FROM anon, authenticated;
REVOKE ALL ON TABLE public.linear_oauth_exchanges FROM anon, authenticated;
REVOKE ALL ON TABLE public.linear_team_mappings FROM anon, authenticated;
REVOKE ALL ON TABLE public.linear_issue_contexts FROM anon, authenticated;

CREATE INDEX IF NOT EXISTS idx_linear_oauth_states_user_id ON public.linear_oauth_states(user_id);
CREATE INDEX IF NOT EXISTS idx_linear_oauth_states_expires_at ON public.linear_oauth_states(expires_at);
CREATE INDEX IF NOT EXISTS idx_linear_connections_user_id ON public.linear_connections(user_id);
CREATE INDEX IF NOT EXISTS idx_linear_connections_workspace_id ON public.linear_connections(linear_workspace_id);
CREATE INDEX IF NOT EXISTS idx_linear_oauth_exchanges_user_id ON public.linear_oauth_exchanges(user_id);
CREATE INDEX IF NOT EXISTS idx_linear_oauth_exchanges_connection_id ON public.linear_oauth_exchanges(linear_connection_id);
CREATE INDEX IF NOT EXISTS idx_linear_team_mappings_user_id ON public.linear_team_mappings(user_id);
CREATE INDEX IF NOT EXISTS idx_linear_team_mappings_workspace_id ON public.linear_team_mappings(linear_workspace_id);
CREATE INDEX IF NOT EXISTS idx_linear_issue_contexts_user_id ON public.linear_issue_contexts(user_id);
CREATE INDEX IF NOT EXISTS idx_linear_issue_contexts_workspace_id ON public.linear_issue_contexts(linear_workspace_id);
