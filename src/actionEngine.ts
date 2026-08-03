/**
 * Honesty-first Action Engine: classify remediations so Fix only means applyable patch.
 */

import { isLocatableFindingPath, isSyntheticFindingPath } from './services/findingGrounding';

export type FindingActionClass = 'applyable' | 'agent' | 'guidance';
export type FindingFixKind = 'patch' | 'agent_prompt' | 'guidance';

export interface ActionClassifiableFinding {
  id?: string;
  file?: string;
  line?: number;
  endLine?: number;
  title?: string;
  explanation?: string;
  suggestedFix?: string;
  remediation?: string;
  evidence?: string;
  /** The exact offending code, copied verbatim from the reviewed diff. */
  codeSnippet?: string;
  /** Structured fix payload from the review engine. */
  fix?: { description?: string; diff?: string };
  category?: string;
  severity?: string;
  confidence?: string;
  actionClass?: FindingActionClass;
  fixKind?: FindingFixKind;
  agentPrompt?: string;
  lineVerified?: boolean;
}

export interface FindingActionPartition {
  applyable: Array<ActionClassifiableFinding & ClassifiedAction>;
  agent: Array<ActionClassifiableFinding & ClassifiedAction>;
  guidance: Array<ActionClassifiableFinding & ClassifiedAction>;
}

/** Cap findings in one agent handoff so the prompt stays usable. */
export const BATCH_AGENT_PROMPT_MAX = 30;

const SEVERITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  major: 2,
  medium: 3,
  low: 4,
  info: 5,
  minor: 6,
};

function severityRank(severity?: string): number {
  return SEVERITY_RANK[String(severity || '').toLowerCase()] ?? 50;
}

function truncateBlock(text: string, max = 400): string {
  const t = String(text || '').trim();
  if (t.length <= max) { return t; }
  return t.slice(0, max - 1).trimEnd() + '…';
}

/** Sort critical → minor; stable for equal severity. */
export function sortFindingsBySeverity<T extends { severity?: string }>(findings: T[]): T[] {
  return findings
    .map((f, i) => ({ f, i }))
    .sort((a, b) => severityRank(a.f.severity) - severityRank(b.f.severity) || a.i - b.i)
    .map(({ f }) => f);
}

/** Partition findings by honesty-first action class (re-classifies each). */
export function partitionFindingsByActionClass(
  findings: ActionClassifiableFinding[],
): FindingActionPartition {
  const applyable: FindingActionPartition['applyable'] = [];
  const agent: FindingActionPartition['agent'] = [];
  const guidance: FindingActionPartition['guidance'] = [];
  for (const finding of findings) {
    const classified = classifyFindingAction(finding);
    const merged = { ...finding, ...classified };
    if (classified.actionClass === 'applyable') { applyable.push(merged); }
    else if (classified.actionClass === 'agent') { agent.push(merged); }
    else { guidance.push(merged); }
  }
  return { applyable, agent, guidance };
}

/**
 * One prompt for N agent findings. Caller should pass only agent-class items.
 * Ordered by severity; capped at BATCH_AGENT_PROMPT_MAX.
 */
export function buildBatchAgentPrompt(findings: ActionClassifiableFinding[]): string {
  const sorted = sortFindingsBySeverity(findings.filter(Boolean));
  if (!sorted.length) {
    return 'No Tyne findings were selected to fix.';
  }
  const truncated = sorted.length > BATCH_AGENT_PROMPT_MAX;
  const selected = truncated ? sorted.slice(0, BATCH_AGENT_PROMPT_MAX) : sorted;

  const blocks = selected.map((finding, index) => {
    const file = String(finding.file || '').trim();
    const locatable = isLocatableFindingPath(file) && !isSyntheticFindingPath(file);
    const hasLine = typeof finding.line === 'number' && finding.line > 0;
    const end = hasLine && finding.endLine && finding.endLine > (finding.line || 0)
      ? `-${finding.endLine}`
      : '';
    const id = String(finding.id || `finding-${index + 1}`).trim();
    const title = String(finding.title || 'Finding').trim();
    const category = String(finding.category || '').trim();
    const severity = String(finding.severity || '').trim();
    const explanation = truncateBlock(String(finding.explanation || ''), 280);
    const remediation = truncateBlock(
      String(finding.remediation || finding.suggestedFix || ''),
      320,
    );
    const evidence = truncateBlock(String(finding.codeSnippet || finding.evidence || ''), 400);
    const fixDiff = truncateBlock(String(finding.fix?.diff || ''), 500);
    const location = locatable
      ? (hasLine ? `\`${file}:${finding.line}${end}\`` : `\`${file}\``)
      : 'unpinned — locate from evidence / git diff';

    return [
      `### ${index + 1}. [${id}] ${title}`,
      `- Location: ${location}`,
      severity ? `- Severity: ${severity}` : '',
      category ? `- Category: ${category}` : '',
      explanation ? `- Why: ${explanation}` : '',
      evidence ? `- Evidence:\n\`\`\`\n${evidence}\n\`\`\`` : '',
      fixDiff ? `- Proposed diff:\n\`\`\`diff\n${fixDiff}\n\`\`\`` : '',
      remediation ? `- Direction: ${remediation}` : '',
    ].filter(Boolean).join('\n');
  });

  return [
    `You are fixing ${selected.length} Tyne Validate & Review finding(s) in this workspace.`,
    `Work in the order listed (severity first). Make the smallest correct change for each, match local style, and verify before finishing.`,
    `Only fix the findings listed below — no drive-by refactors. If a line no longer matches the evidence, search the file for the evidence (line numbers may have drifted). If a finding is ambiguous or would require a risky redesign, skip it and say so.`,
    truncated
      ? `Note: ${sorted.length - selected.length} lower-severity finding(s) were omitted from this prompt because of size; fix these first, then ask for the rest.`
      : '',
    ``,
    `## Findings`,
    blocks.join('\n\n'),
    ``,
    `## Required outcome`,
    `1. Fix each finding in order when safe.`,
    `2. After all attempts, briefly report: fixed IDs, skipped IDs (with reason).`,
  ].filter(Boolean).join('\n');
}

export interface ClassifiedAction {
  actionClass: FindingActionClass;
  fixKind: FindingFixKind;
  agentPrompt: string;
  /** Only set when actionClass is applyable; prose is cleared from apply field. */
  suggestedFix?: string;
}

/** True when text looks like drop-in code, not an English advice sentence. */
export function looksLikeCodePatch(text: string): boolean {
  const raw = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!raw) { return false; }

  const fenced = raw.match(/```(?:[\w+-]*)?\n?([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : raw).trim();
  if (!body) { return false; }

  // Sentence-like guidance ending in punctuation → not a patch.
  if (/^[A-Z][\s\S]{6,}[.!?]$/.test(body) && !/[{}`;]|=>/.test(body) && !body.includes('\n')) {
    return false;
  }

  const hasStructure = /[{}]|=>|;|\n\s+\S/.test(body);
  const hasKeyword = /\b(?:const|let|var|function|return|import|export|class|await|async|def|fn|if)\b/.test(body);
  if (hasStructure && hasKeyword) { return true; }
  if (/[{};]|=>/.test(body) && body.includes('\n')) { return true; }
  // Single-line assignment / call that is not a sentence.
  if (/^[a-zA-Z_$][\w$.[\]'"]*\s*[=(]/.test(body) && !/[.!?]$/.test(body)) { return true; }
  return false;
}

export function buildAgentPrompt(finding: ActionClassifiableFinding): string {
  const file = String(finding.file || '').trim();
  const locatable = isLocatableFindingPath(file) && !isSyntheticFindingPath(file);
  const hasLine = typeof finding.line === 'number' && finding.line > 0;
  const end = hasLine && finding.endLine && finding.endLine > (finding.line || 0) ? `-${finding.endLine}` : '';
  const title = String(finding.title || 'Finding').trim();
  const explanation = String(finding.explanation || '').trim();
  const remediation = String(finding.remediation || finding.suggestedFix || '').trim();
  // Regular findings carry the offending code in codeSnippet; evidence is the
  // security-finding field. Use whichever is present.
  const evidence = String(finding.codeSnippet || finding.evidence || '').trim();
  const fixDiff = String(finding.fix?.diff || '').trim();
  const category = String(finding.category || '').trim();

  const locationBullet = locatable
    ? (hasLine
      ? `- File: \`${file}:${finding.line}${end}\``
      : `- File: \`${file}\` (line not verified — search for the evidence below)`)
    : `- Location: not pinned to a concrete file in the reviewed diff. Use the issue title, evidence, and git status — do not invent paths or delete project infrastructure.`;

  const step1 = locatable && hasLine
    ? `1. Open \`${file}\` at line ${finding.line}.${evidence ? ' If that line no longer matches the evidence, search the file for the evidence code — line numbers may have drifted.' : ''}`
    : locatable
      ? `1. Open \`${file}\` and locate the issue using the evidence below (exact line unavailable).`
      : `1. Locate the issue from the title/evidence and the current git diff. Do not create or delete project infrastructure files unless the reviewed diff proves they were deleted.`;

  return [
    `You are fixing a Tyne Validate & Review finding in this workspace.`,
    `Make the smallest correct change, match local style, and verify before finishing.`,
    ``,
    `## Finding`,
    locationBullet,
    category ? `- Category: ${category}` : '',
    `- Issue: ${title}`,
    explanation ? `- Why it matters: ${explanation}` : '',
    evidence ? `\n## Evidence\n\`\`\`\n${evidence}\n\`\`\`` : '',
    fixDiff ? `\n## Proposed fix (unified diff from the review)\n\`\`\`diff\n${fixDiff}\n\`\`\`` : '',
    remediation ? `\n## Suggested direction\n${remediation}` : '',
    ``,
    `## Required outcome`,
    step1,
    `2. Apply a minimal fix for this finding only.`,
    `3. Do not refactor unrelated code.`,
    `4. Confirm the issue is resolved (read the changed lines; run a quick local check if available).`,
  ].filter(Boolean).join('\n');
}

export function classifyFindingAction(finding: ActionClassifiableFinding): ClassifiedAction {
  const category = String(finding.category || '').toLowerCase();
  const confidence = String(finding.confidence || 'medium').toLowerCase();
  const fixText = typeof finding.suggestedFix === 'string' ? finding.suggestedFix : '';
  const agentPrompt = (typeof finding.agentPrompt === 'string' && finding.agentPrompt.trim())
    ? finding.agentPrompt.trim()
    : buildAgentPrompt(finding);

  // Security / compliance: never one-click apply unless already explicitly applyable + code patch.
  const sensitive = category === 'security' || category === 'compliance';
  const locatable = isLocatableFindingPath(finding.file);
  const hasRange = locatable && typeof finding.line === 'number' && finding.line > 0;
  const codeLike = looksLikeCodePatch(fixText);
  const explicitApplyable = finding.actionClass === 'applyable';
  const lineOk = finding.lineVerified !== false;

  if ((explicitApplyable || (!finding.actionClass && codeLike)) && codeLike && hasRange && lineOk && confidence !== 'low' && !sensitive) {
    const patch = fixText.replace(/```(?:[\w+-]*)?\n?([\s\S]*?)```/, (_, inner) => inner).replace(/\r\n/g, '\n').replace(/\n+$/, '');
    return {
      actionClass: 'applyable',
      fixKind: 'patch',
      agentPrompt,
      suggestedFix: patch,
    };
  }

  if (!locatable) {
    return {
      actionClass: 'guidance',
      fixKind: 'guidance',
      agentPrompt: buildAgentPrompt(finding),
      suggestedFix: undefined,
    };
  }

  if (sensitive || category === 'architecture' || finding.actionClass === 'agent') {
    return {
      actionClass: 'agent',
      fixKind: 'agent_prompt',
      agentPrompt,
      suggestedFix: undefined,
    };
  }

  if (fixText.trim() || finding.actionClass === 'guidance') {
    return {
      actionClass: fixText.trim() && !codeLike ? 'guidance' : 'agent',
      fixKind: fixText.trim() && !codeLike ? 'guidance' : 'agent_prompt',
      agentPrompt,
      suggestedFix: undefined,
    };
  }

  return {
    actionClass: 'guidance',
    fixKind: 'guidance',
    agentPrompt,
    suggestedFix: undefined,
  };
}

/** Enrich a finding record in place / return copy with classification fields. */
export function withClassifiedAction<T extends ActionClassifiableFinding>(finding: T): T & ClassifiedAction {
  const classified = classifyFindingAction(finding);
  return {
    ...finding,
    ...classified,
  };
}

export type AutoApplyPolicy = 'applyable_only' | 'never';

export function mayAutoApply(
  finding: ActionClassifiableFinding,
  policy: AutoApplyPolicy = 'applyable_only',
): boolean {
  if (policy === 'never') { return false; }
  const classified = classifyFindingAction(finding);
  if (classified.actionClass !== 'applyable') { return false; }
  const category = String(finding.category || '').toLowerCase();
  if (category === 'security' || category === 'compliance') { return false; }
  return true;
}

export function simpleContentHash(text: string): string {
  let h = 2166136261;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
