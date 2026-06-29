-- The Atlassian reporting admin OAuth "start" flow now authorizes the caller via a
-- shared internal service secret (x-internal-secret) instead of a GitHub admin
-- profile. There is therefore no admin user profile to attribute the OAuth state
-- row to, so admin_user_id must be allowed to be NULL.
--
-- The foreign key reference to public.user_profiles(id) is preserved; the column is
-- simply made optional. The callback (atlassian-report-oauth-callback) already
-- tolerates a null admin_user_id when upserting atlassian_report_credentials.
ALTER TABLE public.atlassian_report_oauth_states
  ALTER COLUMN admin_user_id DROP NOT NULL;
