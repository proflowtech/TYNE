CREATE TABLE IF NOT EXISTS public.hardware_blocklist (
    machine_id TEXT PRIMARY KEY,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Enable RLS (Service role access only, no public access)
ALTER TABLE public.hardware_blocklist ENABLE ROW LEVEL SECURITY;
