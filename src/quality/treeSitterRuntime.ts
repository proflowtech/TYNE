/**
 * Optional web-tree-sitter runtime.
 * Loads language WASM from media/tree-sitter/ when present; otherwise callers
 * fall back to TypeScript compiler / regex in astFacts.
 * # ponytail: grammars optional — drop WASM into media/tree-sitter/ to enable.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { SourceLanguage } from './astFacts';

export interface TreeSitterNodeFact {
  type: string;
  name: string;
  startLine: number;
  endLine: number;
  text: string;
}

let initPromise: Promise<boolean> | null = null;
let ParserCtor: any = null;
const languages = new Map<string, any>();

function grammarFile(lang: SourceLanguage): string | null {
  if (lang === 'typescript' || lang === 'javascript') return 'tree-sitter-typescript.wasm';
  if (lang === 'python') return 'tree-sitter-python.wasm';
  if (lang === 'go') return 'tree-sitter-go.wasm';
  return null;
}

function candidateDirs(): string[] {
  const roots = [
    path.join(__dirname, '..', '..', 'media', 'tree-sitter'),
    path.join(__dirname, '..', '..', '..', 'media', 'tree-sitter'),
    path.join(process.cwd(), 'media', 'tree-sitter'),
    path.join(process.cwd(), 'node_modules', 'web-tree-sitter'),
  ];
  return roots;
}

async function ensureInit(): Promise<boolean> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('web-tree-sitter');
      ParserCtor = mod.Parser || mod.default?.Parser || mod.default || mod;
      const wasmPath = candidateDirs()
        .map(d => path.join(d, 'web-tree-sitter.wasm'))
        .find(p => fs.existsSync(p))
        || path.join(process.cwd(), 'node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm');
      if (typeof ParserCtor.init === 'function') {
        await ParserCtor.init({ locateFile: () => wasmPath });
      }
      return true;
    } catch {
      return false;
    }
  })();
  return initPromise;
}

async function loadLanguage(lang: SourceLanguage): Promise<any | null> {
  const file = grammarFile(lang);
  if (!file) return null;
  if (languages.has(file)) return languages.get(file);
  const ok = await ensureInit();
  if (!ok || !ParserCtor?.Language) return null;
  for (const dir of candidateDirs()) {
    const full = path.join(dir, file);
    if (!fs.existsSync(full)) continue;
    try {
      const language = await ParserCtor.Language.load(full);
      languages.set(file, language);
      return language;
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Parse with Tree-Sitter when grammar WASM is present; else null. */
export async function parseWithTreeSitter(
  language: SourceLanguage,
  content: string,
): Promise<TreeSitterNodeFact[] | null> {
  const lang = await loadLanguage(language);
  if (!lang || !ParserCtor) return null;
  try {
    const parser = new ParserCtor();
    parser.setLanguage(lang);
    const tree = parser.parse(String(content || ''));
    const out: TreeSitterNodeFact[] = [];
    const want = new Set([
      'function_declaration', 'function_definition', 'method_definition',
      'arrow_function', 'function_item', 'method_declaration',
      'class_declaration', 'class_definition', 'type_alias_declaration',
      'interface_declaration', 'import_statement', 'import_from_statement',
    ]);
    const walk = (node: any) => {
      if (!node) return;
      if (want.has(node.type)) {
        const nameNode = node.childForFieldName?.('name')
          || node.descendantsOfType?.('identifier')?.[0];
        out.push({
          type: node.type,
          name: nameNode?.text || node.type,
          startLine: (node.startPosition?.row ?? 0) + 1,
          endLine: (node.endPosition?.row ?? 0) + 1,
          text: String(node.text || '').slice(0, 2000),
        });
      }
      for (let i = 0; i < (node.childCount || 0) && out.length < 80; i++) {
        walk(node.child(i));
      }
    };
    walk(tree.rootNode);
    parser.delete?.();
    return out;
  } catch {
    return null;
  }
}

export function treeSitterAvailableSync(): boolean {
  return candidateDirs().some(d =>
    fs.existsSync(path.join(d, 'tree-sitter-typescript.wasm'))
    || fs.existsSync(path.join(d, 'tree-sitter-python.wasm')));
}
