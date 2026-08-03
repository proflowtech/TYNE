/**
 * Token-fingerprint clone detection: changed hunks vs nearby file contents.
 * # ponytail: Jaccard on shingles; not semantic clone detection.
 */
import { changedLinesFromDiff } from './astFacts';
import type { QualityFinding } from './qualityTypes';

function tokenize(text: string): string[] {
  return text
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/#.*$/gm, '')
    .toLowerCase()
    .split(/[^a-z0-9_$]+/)
    .filter(t => t.length > 2);
}

function shingles(tokens: string[], n = 5): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i <= tokens.length - n; i++) {
    set.add(tokens.slice(i, i + n).join(' '));
  }
  return set;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export function detectClones(input: {
  diff: string;
  nearbyContents: Array<{ path: string; content: string }>;
}): QualityFinding[] {
  const byFile = new Map<string, string[]>();
  for (const row of changedLinesFromDiff(input.diff)) {
    const list = byFile.get(row.file) || [];
    list.push(row.text);
    byFile.set(row.file, list);
  }

  const nearby = input.nearbyContents.slice(0, 40);
  const shingleToPaths = new Map<string, Set<string>>();
  const nearbyShingles = new Map<string, Set<string>>();

  for (const near of nearby) {
    const right = shingles(tokenize(near.content || ''));
    nearbyShingles.set(near.path, right);
    for (const sh of right) {
      let bucket = shingleToPaths.get(sh);
      if (!bucket) {
        bucket = new Set();
        shingleToPaths.set(sh, bucket);
      }
      bucket.add(near.path);
    }
  }

  const findings: QualityFinding[] = [];
  for (const [file, addedLines] of [...byFile.entries()].slice(0, 50)) {
    const block = addedLines.join('\n');
    if (block.length < 120) continue;
    const left = shingles(tokenize(block));
    if (left.size < 8) continue;

    const candidates = new Set<string>();
    for (const sh of left) {
      const paths = shingleToPaths.get(sh);
      if (!paths) continue;
      for (const p of paths) {
        if (p !== file) candidates.add(p);
      }
    }

    for (const nearPath of candidates) {
      const right = nearbyShingles.get(nearPath);
      if (!right) continue;
      const score = jaccard(left, right);
      if (score >= 0.55) {
        findings.push({
          id: `QUALITY_CLONE:${file}:${nearPath}`,
          ruleId: 'QUALITY_CLONE',
          subcategory: 'clone',
          category: 'maintainability',
          severity: score >= 0.75 ? 'high' : 'medium',
          confidence: score >= 0.7 ? 'high' : 'medium',
          title: `Duplicated code vs ${nearPath} (${Math.round(score * 100)}% similar)`,
          explanation: 'Changed block closely matches existing nearby code — likely copy-paste.',
          file,
          evidence: `cloneScore=${score.toFixed(2)} nearby=${nearPath}`,
          suggestedFix: `Extract shared helper and reuse from ${nearPath}.`,
          detectedBy: 'clone',
          blocking: false,
          metricValue: Math.round(score * 100),
          debtMinutes: Math.round(30 + score * 40),
          betterPattern: `Reuse existing logic in ${nearPath}`,
        });
      }
    }
  }
  return findings.slice(0, 12);
}
