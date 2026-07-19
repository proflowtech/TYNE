/**
 * Acceptance criteria validator — keyword + phrase evidence in changed files.
 * Reuses Jira AC parsing; optional LLM pass for ambiguous criteria (BYOK).
 */
import { extractAcceptanceCriteriaFromText } from '../jiraTextUtils';
import type { TyneAiProvider } from '../validationTypes';

const STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'when', 'then',
  'can', 'must', 'should', 'will', 'user', 'users', 'able', 'using', 'use',
  'all', 'any', 'are', 'was', 'were', 'has', 'have', 'had', 'not', 'but',
  'their', 'they', 'them', 'who', 'what', 'which', 'where', 'how', 'each',
  'ac', 'acceptance', 'criteria', 'criterion',
]);

const GENERIC = new Set(['data', 'code', 'file', 'files', 'page', 'pages', 'item', 'items', 'value', 'values', 'type', 'types']);

export type ACStatus = 'implemented' | 'partial' | 'missing';

export interface ACEvidence {
  file: string;
  lines: number[];
}

export interface ACCriterionResult {
  id: string;
  text: string;
  status: ACStatus;
  implemented: boolean;
  evidence: ACEvidence;
}

export interface ACValidation {
  criteria: ACCriterionResult[];
  missing_criteria: string[];
  extra_deliverables: string[];
  verdict: 'all_ac_met' | 'partial_ac_met' | 'ac_not_validated';
  coverage_score: number;
}

export interface AcValidatorLlmConfig {
  provider: TyneAiProvider;
  apiKey: string;
  model?: string;
}

interface ParsedAc {
  id: string;
  text: string;
}

interface KeywordSet {
  specific: string[];
  all: string[];
  phrases: string[];
}

function normalizeText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Parse AC from description (AC1:, bullets) + explicit array. */
export function parseAcceptanceCriteria(
  taskDescription: string,
  acceptanceCriteria: string[] = [],
): ParsedAc[] {
  const seen = new Set<string>();
  const out: ParsedAc[] = [];
  let n = 0;

  const push = (id: string, text: string) => {
    const t = normalizeText(text);
    if (!t || t.length < 4) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    n += 1;
    out.push({ id: id || `AC${n}`, text: t });
  };

  for (const raw of acceptanceCriteria) {
    const m = String(raw || '').trim().match(/^(AC\s*\d+)\s*[:.)-]\s*(.+)$/i);
    if (m) push(m[1].replace(/\s+/g, ''), m[2]);
    else push('', raw);
  }

  const desc = String(taskDescription || '');
  for (const line of desc.split(/\r?\n/)) {
    const numbered = line.match(/^\s*(?:[-*•]\s*)?(AC\s*(\d+))\s*[:.)-]\s*(.+)$/i);
    if (numbered) {
      push(`AC${numbered[2]}`, numbered[3]);
      continue;
    }
    const acLabel = line.match(/^\s*(?:[-*•]\s*)?Acceptance Criteria\s*(\d*)\s*[:.)-]\s*(.+)$/i);
    if (acLabel) {
      push(acLabel[1] ? `AC${acLabel[1]}` : '', acLabel[2]);
    }
  }

  const section = extractAcceptanceCriteriaFromText(desc);
  for (const c of section.criteria) {
    const inline = c.match(/^(AC\s*\d+)\s*[:.)-]\s*(.+)$/i);
    if (inline) push(inline[1].replace(/\s+/g, ''), inline[2]);
    else push('', c);
  }

  return out.slice(0, 30);
}

function stemToken(w: string): string {
  return w
    .replace(/ing$/i, '')
    .replace(/ed$/i, '')
    .replace(/es$/i, '')
    .replace(/s$/i, '');
}

function extractKeywords(text: string): KeywordSet {
  const lower = text.toLowerCase();
  const phrases: string[] = [];
  const quoted = [...lower.matchAll(/["']([^"']{3,40})["']/g)].map(m => m[1]);
  phrases.push(...quoted);

  const tokens = lower
    .replace(/[^a-z0-9_\s-]/g, ' ')
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t.length >= 3 && !STOP.has(t));

  const specific = tokens.filter(t => t.length >= 4 && !GENERIC.has(t));
  const all = [...new Set(tokens.map(stemToken))];

  // Bigrams from meaningful pairs
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i].length >= 3 && tokens[i + 1].length >= 3) {
      phrases.push(`${tokens[i]} ${tokens[i + 1]}`);
    }
  }

  return {
    specific: [...new Set(specific)],
    all: [...new Set(all)],
    phrases: [...new Set(phrases.map(p => p.trim()).filter(p => p.length >= 5))],
  };
}

function isExportKeywordFalsePositive(line: string, kw: string): boolean {
  if (kw !== 'export' && kw !== 'log') return false;
  if (kw === 'export' && /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|type|interface)\b/.test(line)) {
    return true;
  }
  if (kw === 'log' && /\bconsole\.(log|debug|info)\s*\(/.test(line)) return false;
  return false;
}

function lineMatchesKeyword(line: string, kw: string): boolean {
  if (isExportKeywordFalsePositive(line, kw)) return false;
  const l = line.toLowerCase();
  const k = kw.toLowerCase();
  if (l.includes(k)) return true;
  const stem = stemToken(k);
  if (stem.length >= 4 && l.includes(stem)) return true;
  return false;
}

function searchEvidence(
  keywords: KeywordSet,
  files: Record<string, string>,
  diff: string,
): { status: ACStatus; evidence: ACEvidence; score: number } {
  const hits = new Map<string, Set<number>>();
  let specificHits = 0;
  let genericHits = 0;
  let phraseHit = false;

  const scanLine = (file: string, lineNum: number, content: string) => {
    for (const p of keywords.phrases) {
      if (lineMatchesKeyword(content, p)) phraseHit = true;
    }
    for (const kw of keywords.specific) {
      if (lineMatchesKeyword(content, kw)) {
        specificHits += 1;
        if (!hits.has(file)) hits.set(file, new Set());
        hits.get(file)!.add(lineNum);
      }
    }
    for (const kw of keywords.all) {
      if (keywords.specific.includes(kw)) continue;
      if (lineMatchesKeyword(content, kw)) {
        genericHits += 1;
        if (!hits.has(file)) hits.set(file, new Set());
        hits.get(file)!.add(lineNum);
      }
    }
  };

  for (const [file, content] of Object.entries(files)) {
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      scanLine(file, i + 1, lines[i]);
    }
  }

  // Diff-only fallback (+ lines)
  let diffFile = '';
  let diffLine = 0;
  for (const raw of diff.split(/\r?\n/)) {
    const fm = raw.match(/^\+\+\+\s+b\/(.+)$/);
    if (fm) { diffFile = fm[1]; continue; }
    const hunk = raw.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)/);
    if (hunk) { diffLine = Number(hunk[1]) || 0; continue; }
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      scanLine(diffFile || 'diff', diffLine || 1, raw.slice(1));
      diffLine++;
    } else if (!raw.startsWith('-')) {
      diffLine++;
    }
  }

  let bestFile = '';
  let bestLines: number[] = [];
  for (const [file, lineSet] of hits) {
    const arr = [...lineSet].sort((a, b) => a - b);
    if (arr.length > bestLines.length) {
      bestFile = file;
      bestLines = arr;
    }
  }

  const score = specificHits + genericHits * 0.35 + (phraseHit ? 2 : 0);
  let status: ACStatus = 'missing';
  if (specificHits >= 2 || phraseHit || (specificHits >= 1 && genericHits >= 2)) {
    status = 'implemented';
  } else if (specificHits >= 2 || (specificHits >= 1 && phraseHit)) {
    status = 'partial';
  }

  return {
    status,
    score,
    evidence: { file: bestFile || '(none)', lines: bestLines.slice(0, 12) },
  };
}

function inferExtraDeliverables(
  criteria: ParsedAc[],
  files: Record<string, string>,
  diff: string,
): string[] {
  const acWords = new Set<string>();
  for (const ac of criteria) {
    for (const kw of extractKeywords(ac.text).specific) acWords.add(kw);
  }

  const extras = new Set<string>();
  const scan = (line: string) => {
    const fn = line.match(/(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
    const cls = line.match(/(?:export\s+)?class\s+(\w+)/);
    const name = fn?.[1] || cls?.[1];
    if (!name || name.length < 4) return;
    const parts = name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[_\s]+/);
    const related = parts.some(p => p.length >= 4 && [...acWords].some(w => p.includes(w) || w.includes(p)));
    if (!related) extras.add(name);
  };

  for (const content of Object.values(files)) {
    for (const line of content.split(/\r?\n/)) scan(line);
  }
  for (const raw of diff.split(/\r?\n/)) {
    if (raw.startsWith('+') && !raw.startsWith('+++')) scan(raw.slice(1));
  }
  return [...extras].slice(0, 8);
}

function computeVerdict(results: ACCriterionResult[]): ACValidation['verdict'] {
  if (!results.length) return 'ac_not_validated';
  if (results.every(r => r.status === 'implemented')) return 'all_ac_met';
  return 'partial_ac_met';
}

function computeCoverage(results: ACCriterionResult[]): number {
  if (!results.length) return 0;
  const sum = results.reduce((acc, r) => {
    if (r.status === 'implemented') return acc + 1;
    if (r.status === 'partial') return acc + 0.5;
    return acc;
  }, 0);
  return Math.round((sum / results.length) * 100) / 100;
}

/** Sync core validation (keyword evidence). */
export function validateAcceptanceCriteriaSync(
  taskDescription: string,
  acceptanceCriteria: string[],
  diff: string,
  files: Record<string, string>,
): ACValidation {
  const parsed = parseAcceptanceCriteria(taskDescription, acceptanceCriteria);
  if (!parsed.length) {
    return {
      criteria: [],
      missing_criteria: [],
      extra_deliverables: [],
      verdict: 'ac_not_validated',
      coverage_score: 0,
    };
  }

  const criteria: ACCriterionResult[] = parsed.map(ac => {
    const kw = extractKeywords(ac.text);
    const { status, evidence } = searchEvidence(kw, files, diff);
    return {
      id: ac.id,
      text: ac.text,
      status,
      implemented: status === 'implemented',
      evidence,
    };
  });

  const missing_criteria = criteria
    .filter(c => c.status === 'missing')
    .map(c => c.text);
  const extra_deliverables = inferExtraDeliverables(parsed, files, diff);

  return {
    criteria,
    missing_criteria,
    extra_deliverables,
    verdict: computeVerdict(criteria),
    coverage_score: computeCoverage(criteria),
  };
}

async function llmRefineStatus(
  config: AcValidatorLlmConfig,
  criterion: ACCriterionResult,
  files: Record<string, string>,
): Promise<ACStatus | null> {
  const excerpt = criterion.evidence.file && criterion.evidence.file !== '(none)'
    ? (files[criterion.evidence.file] || '').split(/\r?\n/)
      .filter((_, i) => criterion.evidence.lines.includes(i + 1))
      .join('\n').slice(0, 1200)
    : '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const user = `AC: ${criterion.text}
Current status: ${criterion.status}
Evidence:
${excerpt || '(no line match)'}

Reply JSON only: {"status":"implemented"|"partial"|"missing","reason":"one sentence"}`;
    let text = '{}';
    if (config.provider === 'openai') {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.model || 'gpt-4o-mini',
          max_tokens: 120,
          messages: [{ role: 'user', content: user }],
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const data = await res.json() as { choices: Array<{ message: { content: string } }> };
      text = data.choices?.[0]?.message?.content || '{}';
    } else {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': config.apiKey,
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: config.model || 'claude-haiku-4-5-20251001',
          max_tokens: 120,
          messages: [{ role: 'user', content: user }],
        }),
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const data = await res.json() as { content: Array<{ type: string; text: string }> };
      text = data.content?.find(c => c.type === 'text')?.text || '{}';
    }
    const parsed = JSON.parse(text.replace(/^```json?\s*/i, '').replace(/\s*```$/, '')) as { status?: string };
    if (parsed.status === 'implemented' || parsed.status === 'partial' || parsed.status === 'missing') {
      return parsed.status;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Validate AC against changed code; optional LLM refines partial/missing (BYOK, capped). */
export async function validateAcceptanceCriteria(
  taskDescription: string,
  acceptanceCriteria: string[],
  diff: string,
  files: Record<string, string>,
  llm?: AcValidatorLlmConfig,
): Promise<ACValidation> {
  const base = validateAcceptanceCriteriaSync(taskDescription, acceptanceCriteria, diff, files);
  if (!llm?.apiKey || !base.criteria.length) return base;

  const ambiguous = base.criteria.filter(c => c.status !== 'implemented').slice(0, 3);
  for (const c of ambiguous) {
    const refined = await llmRefineStatus(llm, c, files);
    if (!refined) continue;
    c.status = refined;
    c.implemented = refined === 'implemented';
  }

  return {
    ...base,
    criteria: base.criteria,
    missing_criteria: base.criteria.filter(x => x.status === 'missing').map(x => x.text),
    verdict: computeVerdict(base.criteria),
    coverage_score: computeCoverage(base.criteria),
  };
}

/** Map missing/partial AC to review findings. */
export function acValidationToReviewFindings(v: ACValidation): Array<{
  id: string;
  title: string;
  severity: 'high' | 'medium' | 'low';
  category: 'pm_alignment';
  file: string;
  line?: number;
  explanation: string;
  suggestedFix: string;
  confidence: 'high' | 'medium';
  blocking: boolean;
}> {
  const out: Array<{
    id: string;
    title: string;
    severity: 'high' | 'medium' | 'low';
    category: 'pm_alignment';
    file: string;
    line?: number;
    explanation: string;
    suggestedFix: string;
    confidence: 'high' | 'medium';
    blocking: boolean;
  }> = [];

  for (const c of v.criteria) {
    if (c.status === 'implemented') continue;
    out.push({
      id: `ac_${c.id}`,
      title: c.status === 'missing'
        ? `Missing AC: ${c.id}`
        : `Partial AC: ${c.id}`,
      severity: c.status === 'missing' ? 'high' : 'medium',
      category: 'pm_alignment',
      file: c.evidence.file !== '(none)' ? c.evidence.file : '(scope)',
      line: c.evidence.lines[0],
      explanation: c.text,
      suggestedFix: c.status === 'missing'
        ? `Implement acceptance criterion: ${c.text}`
        : `Complete implementation for: ${c.text}`,
      confidence: c.evidence.lines.length ? 'high' : 'medium',
      blocking: c.status === 'missing',
    });
  }
  return out.slice(0, 12);
}
