/**
 * Path-layer architecture rules on import graph (changed files).
 * # ponytail: convention-based layers from path segments; project can override later.
 */
import type { FileFacts } from './astFacts';
import type { QualityFinding } from './qualityTypes';

type Layer = 'ui' | 'api' | 'domain' | 'data' | 'infra' | 'unknown';

const LAYER_RANK: Record<Layer, number> = {
  ui: 40,
  api: 30,
  domain: 20,
  data: 10,
  infra: 0,
  unknown: 15,
};

export function layerOf(path: string): Layer {
  const p = path.replace(/\\/g, '/').toLowerCase();
  if (/(^|\/)(ui|views|components|pages|webview|media)\//.test(p) || /\.(tsx|jsx|vue|svelte)$/.test(p)) return 'ui';
  if (/(^|\/)(api|routes|controllers|handlers|edge|functions)\//.test(p)) return 'api';
  if (/(^|\/)(domain|model|entities|services)\//.test(p)) return 'domain';
  if (/(^|\/)(db|data|repos|repository|migrations)\//.test(p) || /\.sql$/.test(p)) return 'data';
  if (/(^|\/)(infra|aws|gcp|k8s|terraform|docker)\//.test(p)) return 'infra';
  return 'unknown';
}

export function scanArchitecture(changedFacts: FileFacts[]): QualityFinding[] {
  const findings: QualityFinding[] = [];
  for (const file of changedFacts) {
    const fromLayer = layerOf(file.path);
    if (fromLayer === 'unknown') continue;
    for (const imp of file.imports) {
      if (!imp.module.startsWith('.')) continue;
      // resolve roughly for layer of target path string
      const targetGuess = resolveRelative(file.path, imp.module);
      const toLayer = layerOf(targetGuess);
      if (toLayer === 'unknown') continue;
      // lower layers must not import higher (e.g. data → ui)
      if (LAYER_RANK[fromLayer] < LAYER_RANK[toLayer]) {
        findings.push({
          id: `QUALITY_LAYER:${file.path}:${imp.line}`,
          ruleId: 'QUALITY_LAYER_VIOLATION',
          subcategory: 'layer_violation',
          category: 'maintainability',
          severity: 'high',
          confidence: 'medium',
          title: `Layer violation: ${fromLayer} imports ${toLayer}`,
          explanation: `${file.path} (${fromLayer}) imports ${imp.module} (${toLayer}), which breaks layered boundaries.`,
          file: file.path,
          line: imp.line,
          evidence: imp.raw.slice(0, 200),
          suggestedFix: 'Depend inward/downward only; move shared types to a lower or shared module.',
          detectedBy: 'architecture',
          blocking: fromLayer === 'data' && toLayer === 'ui',
          debtMinutes: 50,
        });
      }
    }
  }
  return findings.slice(0, 16);
}

function resolveRelative(fromFile: string, spec: string): string {
  const parts = fromFile.split('/');
  parts.pop();
  for (const seg of spec.split('/')) {
    if (seg === '.' || !seg) continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}
