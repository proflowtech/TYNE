/**
 * Real AST facts via TypeScript compiler API (already a project dependency).
 * Used for .ts/.tsx/.js/.jsx when Tree-Sitter grammars are unavailable.
 */

import * as ts from 'typescript';
import type { ExportFact, FunctionFact, ImportFact, SourceLanguage } from './astFacts';

export interface SignatureFact {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'const';
  signature: string;
  line: number;
}

export function extractTsCompilerFacts(
  filePath: string,
  content: string,
  language: SourceLanguage,
): {
  functions: FunctionFact[];
  imports: ImportFact[];
  exports: ExportFact[];
  signatures: SignatureFact[];
} | null {
  if (language !== 'typescript' && language !== 'javascript') return null;
  try {
    const kind = /\.tsx$/i.test(filePath) ? ts.ScriptKind.TSX
      : /\.jsx$/i.test(filePath) ? ts.ScriptKind.JSX
        : language === 'javascript' ? ts.ScriptKind.JS
          : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, kind);
    const functions: FunctionFact[] = [];
    const imports: ImportFact[] = [];
    const exports: ExportFact[] = [];
    const signatures: SignatureFact[] = [];
    const lines = content.split(/\r?\n/);

    const pushFn = (name: string, node: ts.Node) => {
      const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
      functions.push({
        name,
        startLine: start,
        endLine: end,
        body: lines.slice(start - 1, end).join('\n').slice(0, 4000),
        language,
      });
    };

    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name) {
        pushFn(node.name.text, node);
        const sig = node.name.text + (node.parameters ? `(${node.parameters.map(p => p.getText(sf)).join(', ')})` : '()');
        signatures.push({ name: node.name.text, kind: 'function', signature: sig.slice(0, 240), line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
        if (node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
          exports.push({ name: node.name.text, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
        }
      } else if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name)) continue;
          if (decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
            pushFn(decl.name.text, decl);
            signatures.push({
              name: decl.name.text,
              kind: 'const',
              signature: decl.getText(sf).split('\n')[0].slice(0, 240),
              line: sf.getLineAndCharacterOfPosition(decl.getStart(sf)).line + 1,
            });
          }
        }
        if (node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
          for (const decl of node.declarationList.declarations) {
            if (ts.isIdentifier(decl.name)) {
              exports.push({ name: decl.name.text, line: sf.getLineAndCharacterOfPosition(decl.getStart(sf)).line + 1 });
            }
          }
        }
      } else if (ts.isClassDeclaration(node) && node.name) {
        pushFn(node.name.text, node);
        signatures.push({ name: node.name.text, kind: 'class', signature: `class ${node.name.text}`, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
        if (node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
          exports.push({ name: node.name.text, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
        }
      } else if (ts.isInterfaceDeclaration(node)) {
        signatures.push({
          name: node.name.text,
          kind: 'interface',
          signature: node.getText(sf).split('\n').slice(0, 8).join(' ').slice(0, 300),
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        });
        if (node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
          exports.push({ name: node.name.text, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
        }
      } else if (ts.isTypeAliasDeclaration(node)) {
        signatures.push({
          name: node.name.text,
          kind: 'type',
          signature: node.getText(sf).split('\n')[0].slice(0, 240),
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        });
        if (node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
          exports.push({ name: node.name.text, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
        }
      } else if (ts.isImportDeclaration(node)) {
        const mod = (node.moduleSpecifier as ts.StringLiteral).text;
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        imports.push({ raw: node.getText(sf).split('\n')[0].slice(0, 200), module: mod, line, language });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return {
      functions: functions.slice(0, 40),
      imports: imports.slice(0, 80),
      exports: exports.slice(0, 40),
      signatures: signatures.slice(0, 40),
    };
  } catch {
    return null;
  }
}
