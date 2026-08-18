/**
 * PEV Supervisor sub-agent prompts + Verify (schema) helpers.
 * Keep pure — no Deno/Node APIs.
 */

export type PevAgentId = 'sentinel' | 'staff_engineer' | 'pm_ghost_cop';

export interface AgentFinding {
  id?: string;
  file: string;
  line?: number;
  severity: 'critical' | 'high' | 'medium' | 'low';
  category: string;
  title: string;
  explanation: string;
  suggestedFix?: string;
  confidence: 'high' | 'medium' | 'low';
  framework?: string;
  control?: string;
  falsePositive?: boolean;
}

export interface SentinelOutput {
  agent: 'sentinel';
  findings: AgentFinding[];
  securityStatus: 'passed' | 'warning' | 'needs_work' | 'blocked';
  summary: string;
}

export interface StaffEngineerOutput {
  agent: 'staff_engineer';
  findings: AgentFinding[];
  score: number;
  summary: string;
}

export interface PmGhostCopOutput {
  agent: 'pm_ghost_cop';
  ticket_requirements: string[];
  developer_additions: string[];
  unmapped_additions: string[];
  drift_detected: boolean;
}

const SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);
const CONFIDENCES = new Set(['high', 'medium', 'low']);

function clampScore(n: unknown, fallback = 70): number {
  const v = typeof n === 'number' && !Number.isNaN(n) ? n : fallback;
  return Math.max(0, Math.min(100, Math.round(v)));
}

function sanitizeFinding(raw: unknown): AgentFinding | null {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw as Record<string, unknown>;
  const title = typeof f.title === 'string' ? f.title.trim() : '';
  const file = typeof f.file === 'string' ? f.file.trim() : '';
  if (!title || !file) return null;
  if (f.falsePositive === true) return null;
  const severity = SEVERITIES.has(String(f.severity)) ? String(f.severity) as AgentFinding['severity'] : 'medium';
  const confidence = CONFIDENCES.has(String(f.confidence)) ? String(f.confidence) as AgentFinding['confidence'] : 'medium';
  return {
    id: typeof f.id === 'string' ? f.id : undefined,
    file,
    line: typeof f.line === 'number' ? f.line : undefined,
    severity,
    category: typeof f.category === 'string' ? f.category : 'maintainability',
    title,
    explanation: typeof f.explanation === 'string' ? f.explanation : '',
    suggestedFix: typeof f.suggestedFix === 'string' ? f.suggestedFix : undefined,
    confidence,
    framework: typeof f.framework === 'string' ? f.framework : undefined,
    control: typeof f.control === 'string' ? f.control : undefined,
  };
}

export function verifySentinelOutput(raw: unknown): SentinelOutput | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const findings = (Array.isArray(r.findings) ? r.findings : [])
    .map(sanitizeFinding)
    .filter(Boolean) as AgentFinding[];
  const status = ['passed', 'warning', 'needs_work', 'blocked'].includes(String(r.securityStatus))
    ? String(r.securityStatus) as SentinelOutput['securityStatus']
    : findings.some(f => f.severity === 'critical') ? 'blocked'
      : findings.length ? 'needs_work' : 'passed';
  return {
    agent: 'sentinel',
    findings,
    securityStatus: status,
    summary: typeof r.summary === 'string' ? r.summary.slice(0, 400) : '',
  };
}

export function verifyStaffEngineerOutput(raw: unknown): StaffEngineerOutput | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const findings = (Array.isArray(r.findings) ? r.findings : [])
    .map(sanitizeFinding)
    .filter(Boolean) as AgentFinding[];
  return {
    agent: 'staff_engineer',
    findings,
    score: clampScore(r.score, findings.length ? 70 : 90),
    summary: typeof r.summary === 'string' ? r.summary.slice(0, 400) : '',
  };
}

export function verifyPmGhostCopOutput(raw: unknown): PmGhostCopOutput | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const strs = (v: unknown) =>
    Array.isArray(v) ? v.map(x => String(x || '').trim()).filter(Boolean).slice(0, 20) : [];
  const unmapped = strs(r.unmapped_additions ?? r.unmappedAdditions);
  return {
    agent: 'pm_ghost_cop',
    ticket_requirements: strs(r.ticket_requirements ?? r.ticketRequirements),
    developer_additions: strs(r.developer_additions ?? r.developerAdditions),
    unmapped_additions: unmapped,
    drift_detected: r.drift_detected === true || r.driftDetected === true || unmapped.length > 0,
  };
}

/** Merge specialist agent findings into one list (dedupe by file:title). */
export function mergeAgentFindings(
  ...groups: AgentFinding[][]
): AgentFinding[] {
  const seen = new Set<string>();
  const out: AgentFinding[] = [];
  for (const group of groups) {
    for (const f of group) {
      const key = `${f.file}:${f.title}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(f);
    }
  }
  return out.slice(0, 40);
}

export function buildSentinelPrompts(args: {
  detSecurityJson: string;
  detComplianceJson: string;
  diff: string;
}): { system: string; user: string } {
  return {
    system: `You are a draconian Data Privacy Officer and Cloud Security Engineer.
You are strictly bound to deterministic Semgrep/security/compliance alerts already produced.
Your job: adjudicate true vulnerabilities vs false positives, and map every kept finding to HIPAA, GDPR, or SOC2 when applicable.
Return STRICT JSON only.`,
    user: `Adjudicate these deterministic alerts. Drop clear false positives (set falsePositive:true or omit).
Return JSON:
{
  "securityStatus": "passed|warning|needs_work|blocked",
  "summary": "string",
  "findings": [{
    "file":"string","line":number?,"severity":"critical|high|medium|low",
    "category":"security|compliance","title":"string","explanation":"string",
    "confidence":"high|medium|low","framework":"HIPAA|GDPR|SOC2"?,"control":"string"?,
    "falsePositive":boolean?
  }]
}

<deterministic_security>
${args.detSecurityJson.slice(0, 12_000)}
</deterministic_security>

<deterministic_compliance>
${args.detComplianceJson.slice(0, 12_000)}
</deterministic_compliance>

<untrusted_diff>
${String(args.diff || '').slice(0, 20_000)}
</untrusted_diff>`,
  };
}

export function buildStaffEngineerPrompts(args: {
  astSummary: string;
  blastRadius: string;
  diff: string;
}): { system: string; user: string } {
  return {
    system: `You are a Principal Engineer obsessed with algorithmic efficiency and memory safety.
Your sole job: identify logic flaws, N+1 database queries, architectural anti-patterns, and breakages in 1-hop importers. Cite only paths in the diff or codegraph_neighborhood. Impact findings must quote an IMPORTERS evidence line.
Return STRICT JSON only.`,
    user: `Review for performance and logic. Return JSON:
{
  "score": 0-100,
  "summary": "string",
  "findings": [{
    "file":"string","line":number?,"severity":"critical|high|medium|low",
    "category":"correctness|performance|maintainability|breaking_change",
    "title":"string","explanation":"string","suggestedFix":"string?",
    "confidence":"high|medium|low"
  }]
}

<ast_diff>
${args.astSummary.slice(0, 8_000)}
</ast_diff>

<codegraph_neighborhood>
${args.blastRadius.slice(0, 8_000)}
</codegraph_neighborhood>

<untrusted_diff>
${String(args.diff || '').slice(0, 24_000)}
</untrusted_diff>`,
  };
}
