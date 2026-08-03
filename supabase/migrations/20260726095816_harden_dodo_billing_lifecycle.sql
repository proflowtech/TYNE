-- Keep the checked-in schema aligned with the live subscription columns and
-- make Dodo webhook processing idempotent and order-aware.
ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS subscription_start timestamptz,
  ADD COLUMN IF NOT EXISTS dodo_subscription_id text,
  ADD COLUMN IF NOT EXISTS subscription_status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS current_period_end timestamptz,
  ADD COLUMN IF NOT EXISTS cancel_at_period_end boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pending_tier text,
  ADD COLUMN IF NOT EXISTS billing_event_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS user_profiles_dodo_subscription_id_key
  ON public.user_profiles (dodo_subscription_id)
  WHERE dodo_subscription_id IS NOT NULL;

ALTER TABLE public.webhook_events
  ADD COLUMN IF NOT EXISTS webhook_id text,
  ADD COLUMN IF NOT EXISTS processed_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS webhook_events_provider_webhook_id_key
  ON public.webhook_events (provider, webhook_id)
  WHERE webhook_id IS NOT NULL;

COMMENT ON COLUMN public.user_profiles.billing_event_at IS
  'Timestamp of the latest Dodo subscription event applied to this profile.';
COMMENT ON COLUMN public.webhook_events.webhook_id IS
  'Dodo Standard Webhooks identifier used to reject duplicate deliveries.';
