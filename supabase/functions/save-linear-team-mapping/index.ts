import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-machine-id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') { return new Response('ok', { headers: corsHeaders }) }
  if (req.method !== 'POST') { return jsonResponse({ error: 'Method not allowed' }, 405) }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) { return jsonResponse({ error: 'Missing Authorization header' }, 401) }
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceRoleKey) { return jsonResponse({ error: 'Missing Supabase function environment' }, 500) }

  const githubToken = authHeader.replace(/^bearer\s+/i, '').trim()
  const supabase = createClient(supabaseUrl, serviceRoleKey)
  const ghUserRes = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${githubToken}`, Accept: 'application/json', 'User-Agent': 'Tyne-Backend' },
  })
  if (!ghUserRes.ok) { return jsonResponse({ error: 'Invalid GitHub token' }, 401) }
  const ghUser = await ghUserRes.json()
  const { data: profile } = await supabase.from('user_profiles').select('id').eq('github_id', String(ghUser.id)).maybeSingle()
  if (!profile?.id) { return jsonResponse({ error: 'User profile not found' }, 404) }

  const body = await req.json().catch(() => null) as Record<string, unknown> | null
  const repositoryId = typeof body?.repository_id === 'string' ? body.repository_id.trim() : ''
  const repositoryName = typeof body?.repository_name === 'string' ? body.repository_name.trim() : null
  const workspacePathHash = typeof body?.workspace_path_hash === 'string' ? body.workspace_path_hash.trim() : null
  const workspaceId = typeof body?.linear_workspace_id === 'string' ? body.linear_workspace_id.trim() : ''
  const workspaceName = typeof body?.linear_workspace_name === 'string' ? body.linear_workspace_name.trim() : null
  const teamId = typeof body?.linear_team_id === 'string' ? body.linear_team_id.trim() : ''
  const teamKey = typeof body?.linear_team_key === 'string' ? body.linear_team_key.trim() : null
  const teamName = typeof body?.linear_team_name === 'string' ? body.linear_team_name.trim() : ''
  if (!repositoryId || !workspaceId || !teamId || !teamName) {
    return jsonResponse({ error: 'Missing repository or Linear team selection' }, 400)
  }

  const now = new Date().toISOString()
  const { data: mapping, error } = await supabase
    .from('linear_team_mappings')
    .upsert({
      user_id: profile.id,
      repository_id: repositoryId,
      repository_name: repositoryName,
      workspace_path_hash: workspacePathHash,
      linear_workspace_id: workspaceId,
      linear_workspace_name: workspaceName,
      linear_team_id: teamId,
      linear_team_key: teamKey,
      linear_team_name: teamName,
      updated_at: now,
    }, { onConflict: 'user_id,repository_id,linear_workspace_id,linear_team_id' })
    .select('repository_id, repository_name, workspace_path_hash, linear_workspace_id, linear_workspace_name, linear_team_id, linear_team_key, linear_team_name')
    .single()
  if (error) {
    console.error('Linear team mapping save failed:', error)
    return jsonResponse({ error: 'Failed to save Linear team mapping' }, 500)
  }
  return jsonResponse({ mapping })
})
