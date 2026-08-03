import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { requireUserProfileId } from '../_shared/requireUserProfileId.ts'
import { openToken } from '../_shared/oauthTokens.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-machine-id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

type JiraConnection = {
  id: string
  user_id: string
  access_token: string | null
  access_token_enc?: string | null
  cloud_id: string
  site_name?: string | null
  site_url?: string | null
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405)
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: 'Missing Supabase function environment' }, 500)
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey)
  const authHeader = req.headers.get('Authorization') || ''
  const machineId = req.headers.get('X-Machine-ID')
  const profile = await requireUserProfileId(supabase, authHeader, machineId)
  if ('error' in profile) {
    return jsonResponse({ error: profile.error }, profile.status)
  }

  const body = await req.json().catch(() => null) as Record<string, unknown> | null
  const repositoryId = typeof body?.repository_id === 'string' ? body.repository_id.trim() : ''
  const repositoryName = typeof body?.repository_name === 'string' ? body.repository_name.trim() : null
  const workspacePathHash = typeof body?.workspace_path_hash === 'string' ? body.workspace_path_hash.trim() : null
  const cloudId = typeof body?.cloud_id === 'string' ? body.cloud_id.trim() : ''
  const projectId = typeof body?.project_id === 'string' ? body.project_id.trim() : ''
  const projectKey = typeof body?.project_key === 'string' ? body.project_key.trim().toUpperCase() : ''
  const projectName = typeof body?.project_name === 'string' ? body.project_name.trim() : ''
  const projectAvatarUrl = typeof body?.project_avatar_url === 'string' ? body.project_avatar_url.trim() : null

  if (!repositoryId || !cloudId || !projectId || !projectKey || !projectName) {
    return jsonResponse({ error: 'Missing repository or Jira project selection' }, 400)
  }

  const { data: connection, error: connectionError } = await supabase
    .from('jira_connections')
    .select('id, user_id, access_token, access_token_enc, cloud_id, site_name, site_url')
    .eq('user_id', profile.id)
    .eq('cloud_id', cloudId)
    .maybeSingle()

  if (connectionError) {
    console.error('Jira mapping connection lookup failed:', connectionError)
    return jsonResponse({ error: 'Jira connection lookup failed' }, 500)
  }

  if (!connection) {
    return jsonResponse({ error: 'Jira connection not found for selected site' }, 404)
  }

  const jiraConnection = connection as JiraConnection
  const accessToken = await openToken(jiraConnection.access_token_enc, jiraConnection.access_token)
  const projectRes = await fetch(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/project/${encodeURIComponent(projectId)}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  })

  if (!projectRes.ok) {
    return jsonResponse({ error: 'Selected Jira project is not available for this connection' }, 400)
  }

  const project = await projectRes.json() as Record<string, unknown>
  if (String(project.id || '') !== projectId || String(project.key || '').toUpperCase() !== projectKey) {
    return jsonResponse({ error: 'Selected Jira project does not match Jira response' }, 400)
  }

  const now = new Date().toISOString()
  const { data: mapping, error: mappingError } = await supabase
    .from('jira_project_mappings')
    .upsert({
      user_id: profile.id,
      repository_id: repositoryId,
      repository_name: repositoryName,
      workspace_path_hash: workspacePathHash,
      cloud_id: cloudId,
      site_name: jiraConnection.site_name,
      site_url: jiraConnection.site_url,
      project_id: projectId,
      project_key: projectKey,
      project_name: projectName,
      project_avatar_url: projectAvatarUrl,
      is_default: true,
      updated_at: now,
    }, { onConflict: 'user_id,repository_id,cloud_id,project_id' })
    .select('id, repository_id, cloud_id, site_name, site_url, project_id, project_key, project_name, project_avatar_url')
    .single()

  if (mappingError) {
    console.error('Jira project mapping save failed:', mappingError)
    return jsonResponse({ error: 'Failed to save Jira project mapping' }, 500)
  }

  return jsonResponse({ mapping })
})
