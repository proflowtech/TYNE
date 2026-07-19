/**
 * Human-readable scope drift explanations — Staff Engineer vs PM Ghost Cop.
 * LLM enhances wording; deterministic adjudication anchors to drift matrix (A2A).
 */
import type { TyneScopeDriftMatrix } from '../validateReviewTypes';
import type { TyneAiProvider } from '../validationTypes';

const EXPLAIN_TIMEOUT_MS = 28_000;

export interface ScopeDriftTaskInput {
  description: string;
  acceptance_criteria: string[];
  title?: string;
  goal?: string;
}

export interface ScopeDriftPrAnalysis {
  added_functionality: string[];
  removed_functionality: string[];
  modified_behavior: string[];
  diff_excerpt?: string;
  drift_matrix?: TyneScopeDriftMatrix;
  evidence_snippets?: Array<{ file: string; line?: number; snippet: string }>;
}

export interface ScopeDriftExplanation {
  task_description: string;
  acceptance_criteria: string[];
  code_analysis: {
    added_functionality: string[];
    removed_functionality: string[];
    modified_behavior: string[];
  };
  agent_verdicts: {
    staff_engineer: {
      verdict: 'on_scope' | 'partial_creep' | 'major_drift';
      reasoning: string;
      evidence: string[];
    };
    pm_ghost_cop: {
      verdict: 'on_scope' | 'should_split';
      reasoning: string;
      evidence: string[];
    };
  };
  adjudication: {
    winner: 'staff_engineer' | 'pm_ghost_cop';
    final_verdict: string;
    explanation: string;
  };
  recommendation: 'merge_as_is' | 'request_split' | 'request_clarification';
}

export interface ScopeDriftLlmConfig {
  provider: TyneAiProvider;
  apiKey: string;
  model?: string;
}

type StaffVerdict = ScopeDriftExplanation['agent_verdicts']['staff_engineer']['verdict'];
type PmVerdict = ScopeDriftExplanation['agent_verdicts']['pm_ghost_cop']['verdict'];
type Recommendation = ScopeDriftExplanation['recommendation'];

function strList(v: unknown, max = 20): string[] {
  if (!Array.isArray(v)) return [];
  return v.map(x => String(x || '').trim()).filter(Boolean).slice(0, max);
}

function lockedItems(matrix?: TyneScopeDriftMatrix): string[] {
  if (!matrix) return [];
  return strList(matrix.lockedDrift?.length ? matrix.lockedDrift : matrix.unmapped_additions);
}

function overruledItems(matrix?: TyneScopeDriftMatrix): string[] {
  return strList(matrix?.overruled);
}

/** Map A2A matrix → baseline agent verdicts (source of truth). */
export function baselineAgentVerdicts(matrix?: TyneScopeDriftMatrix): {
  staff: StaffVerdict;
  pm: PmVerdict;
} {
  const locked = lockedItems(matrix);
  const overruled = overruledItems(matrix);
  const drift = matrix?.drift_detected === true || locked.length > 0;

  let staff: StaffVerdict = 'on_scope';
  if (locked.length >= 2) staff = 'major_drift';
  else if (locked.length === 1) staff = 'partial_creep';
  else if (drift && !locked.length && overruled.length) staff = 'on_scope';

  const pm: PmVerdict = drift && locked.length > 0 ? 'should_split' : 'on_scope';
  return { staff, pm };
}

/** Deterministic adjudication aligned with PEV A2A locked/overruled lists. */
export function adjudicateScopeDrift(
  matrix: TyneScopeDriftMatrix | undefined,
  staff: StaffVerdict,
  pm: PmVerdict,
): ScopeDriftExplanation['adjudication'] & { recommendation: Recommendation } {
  const locked = lockedItems(matrix);
  const overruled = overruledItems(matrix);
  const reqs = strList(matrix?.ticket_requirements);

  if (locked.length > 0) {
    const winner = 'pm_ghost_cop' as const;
    const recommendation: Recommendation =
      locked.length >= 2 || staff === 'major_drift' ? 'request_split' : 'request_clarification';
    return {
      winner,
      final_verdict: locked.length === 1
        ? `One out-of-scope addition locked: ${locked[0]}`
        : `${locked.length} out-of-scope additions locked after A2A review`,
      explanation: [
        `PM Ghost Cop mapped ticket requirements (${reqs.length}) against developer additions and flagged unmapped work.`,
        `Staff Engineer reviewed each flagged item; ${locked.length} could not be justified as a required dependency${overruled.length ? ` (${overruled.length} overruled as dependencies: ${overruled.join(', ')})` : ''}.`,
        `Locked drift: ${locked.join('; ')}.`,
      ].join(' '),
      recommendation,
    };
  }

  if (overruled.length > 0) {
    return {
      winner: 'staff_engineer',
      final_verdict: 'On scope — PM-flagged items are required dependencies',
      explanation: [
        `PM Ghost Cop initially flagged ${overruled.length} addition(s) as potentially unmapped.`,
        `Staff Engineer confirmed each is a required dependency for the acceptance criteria: ${overruled.join('; ')}.`,
        'No locked drift remains — merge is acceptable from a scope perspective.',
      ].join(' '),
      recommendation: 'merge_as_is',
    };
  }

  if (!matrix?.drift_detected) {
    return {
      winner: 'staff_engineer',
      final_verdict: 'On scope — diff aligns with acceptance criteria',
      explanation: 'PM Ghost Cop found no unmapped additions; Staff Engineer agrees the change set matches the ticket.',
      recommendation: 'merge_as_is',
    };
  }

  // Drift signal without locked items — ask for clarification.
  return {
    winner: pm === 'should_split' ? 'pm_ghost_cop' : 'staff_engineer',
    final_verdict: staff === 'major_drift' ? 'Scope creep suspected — needs clarification' : 'Minor scope ambiguity',
    explanation: 'Drift was detected but A2A did not lock items — confirm with PM whether additions belong in this ticket.',
    recommendation: 'request_clarification',
  };
}

function staffReasoning(staff: StaffVerdict, matrix?: TyneScopeDriftMatrix): string {
  const locked = lockedItems(matrix);
  const overruled = overruledItems(matrix);
  if (staff === 'major_drift') {
    return `Multiple additions (${locked.join(', ')}) are not traceable to acceptance criteria and failed dependency review.`;
  }
  if (staff === 'partial_creep') {
    return `"${locked[0]}" introduces behavior outside the ticket; it is not a required dependency for the stated requirements.`;
  }
  if (overruled.length) {
    return `PM flagged ${overruled.join(', ')} as potential drift, but each is a necessary dependency to deliver the ticket.`;
  }
  return 'Diff changes implement the acceptance criteria without unrelated feature work.';
}

function pmReasoning(pm: PmVerdict, matrix?: TyneScopeDriftMatrix): string {
  const locked = lockedItems(matrix);
  const additions = strList(matrix?.developer_additions);
  if (pm === 'should_split') {
    return `Developer additions include work not mapped to acceptance criteria (${locked.join(', ')}). Split or update the ticket before merge.`;
  }
  if (!additions.length) {
    return 'No new functionality beyond the ticket was detected in the diff.';
  }
  return `All detected additions (${additions.slice(0, 4).join(', ')}) map to stated acceptance criteria.`;
}

function evidenceFromMatrix(
  matrix: TyneScopeDriftMatrix | undefined,
  prAnalysis: ScopeDriftPrAnalysis,
): { staff: string[]; pm: string[] } {
  const snippets = (prAnalysis.evidence_snippets || []).map(s =>
    `${s.file}${s.line ? ':' + s.line : ''}: ${s.snippet.slice(0, 120)}`,
  );
  const locked = lockedItems(matrix);
  const staff: string[] = [];
  const pm: string[] = [];

  for (const v of matrix?.verdicts || []) {
    if (v.required_dependency === false && v.reason) {
      staff.push(`A2A on "${v.addition}": ${v.reason}`);
    } else if (v.required_dependency && v.reason) {
      staff.push(`Overruled "${v.addition}": ${v.reason}`);
    }
  }
  for (const item of locked) {
    pm.push(`Unmapped addition: ${item}`);
  }
  for (const req of strList(matrix?.ticket_requirements).slice(0, 4)) {
    pm.push(`Ticket requirement: ${req}`);
  }
  for (const sn of snippets.slice(0, 4)) {
    staff.push(sn);
    pm.push(sn);
  }
  return {
    staff: staff.slice(0, 6),
    pm: pm.slice(0, 6),
  };
}

function buildDeterministicExplanation(
  task: ScopeDriftTaskInput,
  prAnalysis: ScopeDriftPrAnalysis,
): ScopeDriftExplanation {
  const matrix = prAnalysis.drift_matrix;
  const { staff, pm } = baselineAgentVerdicts(matrix);
  const adj = adjudicateScopeDrift(matrix, staff, pm);
  const ev = evidenceFromMatrix(matrix, prAnalysis);

  return {
    task_description: task.description || task.title || '',
    acceptance_criteria: task.acceptance_criteria || [],
    code_analysis: {
      added_functionality: prAnalysis.added_functionality || strList(matrix?.developer_additions),
      removed_functionality: prAnalysis.removed_functionality || [],
      modified_behavior: prAnalysis.modified_behavior || strList(matrix?.ticket_requirements),
    },
    agent_verdicts: {
      staff_engineer: {
        verdict: staff,
        reasoning: staffReasoning(staff, matrix),
        evidence: ev.staff.length ? ev.staff : ['No line-level evidence captured — see diff excerpt.'],
      },
      pm_ghost_cop: {
        verdict: pm,
        reasoning: pmReasoning(pm, matrix),
        evidence: ev.pm.length ? ev.pm : ['Compare developer_additions to acceptance criteria in drift matrix.'],
      },
    },
    adjudication: {
      winner: adj.winner,
      final_verdict: adj.final_verdict,
      explanation: adj.explanation,
    },
    recommendation: adj.recommendation,
  };
}

function buildExplainPrompt(
  task: ScopeDriftTaskInput,
  prAnalysis: ScopeDriftPrAnalysis,
  baseline: ScopeDriftExplanation,
): { system: string; user: string } {
  return {
    system: `You explain scope drift verdicts to developers. Two agents already decided:
- Staff Engineer: technical dependency review
- PM Ghost Cop: ticket alignment review
You MUST keep the same verdict enums and recommendation as the baseline JSON.
Improve reasoning prose and evidence citations only. Return STRICT JSON (no markdown).`,
    user: `Baseline (do NOT change verdict enums or recommendation):
${JSON.stringify({
  staff_verdict: baseline.agent_verdicts.staff_engineer.verdict,
  pm_verdict: baseline.agent_verdicts.pm_ghost_cop.verdict,
  winner: baseline.adjudication.winner,
  recommendation: baseline.recommendation,
  locked: lockedItems(prAnalysis.drift_matrix),
  overruled: overruledItems(prAnalysis.drift_matrix),
})}

Return JSON:
{
  "staff_engineer": { "verdict": "on_scope|partial_creep|major_drift", "reasoning": "2-4 sentences", "evidence": ["file:line — snippet or A2A quote"] },
  "pm_ghost_cop": { "verdict": "on_scope|should_split", "reasoning": "2-4 sentences", "evidence": ["..."] },
  "adjudication": { "winner": "staff_engineer|pm_ghost_cop", "final_verdict": "one line", "explanation": "2-4 sentences explaining who won and why" },
  "recommendation": "merge_as_is|request_split|request_clarification"
}

Task title: ${task.title || '(none)'}
Goal: ${task.goal || '(none)'}
Description: ${(task.description || '').slice(0, 2000)}
Acceptance criteria: ${JSON.stringify(task.acceptance_criteria || [])}

Code analysis:
${JSON.stringify({
  added: prAnalysis.added_functionality,
  removed: prAnalysis.removed_functionality,
  modified: prAnalysis.modified_behavior,
})}

Drift matrix:
${JSON.stringify(prAnalysis.drift_matrix || {}, null, 0).slice(0, 4000)}

Diff excerpt:
${(prAnalysis.diff_excerpt || '').slice(0, 8000)}`,
  };
}

function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
    }
    throw new Error('Invalid JSON from explainer LLM');
  }
}

function mergeLlmExplanation(
  baseline: ScopeDriftExplanation,
  raw: Record<string, unknown>,
): ScopeDriftExplanation {
  const staffRaw = raw.staff_engineer && typeof raw.staff_engineer === 'object'
    ? raw.staff_engineer as Record<string, unknown> : {};
  const pmRaw = raw.pm_ghost_cop && typeof raw.pm_ghost_cop === 'object'
    ? raw.pm_ghost_cop as Record<string, unknown> : {};
  const adjRaw = raw.adjudication && typeof raw.adjudication === 'object'
    ? raw.adjudication as Record<string, unknown> : {};

  const staffVerdict = ['on_scope', 'partial_creep', 'major_drift'].includes(String(staffRaw.verdict))
    ? String(staffRaw.verdict) as StaffVerdict
    : baseline.agent_verdicts.staff_engineer.verdict;
  const pmVerdict = ['on_scope', 'should_split'].includes(String(pmRaw.verdict))
    ? String(pmRaw.verdict) as PmVerdict
    : baseline.agent_verdicts.pm_ghost_cop.verdict;
  const winner = ['staff_engineer', 'pm_ghost_cop'].includes(String(adjRaw.winner))
    ? String(adjRaw.winner) as ScopeDriftExplanation['adjudication']['winner']
    : baseline.adjudication.winner;
  const rec = ['merge_as_is', 'request_split', 'request_clarification'].includes(String(raw.recommendation))
    ? String(raw.recommendation) as Recommendation
    : baseline.recommendation;

  // ponytail: if LLM contradicts locked drift, keep baseline adjudication
  const useBaselineAdj =
    staffVerdict !== baseline.agent_verdicts.staff_engineer.verdict
    || pmVerdict !== baseline.agent_verdicts.pm_ghost_cop.verdict
    || winner !== baseline.adjudication.winner
    || rec !== baseline.recommendation;

  return {
    ...baseline,
    agent_verdicts: {
      staff_engineer: {
        verdict: baseline.agent_verdicts.staff_engineer.verdict,
        reasoning: typeof staffRaw.reasoning === 'string' && staffRaw.reasoning.trim()
          ? staffRaw.reasoning.trim().slice(0, 800)
          : baseline.agent_verdicts.staff_engineer.reasoning,
        evidence: strList(staffRaw.evidence, 8).length
          ? strList(staffRaw.evidence, 8)
          : baseline.agent_verdicts.staff_engineer.evidence,
      },
      pm_ghost_cop: {
        verdict: baseline.agent_verdicts.pm_ghost_cop.verdict,
        reasoning: typeof pmRaw.reasoning === 'string' && pmRaw.reasoning.trim()
          ? pmRaw.reasoning.trim().slice(0, 800)
          : baseline.agent_verdicts.pm_ghost_cop.reasoning,
        evidence: strList(pmRaw.evidence, 8).length
          ? strList(pmRaw.evidence, 8)
          : baseline.agent_verdicts.pm_ghost_cop.evidence,
      },
    },
    adjudication: useBaselineAdj ? baseline.adjudication : {
      winner,
      final_verdict: typeof adjRaw.final_verdict === 'string' && adjRaw.final_verdict.trim()
        ? adjRaw.final_verdict.trim().slice(0, 200)
        : baseline.adjudication.final_verdict,
      explanation: typeof adjRaw.explanation === 'string' && adjRaw.explanation.trim()
        ? adjRaw.explanation.trim().slice(0, 1000)
        : baseline.adjudication.explanation,
    },
    recommendation: baseline.recommendation,
  };
}

async function callExplainerLlm(
  config: ScopeDriftLlmConfig,
  system: string,
  user: string,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXPLAIN_TIMEOUT_MS);
  try {
    if (config.provider === 'openai') {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.model || 'gpt-4o-mini',
          max_tokens: 2048,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(await response.text().catch(() => 'OpenAI error'));
      }
      const data = await response.json() as { choices: Array<{ message: { content: string } }> };
      return data.choices?.[0]?.message?.content || '{}';
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': config.apiKey,
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.model || 'claude-sonnet-4-20250514',
        max_tokens: 2048,
        system,
        messages: [{ role: 'user', content: user }],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(await response.text().catch(() => 'Anthropic error'));
    }
    const data = await response.json() as { content: Array<{ type: string; text: string }> };
    return data.content?.find(c => c.type === 'text')?.text || '{}';
  } finally {
    clearTimeout(timer);
  }
}

/** Build PR analysis from review artifacts when caller omits structured analysis. */
export function buildPrAnalysisFromReview(args: {
  driftMatrix?: TyneScopeDriftMatrix;
  diff?: string;
  changedFiles?: Array<{ path: string }>;
}): ScopeDriftPrAnalysis {
  const matrix = args.driftMatrix;
  const snippets = extractEvidenceSnippets(args.diff || '', lockedItems(matrix));
  return {
    added_functionality: strList(matrix?.developer_additions),
    removed_functionality: inferRemovedFromDiff(args.diff || ''),
    modified_behavior: strList(matrix?.ticket_requirements),
    diff_excerpt: (args.diff || '').slice(0, 12_000),
    drift_matrix: matrix,
    evidence_snippets: snippets,
  };
}

function inferRemovedFromDiff(diff: string): string[] {
  const removed: string[] = [];
  for (const line of diff.split(/\r?\n/)) {
    if (!line.startsWith('-') || line.startsWith('---')) continue;
    const t = line.slice(1).trim();
    if (/^(export )?(async )?function /.test(t)) {
      removed.push(`Removed: ${t.slice(0, 80)}`);
    }
  }
  return removed.slice(0, 8);
}

function extractEvidenceSnippets(
  diff: string,
  keywords: string[],
): Array<{ file: string; line?: number; snippet: string }> {
  if (!diff.trim() || !keywords.length) return [];
  const out: Array<{ file: string; line?: number; snippet: string }> = [];
  let file = '';
  let line = 0;
  const keys = keywords.map(k => k.toLowerCase().split(/\s+/)[0]).filter(k => k.length > 3);

  for (const raw of diff.split(/\r?\n/)) {
    const fm = raw.match(/^\+\+\+\s+b\/(.+)$/);
    if (fm) { file = fm[1]; continue; }
    const hunk = raw.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)/);
    if (hunk) { line = Number(hunk[1]) || 0; continue; }
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      const text = raw.slice(1);
      if (keys.some(k => text.toLowerCase().includes(k))) {
        out.push({ file: file || 'unknown', line: line || undefined, snippet: text.trim().slice(0, 160) });
      }
      line++;
    } else if (!raw.startsWith('-')) {
      line++;
    }
  }
  return out.slice(0, 6);
}

/**
 * Explain scope drift for developers — LLM polishes prose; adjudication stays matrix-anchored.
 */
export async function explainScopeDrift(
  task: ScopeDriftTaskInput,
  prAnalysis: ScopeDriftPrAnalysis,
  llm?: ScopeDriftLlmConfig,
): Promise<ScopeDriftExplanation> {
  const baseline = buildDeterministicExplanation(task, prAnalysis);
  if (!llm?.apiKey) return baseline;

  try {
    const prompt = buildExplainPrompt(task, prAnalysis, baseline);
    const text = await callExplainerLlm(llm, prompt.system, prompt.user);
    return mergeLlmExplanation(baseline, parseJsonObject(text));
  } catch {
    return baseline;
  }
}
