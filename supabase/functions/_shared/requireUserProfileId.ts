import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

type ProfileIdResult = { id: string } | { error: string; status: number }

/**
 * Resolve the calling user_profiles.id from Authorization:
 * - Supabase session JWT (device auth) → profile.id = auth.users.id
 * - GitHub PAT (legacy) → profile via github_id
 */
export async function requireUserProfileId(
  supabase: SupabaseClient,
  authHeader: string,
  machineId: string | null,
): Promise<ProfileIdResult> {
  const token = authHeader.replace(/^bearer\s+/i, '').trim()
  if (!token) {
    return { error: 'Missing Authorization header', status: 401 }
  }

  if (machineId) {
    const { data: blocked } = await supabase
      .from('hardware_blocklist')
      .select('machine_id')
      .eq('machine_id', machineId)
      .maybeSingle()
    if (blocked) {
      return { error: 'Hardware ID is blocked', status: 403 }
    }
  }

  if (token.split('.').length === 3) {
    const { data: authData, error: authError } = await supabase.auth.getUser(token)
    if (!authError && authData.user?.id) {
      const { data: profile, error } = await supabase
        .from('user_profiles')
        .select('id')
        .eq('id', authData.user.id)
        .maybeSingle()
      if (error) {
        return { error: 'Profile lookup failed', status: 500 }
      }
      if (profile?.id) {
        return { id: profile.id }
      }
    }
  }

  const ghUserRes = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'User-Agent': 'Tyne-Backend',
    },
  })
  if (!ghUserRes.ok) {
    return { error: 'Invalid auth token', status: 401 }
  }

  const ghUser = await ghUserRes.json() as { id?: number | string }
  const githubId = String(ghUser.id ?? '')
  if (!githubId) {
    return { error: 'Invalid auth token', status: 401 }
  }

  const { data: profile, error } = await supabase
    .from('user_profiles')
    .select('id')
    .eq('github_id', githubId)
    .maybeSingle()
  if (error) {
    return { error: 'Profile lookup failed', status: 500 }
  }
  if (!profile?.id) {
    return { error: 'User profile not found', status: 404 }
  }
  return { id: profile.id }
}
