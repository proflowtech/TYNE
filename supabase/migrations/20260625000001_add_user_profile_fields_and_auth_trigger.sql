-- Add missing identity columns and the auth trigger for existing databases.

ALTER TABLE public.user_profiles
ADD COLUMN IF NOT EXISTS github_username TEXT,
ADD COLUMN IF NOT EXISTS email TEXT,
ADD COLUMN IF NOT EXISTS avatar_url TEXT;

-- Update existing profiles with identity data from auth.users.
UPDATE public.user_profiles up
SET
    github_username = COALESCE(up.github_username, au.raw_user_meta_data->>'user_name'),
    email = COALESCE(up.email, au.raw_user_meta_data->>'email'),
    avatar_url = COALESCE(up.avatar_url, au.raw_user_meta_data->>'avatar_url')
FROM auth.users au
WHERE up.id = au.id;

-- Create a profile for every new GitHub-authenticated user.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.user_profiles (
        id,
        github_id,
        github_username,
        email,
        avatar_url,
        tier
    ) VALUES (
        new.id,
        new.raw_user_meta_data->>'sub',
        new.raw_user_meta_data->>'user_name',
        new.raw_user_meta_data->>'email',
        new.raw_user_meta_data->>'avatar_url',
        'CORE'
    )
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
