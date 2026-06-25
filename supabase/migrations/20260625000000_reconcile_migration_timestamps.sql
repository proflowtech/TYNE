-- Reconcile migration timestamps between local workspace and applied database migrations.
-- The following migrations were renamed in the workspace to match the versions already applied in the database:
--   - 20260622185436_create_hardware_blocklist
--   - 20260622185956_add_credits_to_user_profiles
--   - 20260623180900_create_product_schema
-- This file is a no-op marker so fresh environments see a consistent history.
-- Verify that the objects from those migrations exist in the current database.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'hardware_blocklist') THEN
        RAISE EXCEPTION 'hardware_blocklist table is missing; migration 20260622185436 may not be applied';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'user_profiles' AND column_name = 'api_credits_remaining') THEN
        RAISE EXCEPTION 'api_credits_remaining column is missing; migration 20260622185956 may not be applied';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'threads') THEN
        RAISE EXCEPTION 'threads table is missing; migration 20260623180900 may not be applied';
    END IF;
END $$;
