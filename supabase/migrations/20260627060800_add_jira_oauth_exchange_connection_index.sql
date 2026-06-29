CREATE INDEX IF NOT EXISTS idx_jira_oauth_exchanges_connection_id
ON public.jira_oauth_exchanges(jira_connection_id)
WHERE jira_connection_id IS NOT NULL;
