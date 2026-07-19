import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-machine-id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

type LinearConnection = {
  id: string
  user_id: string
  access_token_encrypted: string
  refresh_token_encrypted?: string | null
  expires_at?: string | null
  linear_workspace_id?: string | null
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

async function requireProfile(req: Request, supabase: ReturnType<typeof createClient<any>>): Promise<{ id: string } | Response> {
  const authHeader = req.headers.get('Authorization')
  const machineId = req.headers.get('X-Machine-ID')
  if (!authHeader) { return jsonResponse({ error: 'Missing Authorization header' }, 401) }

  const githubToken = authHeader.replace(/^bearer\s+/i, '').trim()
  const ghUserRes = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${githubToken}`, Accept: 'application/json', 'User-Agent': 'Tyne-Backend' },
  })
  if (!ghUserRes.ok) { return jsonResponse({ error: 'Invalid GitHub token' }, 401) }
  const ghUser = await ghUserRes.json()
  const githubId = String(ghUser.id)

  if (machineId) {
    const { data: blocked } = await supabase.from('hardware_blocklist').select('machine_id').eq('machine_id', machineId).maybeSingle()
    if (blocked) { return jsonResponse({ error: 'Hardware ID is blocked' }, 403) }
  }

  const { data: profile, error } = await supabase.from('user_profiles').select('id').eq('github_id', githubId).maybeSingle()
  if (error) {
    console.error('Hosted Linear API profile lookup failed:', error)
    return jsonResponse({ error: 'Profile lookup failed' }, 500)
  }
  if (!profile?.id) { return jsonResponse({ error: 'User profile not found' }, 404) }
  return { id: profile.id }
}

async function linearGraphQL<T>(accessToken: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ query, variables }),
  })
  const payload = await res.json().catch(() => null) as { data?: T; errors?: Array<{ message: string }> } | null
  if (!res.ok || !payload || payload.errors?.length) {
    throw new Error(payload?.errors?.[0]?.message || `Linear API request failed (${res.status})`)
  }
  return payload.data as T
}

async function refreshLinearConnectionIfNeeded(
  supabase: ReturnType<typeof createClient<any>>,
  connection: LinearConnection,
): Promise<LinearConnection> {
  const expiresAt = connection.expires_at ? Date.parse(connection.expires_at) : 0
  if (!expiresAt || expiresAt > Date.now() + 60_000 || !connection.refresh_token_encrypted) {
    return connection
  }

  const clientId = Deno.env.get('LINEAR_CLIENT_ID')
  const clientSecret = Deno.env.get('LINEAR_CLIENT_SECRET')
  if (!clientId || !clientSecret) {
    throw new Error('Missing Linear refresh environment')
  }

  const tokenRes = await fetch('https://api.linear.app/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: connection.refresh_token_encrypted,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  })
  if (!tokenRes.ok) {
    throw new Error('Linear token refresh failed')
  }

  const tokenPayload = await tokenRes.json() as Record<string, unknown>
  const accessToken = typeof tokenPayload.access_token === 'string' ? tokenPayload.access_token : ''
  const refreshToken = typeof tokenPayload.refresh_token === 'string' ? tokenPayload.refresh_token : connection.refresh_token_encrypted
  const expiresIn = Number(tokenPayload.expires_in || 0)
  if (!accessToken) {
    throw new Error('Incomplete Linear refresh response')
  }

  const next: LinearConnection = {
    ...connection,
    access_token_encrypted: accessToken,
    refresh_token_encrypted: refreshToken,
    expires_at: expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : connection.expires_at,
  }

  const { error } = await supabase
    .from('linear_connections')
    .update({
      access_token_encrypted: next.access_token_encrypted,
      refresh_token_encrypted: next.refresh_token_encrypted,
      expires_at: next.expires_at,
      updated_at: new Date().toISOString(),
    })
    .eq('id', connection.id)
    .eq('user_id', connection.user_id)

  if (error) {
    throw error
  }

  return next
}

const OPERATIONS: Record<string, { query: string; mapVariables?: (variables: Record<string, unknown>) => Record<string, unknown> }> = {
  viewer: {
    query: `query TyneViewer { viewer { id name email organization { id name } } }`,
  },
  listTeams: {
    query: `query TyneListTeams { teams { nodes { id key name } } }`,
  },
  listAssignedIssues: {
    query: `
      query TyneListAssignedIssues($filter: IssueFilter, $first: Int) {
        issues(filter: $filter, first: $first, orderBy: updatedAt) {
          nodes {
            id
            identifier
            title
            description
            url
            priority
            createdAt
            updatedAt
            state { id name type }
            assignee { id name email }
            team { id key name }
            project { id name }
            cycle { id name }
            parent { id identifier title }
            labels { nodes { id name } }
          }
        }
      }
    `,
    mapVariables: (variables) => {
      const teamId = typeof variables.teamId === 'string' ? variables.teamId : null
      const assignedOnly = variables.assignedOnly !== false
      const includeCompleted = variables.includeCompleted === true
      const rawFirst = typeof variables.first === 'number' ? variables.first : 50
      const first = Math.min(Math.max(Math.floor(rawFirst), 1), 100)
      const filter: Record<string, unknown> = {}
      if (teamId) { filter.team = { id: { eq: teamId } } }
      // Filter by assignee server-side so the connected user's issues are never
      // hidden behind an arbitrary first-N page on teams with many issues.
      if (assignedOnly) { filter.assignee = { isMe: { eq: true } } }
      if (!includeCompleted) { filter.state = { type: { nin: ['completed', 'canceled'] } } }
      return { filter, first }
    },
  },
  getIssueDetail: {
    query: `
      query TyneGetIssueDetail($id: String!) {
        issue(id: $id) {
          id
          identifier
          title
          description
          url
          priority
          createdAt
          updatedAt
          state { id name type }
          assignee { id name email }
          team { id key name states { nodes { id name color type } } }
          project { id name }
          cycle { id name }
          parent { id identifier title }
          labels { nodes { id name } }
          children {
            nodes {
              id
              identifier
              title
              state { name }
            }
          }
          comments {
            nodes {
              id
              body
              createdAt
              updatedAt
              user { id name }
            }
          }
        }
      }
    `,
    mapVariables: (variables) => ({ id: typeof variables.id === 'string' ? variables.id : '' }),
  },
  listComments: {
    query: `
      query TyneListComments($id: String!) {
        issue(id: $id) {
          comments {
            nodes {
              id
              body
              createdAt
              updatedAt
              user { id name }
            }
          }
        }
      }
    `,
    mapVariables: (variables) => ({ id: typeof variables.id === 'string' ? variables.id : '' }),
  },
  createComment: {
    query: `
      mutation TyneCreateComment($input: CommentCreateInput!) {
        commentCreate(input: $input) {
          success
          comment { id }
        }
      }
    `,
    mapVariables: (variables) => ({
      input: {
        issueId: typeof variables.issueId === 'string' ? variables.issueId : '',
        body: typeof variables.body === 'string' ? variables.body : '',
      },
    }),
  },
  updateIssueStatus: {
    query: `
      mutation TyneUpdateIssueStatus($id: String!, $stateId: String!) {
        issueUpdate(id: $id, stateId: $stateId) {
          success
          issue { id state { name } }
        }
      }
    `,
    mapVariables: (variables) => ({
      id: typeof variables.id === 'string' ? variables.id : '',
      stateId: typeof variables.stateId === 'string' ? variables.stateId : '',
    }),
  },
}

// Flatten the GraphQL `issues { nodes }` envelope into the flat `{ issues: [...] }`
// array shape the extension's LinearProvider consumes. Assignee/team/state
// filtering is performed server-side in the GraphQL query (see listAssignedIssues),
// so there is no in-memory assigned filtering here.
function extractIssueNodes(payload: Record<string, unknown>): Record<string, unknown> {
  const issues = payload.issues as Record<string, unknown> | undefined
  const nodes = Array.isArray(issues?.nodes)
    ? (issues!.nodes as Array<Record<string, unknown>>)
    : []
  return { issues: nodes }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') { return new Response('ok', { headers: corsHeaders }) }
  if (req.method !== 'POST') { return jsonResponse({ error: 'Method not allowed' }, 405) }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceRoleKey) { return jsonResponse({ error: 'Missing Supabase function environment' }, 500) }

  const supabase = createClient(supabaseUrl, serviceRoleKey)
  const profile = await requireProfile(req, supabase)
  if (profile instanceof Response) { return profile }

  const body = await req.json().catch(() => null) as Record<string, unknown> | null
  const operation = typeof body?.operation === 'string' ? body.operation : ''
  const variables = body?.variables && typeof body.variables === 'object' ? body.variables as Record<string, unknown> : {}
  const definition = OPERATIONS[operation]
  if (!definition) {
    console.warn('Hosted Linear API request blocked:', { operation: operation || 'missing' })
    return jsonResponse({ error: 'Linear request is not allowed' }, 400)
  }

  const { data: connection, error } = await supabase
    .from('linear_connections')
    .select('id, user_id, access_token_encrypted, refresh_token_encrypted, expires_at, linear_workspace_id')
    .eq('user_id', profile.id)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) {
    console.error('Hosted Linear API connection lookup failed:', error)
    return jsonResponse({ error: 'Linear connection lookup failed' }, 500)
  }
  if (!connection) { return jsonResponse({ error: 'Linear connection not found' }, 404) }

  try {
    const freshConnection = await refreshLinearConnectionIfNeeded(supabase, connection as LinearConnection)
    const payload = await linearGraphQL<Record<string, unknown>>(
      freshConnection.access_token_encrypted,
      definition.query,
      definition.mapVariables ? definition.mapVariables(variables) : variables,
    )
    if (operation === 'listAssignedIssues') {
      return jsonResponse(extractIssueNodes(payload))
    }
    return jsonResponse(payload)
  } catch (err) {
    console.error('Hosted Linear API request failed:', err)
    return jsonResponse({ error: err instanceof Error ? err.message : 'Linear API request failed' }, 502)
  }
})
