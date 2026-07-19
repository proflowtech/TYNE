/**
 * Honesty-first Action Engine: classify remediations so Fix only means applyable patch.
 */

export type FindingActionClass = 'applyable' | 'agent' | 'guidance';
export type FindingFixKind = 'patch' | 'agent_prompt' | 'guidance';

export interface ActionClassifiableFinding {
  file?: string;
  line?: number;
  endLine?: number;
  title?: string;
  explanation?: string;
  suggestedFix?: string;
  remediation?: string;
  evidence?: string;
  category?: string;
  confidence?: string;
  actionClass?: FindingActionClass;
  fixKind?: FindingFixKind;
  agentPrompt?: string;
  lineVerified?: boolean;
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
  const file = String(finding.file || 'unknown');
  const line = finding.line && finding.line > 0 ? String(finding.line) : '?';
  const end = finding.endLine && finding.endLine > (finding.line || 0) ? `-${finding.endLine}` : '';
  const title = String(finding.title || 'Finding').trim();
  const explanation = String(finding.explanation || '').trim();
  const remediation = String(finding.remediation || finding.suggestedFix || '').trim();
  const evidence = String(finding.evidence || '').trim();
  const category = String(finding.category || '').trim();

  return [
    `You are fixing a Tyne Validate & Review finding in this workspace.`,
    `Make the smallest correct change, match local style, and verify before finishing.`,
    ``,
    `## Finding`,
    `- File: \`${file}:${line}${end}\``,
    category ? `- Category: ${category}` : '',
    `- Issue: ${title}`,
    explanation ? `- Why it matters: ${explanation}` : '',
    evidence ? `\n## Evidence\n\`\`\`\n${evidence}\n\`\`\`` : '',
    remediation ? `\n## Suggested direction\n${remediation}` : '',
    ``,
    `## Required outcome`,
    `1. Open \`${file}\` at line ${line}.`,
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
  const hasRange = Boolean(finding.file) && typeof finding.line === 'number' && finding.line > 0;
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
