/**
 * Pure PEV scope-drift matrix + A2A resolution.
 * Keep in sync with supabase/functions/_shared/scopeDriftHarness.ts
 */

export interface ScopeDriftMatrix {
  ticket_requirements: string[];
  developer_additions: string[];
  unmapped_additions: string[];
  drift_detected: boolean;
}

export interface A2AVerdict {
  addition: string;
  required_dependency: boolean;
  reason: string;
}

export interface ResolvedScopeDrift {
  matrix: ScopeDriftMatrix;
  verdicts: A2AVerdict[];
  lockedDrift: string[];
  overruled: string[];
}

function asStringList(value: unknown, max = 20): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(v => (typeof v === 'string' ? v.trim() : ''))
    .filter(Boolean)
    .slice(0, max);
}

/** Parse/normalize the PM Ghost Cop internal reasoning matrix. */
export function parseScopeDriftMatrix(raw: unknown): ScopeDriftMatrix | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const ticket_requirements = asStringList(r.ticket_requirements ?? r.ticketRequirements);
  const developer_additions = asStringList(r.developer_additions ?? r.developerAdditions);
  let unmapped_additions = asStringList(r.unmapped_additions ?? r.unmappedAdditions);
  const explicitFalse = r.drift_detected === false || r.driftDetected === false;
  // Infer unmapped only when the model omitted the field and did not claim clean.
  if (!unmapped_additions.length && !explicitFalse && developer_additions.length && ticket_requirements.length) {
    const reqLower = new Set(ticket_requirements.map(t => t.toLowerCase()));
    unmapped_additions = developer_additions.filter(a => !reqLower.has(a.toLowerCase()));
  }
  if (explicitFalse) unmapped_additions = [];
  const drift_detected = !explicitFalse && (
    r.drift_detected === true
    || r.driftDetected === true
    || unmapped_additions.length > 0
  );
  return {
    ticket_requirements,
    developer_additions,
    unmapped_additions: drift_detected ? unmapped_additions : [],
    drift_detected: drift_detected && unmapped_additions.length > 0,
  };
}

export function parseA2AVerdict(raw: unknown, addition: string): A2AVerdict {
  const r = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const required = r.required_dependency === true
    || r.requiredDependency === true
    || r.verdict === 'required'
    || String(r.answer || '').toLowerCase() === 'yes';
  return {
    addition,
    required_dependency: required,
    reason: typeof r.reason === 'string' ? r.reason.trim().slice(0, 400) : '',
  };
}

/** Apply Staff Engineer A2A verdicts: required → overrule, else lock as drift. */
export function resolveScopeDrift(
  matrix: ScopeDriftMatrix,
  verdicts: A2AVerdict[],
): ResolvedScopeDrift {
  const byAddition = new Map(verdicts.map(v => [v.addition.toLowerCase(), v]));
  const lockedDrift: string[] = [];
  const overruled: string[] = [];
  for (const addition of matrix.unmapped_additions) {
    const v = byAddition.get(addition.toLowerCase());
    if (v?.required_dependency) overruled.push(addition);
    else lockedDrift.push(addition);
  }
  return {
    matrix: {
      ...matrix,
      unmapped_additions: lockedDrift,
      drift_detected: lockedDrift.length > 0,
    },
    verdicts,
    lockedDrift,
    overruled,
  };
}

export function driftFindingsFromResolved(resolved: ResolvedScopeDrift): Array<{
  id: string;
  file: string;
  severity: 'high' | 'medium';
  category: 'pm_alignment';
  title: string;
  explanation: string;
  confidence: 'high';
  blocking: boolean;
}> {
  return resolved.lockedDrift.map((addition, i) => ({
    id: `drift_${i + 1}`,
    file: '(scope)',
    severity: 'high' as const,
    category: 'pm_alignment' as const,
    title: `Scope drift: ${addition}`,
    explanation: `Addition "${addition}" is not mapped to ticket requirements`
      + (resolved.verdicts.find(v => v.addition === addition)?.reason
        ? ` — ${resolved.verdicts.find(v => v.addition === addition)!.reason}`
        : '.')
      + ' Staff Engineer confirmed it is not a required dependency.',
    confidence: 'high' as const,
    blocking: true,
  }));
}

export function pendingGoalsFromDrift(resolved: ResolvedScopeDrift): Array<{
  title: string;
  reason: string;
  suggestedAction: string;
  priority: 'high';
}> {
  return resolved.lockedDrift.map(addition => ({
    title: `Remove or justify out-of-scope: ${addition}`,
    reason: `Not in ticket requirements; A2A locked as scope drift.`,
    suggestedAction: `Drop "${addition}" or update the ticket acceptance criteria.`,
    priority: 'high' as const,
  }));
}

export function buildPmGhostCopPrompt(pmXml: string, diff: string): {
  system: string;
  user: string;
} {
  return {
    system: `You are an uncompromising Product Manager. Your only goal is to ensure the engineering team builds exactly what is in the ticket—nothing more, nothing less.
You do not care if the code compiles. Compare the semantic intent of the Git Diff exclusively against the Acceptance Criteria.
Return STRICT JSON only — the internal reasoning matrix, not a full review.`,
    user: `Evaluate scope. Return JSON:
{
  "ticket_requirements": ["..."],
  "developer_additions": ["..."],
  "unmapped_additions": ["..."],
  "drift_detected": true|false
}

Rules:
- ticket_requirements: extract from the Golden Contract (acceptance criteria / goals).
- developer_additions: concrete features/behaviors introduced by the diff (not file names).
- unmapped_additions: developer_additions with no clear mapping to ticket_requirements.
- drift_detected: true iff unmapped_additions is non-empty.

<linear_ticket>
${pmXml}
</linear_ticket>

<untrusted_diff>
${String(diff || '').slice(0, 28_000)}
</untrusted_diff>`,
  };
}

export function buildA2AStaffPrompt(
  addition: string,
  ticketRequirements: string[],
  diffExcerpt: string,
): { system: string; user: string } {
  return {
    system: `You are a Principal Engineer obsessed with algorithmic efficiency and memory safety.
You adjudicate whether a claimed "scope drift" item is actually a required architectural dependency for the ticket to function.
Return STRICT JSON only.`,
    user: `The PM Agent believes "${addition}" is scope drift.
Ticket requirements: ${JSON.stringify(ticketRequirements.slice(0, 12))}

Is "${addition}" a required architectural dependency for those requirements to function?

Return JSON:
{
  "required_dependency": true|false,
  "reason": "one sentence"
}

Diff excerpt:
<untrusted_diff>
${String(diffExcerpt || '').slice(0, 12_000)}
</untrusted_diff>`,
  };
}

/** Compile PM task into immutable Golden Contract body (inside <linear_ticket>). */
export function compileGoldenContract(pmTask: Record<string, unknown> | null | undefined): string {
  if (!pmTask || typeof pmTask !== 'object') return '';
  const criteria = Array.isArray(pmTask.acceptanceCriteria)
    ? (pmTask.acceptanceCriteria as unknown[]).map(c => `- ${c}`).join('\n')
    : 'None';
  const subtasks = Array.isArray(pmTask.subtasks)
    ? (pmTask.subtasks as any[]).map(s => `- [${s.status || 'unknown'}] ${s.title}`).join('\n')
    : 'None';
  const impl = (pmTask.developerTaskPlan as any)?.implementationTasks;
  const implTasks = Array.isArray(impl)
    ? impl.map((t: any) => `- [${t.status}] ${t.title}`).join('\n')
    : 'None';
  return [
    `Source: ${pmTask.source || 'unknown'}`,
    `Identifier: ${pmTask.issueIdentifier || 'unknown'}`,
    `Title: ${pmTask.title || ''}`,
    `Goal: ${pmTask.goal || '(not specified)'}`,
    `Description:\n${pmTask.description || '(no description)'}`,
    `Acceptance Criteria:\n${criteria}`,
    `Subtasks:\n${subtasks}`,
    `Developer Task Plan:\n${implTasks}`,
  ].join('\n\n');
}
