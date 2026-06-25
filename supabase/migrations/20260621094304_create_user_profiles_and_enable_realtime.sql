CREATE TABLE IF NOT EXISTS public.user_profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    github_id TEXT UNIQUE NOT NULL,
    github_username TEXT,
    email TEXT,
    avatar_url TEXT,
    tier TEXT DEFAULT 'CORE' NOT NULL,
    dodo_customer_id TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    CONSTRAINT check_tier CHECK (tier IN ('CORE', 'PRO', 'MAX'))
);

ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own profile" 
ON public.user_profiles 
FOR SELECT 
USING (auth.uid() = id);

ALTER TABLE public.user_profiles REPLICA IDENTITY FULL;

ALTER PUBLICATION supabase_realtime ADD TABLE public.user_profiles;

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
