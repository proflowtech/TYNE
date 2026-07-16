import type { ChangedFileInfo, LastEditedCodeContext } from './validateReviewTypes';

export interface ReviewLanguageShare {
  language: string;
  percent: number;
  lines: number;
}

export interface ReviewContributorShare {
  id: string;
  label: string;
  kind: 'human' | 'ai';
  percent: number;
  lines: number;
}

const EXT_LANGUAGE: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript',
  js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  py: 'Python', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin',
  cs: 'C#', cpp: 'C++', cc: 'C++', cxx: 'C++', c: 'C', h: 'C/C++ Header', hpp: 'C++',
  rb: 'Ruby', php: 'PHP', swift: 'Swift', sql: 'SQL', pgsql: 'PL/pgSQL',
  css: 'CSS', scss: 'SCSS', less: 'Less', html: 'HTML', vue: 'Vue', svelte: 'Svelte',
  md: 'Markdown', json: 'JSON', yml: 'YAML', yaml: 'YAML', toml: 'TOML',
  sh: 'Shell', bash: 'Shell', zsh: 'Shell', ps1: 'PowerShell',
  dart: 'Dart', lua: 'Lua', r: 'R', scala: 'Scala',
};

const AI_RULES: Array<{ id: string; label: string; pattern: RegExp }> = [
  { id: 'claude', label: 'Claude', pattern: /\bclaude\b|anthropic|claude\.ai|co-authored-by:\s*claude/i },
  { id: 'chatgpt', label: 'ChatGPT', pattern: /\bchatgpt\b|\bgpt-?[45]\b|openai|co-authored-by:\s*chatgpt|co-authored-by:\s*gpt/i },
  { id: 'cursor', label: 'Cursor', pattern: /\bcursor\b|cursoragent@cursor\.com|co-authored-by:\s*cursor/i },
  { id: 'copilot', label: 'Copilot', pattern: /\bcopilot\b|github copilot|co-authored-by:\s*copilot/i },
  { id: 'gemini', label: 'Gemini', pattern: /\bgemini\b|\bbard\b|co-authored-by:\s*gemini/i },
];

export function languageFromPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const base = normalized.split('/').pop() || normalized;
  if (base.endsWith('.sql')) {
    return /(^|\/)supabase\//i.test(normalized) ? 'PL/pgSQL' : 'SQL';
  }
  const ext = base.includes('.') ? base.split('.').pop()!.toLowerCase() : '';
  return EXT_LANGUAGE[ext] || (ext ? ext.toUpperCase() : 'Other');
}

/** Line-weighted language mix from changed files. */
export function computeLanguageBreakdown(
  files: Array<{ file?: string; path?: string; additions?: number; deletions?: number }>,
): ReviewLanguageShare[] {
  const totals = new Map<string, number>();
  for (const file of files || []) {
    const path = String(file.file || file.path || '');
    if (!path) { continue; }
    const weight = Math.max(Number(file.additions) || 0, 1);
    const language = languageFromPath(path);
    totals.set(language, (totals.get(language) || 0) + weight);
  }
  const total = [...totals.values()].reduce((sum, n) => sum + n, 0);
  if (!total) { return []; }
  return [...totals.entries()]
    .map(([language, lines]) => ({
      language,
      lines,
      percent: Math.round((lines / total) * 1000) / 10,
    }))
    .sort((a, b) => b.lines - a.lines)
    .slice(0, 8);
}

function detectAiLabels(text: string): string[] {
  const found: string[] = [];
  for (const rule of AI_RULES) {
    if (rule.pattern.test(text)) { found.push(rule.id); }
  }
  return [...new Set(found)];
}

function labelFor(id: string, fallback: string): string {
  return AI_RULES.find(rule => rule.id === id)?.label || fallback;
}

function normalizeShares(raw: Array<{ id: string; label: string; kind: 'human' | 'ai'; lines: number }>): ReviewContributorShare[] {
  const merged = new Map<string, { id: string; label: string; kind: 'human' | 'ai'; lines: number }>();
  for (const row of raw) {
    if (row.lines <= 0) { continue; }
    const existing = merged.get(row.id);
    if (existing) { existing.lines += row.lines; }
    else { merged.set(row.id, { ...row }); }
  }
  const total = [...merged.values()].reduce((sum, row) => sum + row.lines, 0);
  if (!total) {
    return [];
  }
  return [...merged.values()]
    .map(row => ({
      ...row,
      percent: Math.round((row.lines / total) * 1000) / 10,
    }))
    .sort((a, b) => b.lines - a.lines)
    .slice(0, 6);
}

/** Git authorship for the reviewed change: human user vs detected AI tools. */
export async function computeContributionBreakdown(
  editedCode: LastEditedCodeContext,
): Promise<ReviewContributorShare[]> {
  const totalLines = Math.max(
    1,
    (editedCode.changedFiles || []).reduce((sum, file) => sum + Math.max(file.additions || 0, 1), 0),
  );
  const { getGit } = await import('./gitManager');
  const git = getGit();
  let humanName = 'You';
  let metaText = editedCode.diff || '';

  if (git) {
    try {
      const configured = (await git.raw(['config', 'user.name'])).trim();
      if (configured) { humanName = configured; }
    } catch { /* keep default */ }

    if (editedCode.headSha) {
      try {
        const show = await git.show(['-s', '--format=%an%n%ae%n%B', editedCode.headSha]);
        metaText = `${show}\n${metaText}`;
        const author = show.split('\n')[0]?.trim();
        if (author) { humanName = author; }
      } catch { /* keep defaults */ }
    }
  }

  const aiIds = detectAiLabels(metaText);
  const authorIsAi = AI_RULES.some(rule => rule.pattern.test(humanName));
  const rows: Array<{ id: string; label: string; kind: 'human' | 'ai'; lines: number }> = [];

  if (authorIsAi) {
    const id = detectAiLabels(humanName)[0] || aiIds[0] || 'cursor';
    rows.push({ id, label: labelFor(id, humanName), kind: 'ai', lines: totalLines });
  } else if (!aiIds.length) {
    rows.push({ id: 'user', label: humanName, kind: 'human', lines: totalLines });
  } else {
    // Split reviewed lines across the human author and each detected AI co-author.
    const parts = 1 + aiIds.length;
    const share = Math.max(1, Math.floor(totalLines / parts));
    rows.push({ id: 'user', label: humanName, kind: 'human', lines: totalLines - share * aiIds.length });
    for (const id of aiIds) {
      rows.push({ id, label: labelFor(id, id), kind: 'ai', lines: share });
    }
  }

  return normalizeShares(rows);
}

export function computeLanguageBreakdownFromChangedFiles(files: ChangedFileInfo[]): ReviewLanguageShare[] {
  return computeLanguageBreakdown(files.map(file => ({ path: file.path, additions: file.additions, deletions: file.deletions })));
}
