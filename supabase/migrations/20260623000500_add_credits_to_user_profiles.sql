ALTER TABLE public.user_profiles 
ADD COLUMN IF NOT EXISTS api_credits_remaining INTEGER DEFAULT 0;

-- Atomic credit decrement function
CREATE OR REPLACE FUNCTION public.decrement_user_credits(p_github_id TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  new_credits INTEGER;
BEGIN
  UPDATE public.user_profiles
  SET api_credits_remaining = LEAST(100, GREATEST(0, api_credits_remaining - 1)),
      updated_at = timezone('utc'::text, now())
  WHERE github_id = p_github_id
  RETURNING api_credits_remaining INTO new_credits;

  RETURN new_credits;
END;
$$;
