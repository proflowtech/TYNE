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

/** Match only authorship metadata — never code diffs (those mention Cursor/Claude constantly in this repo). */
const AI_RULES: Array<{ id: string; label: string; pattern: RegExp }> = [
  { id: 'claude', label: 'Claude', pattern: /co-authored-by:\s*claude\b|claude\.ai|noreply@anthropic\.com|generated with claude/i },
  { id: 'chatgpt', label: 'ChatGPT', pattern: /co-authored-by:\s*(chatgpt|gpt)\b|noreply@openai\.com|generated with (chatgpt|gpt)/i },
  { id: 'cursor', label: 'Cursor', pattern: /co-authored-by:\s*cursor\b|cursoragent@cursor\.com|generated with cursor|cursor\.com\/agent/i },
  { id: 'copilot', label: 'Copilot', pattern: /co-authored-by:\s*copilot\b|copilot@github\.com|generated with (github )?copilot/i },
  { id: 'gemini', label: 'Gemini', pattern: /co-authored-by:\s*(gemini|bard)\b|generated with gemini/i },
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

/**
 * Build contributor shares from authorship metadata only (author + commit message).
 * Never pass a code diff here — product source mentioning "Cursor" must not become a contributor.
 */
export function contributionFromAuthorship(input: {
  totalLines: number;
  authorName: string;
  authorEmail?: string;
  commitMessage?: string;
}): ReviewContributorShare[] {
  const totalLines = Math.max(1, input.totalLines);
  const humanName = (input.authorName || 'You').trim() || 'You';
  const metaText = [humanName, input.authorEmail || '', input.commitMessage || ''].join('\n');
  const aiIds = detectAiLabels(metaText);
  const authorIsAi = AI_RULES.some(rule => rule.pattern.test(`${humanName}\n${input.authorEmail || ''}`));
  const rows: Array<{ id: string; label: string; kind: 'human' | 'ai'; lines: number }> = [];

  if (authorIsAi) {
    const id = detectAiLabels(`${humanName}\n${input.authorEmail || ''}`)[0] || aiIds[0] || 'cursor';
    rows.push({ id, label: labelFor(id, humanName), kind: 'ai', lines: totalLines });
  } else if (!aiIds.length) {
    rows.push({ id: 'user', label: humanName, kind: 'human', lines: totalLines });
  } else {
    // Split reviewed lines across the human author and each detected AI co-author trailer.
    const parts = 1 + aiIds.length;
    const share = Math.max(1, Math.floor(totalLines / parts));
    rows.push({ id: 'user', label: humanName, kind: 'human', lines: Math.max(1, totalLines - share * aiIds.length) });
    for (const id of aiIds) {
      rows.push({ id, label: labelFor(id, id), kind: 'ai', lines: share });
    }
  }

  return normalizeShares(rows);
}

/** Git authorship for the reviewed change: human user vs detected AI co-authors. */
export async function computeContributionBreakdown(
  editedCode: LastEditedCodeContext,
): Promise<ReviewContributorShare[]> {
  const totalLines = Math.max(
    1,
    (editedCode.changedFiles || []).reduce((sum, file) => sum + Math.max(file.additions || 0, 1), 0),
  );
  const { getGit } = await import('./gitManager');
  const git = getGit();
  let authorName = 'You';
  let authorEmail = '';
  let commitMessage = '';

  if (git) {
    try {
      const configured = (await git.raw(['config', 'user.name'])).trim();
      if (configured) { authorName = configured; }
      authorEmail = (await git.raw(['config', 'user.email'])).trim();
    } catch { /* keep default */ }

    // Commit scopes: use that commit's author/message. Staged/unstaged stay on local git user.
    if (editedCode.headSha && (editedCode.scope === 'last_commit' || editedCode.scope === 'selected_commit')) {
      try {
        const show = await git.show(['-s', '--format=%an%n%ae%n%B', editedCode.headSha]);
        const lines = show.split('\n');
        const author = lines[0]?.trim();
        const email = lines[1]?.trim();
        if (author) { authorName = author; }
        if (email) { authorEmail = email; }
        commitMessage = lines.slice(2).join('\n');
      } catch { /* keep defaults */ }
    }
  }

  return contributionFromAuthorship({ totalLines, authorName, authorEmail, commitMessage });
}

export function computeLanguageBreakdownFromChangedFiles(files: ChangedFileInfo[]): ReviewLanguageShare[] {
  return computeLanguageBreakdown(files.map(file => ({ path: file.path, additions: file.additions, deletions: file.deletions })));
}
