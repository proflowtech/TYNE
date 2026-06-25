-- Deprecate legacy billing tables that are no longer used by the Tyne extension.
-- The extension now uses user_profiles.tier and user_profiles.api_credits_remaining.

DROP VIEW IF EXISTS public.admin_stats;
DROP FUNCTION IF EXISTS public.increment_ai_usage(text, text);
DROP TABLE IF EXISTS public.ai_usage;
DROP TABLE IF EXISTS public.licenses;
