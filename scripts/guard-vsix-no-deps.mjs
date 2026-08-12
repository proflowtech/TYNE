#!/usr/bin/env node
/**
 * Fail if any package script packages with --no-dependencies.
 * That flag strips runtime deps esbuild leaves external (typescript, web-tree-sitter)
 * and caused Marketplace activation hangs in 0.2.2–0.2.3.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
const scripts = pkg.scripts || {};
const offenders = Object.entries(scripts)
  .filter(([, cmd]) => typeof cmd === 'string' && /vsce\s+package[^\n]*--no-dependencies/.test(cmd));
if (offenders.length) {
  console.error('guard-vsix: do not use `vsce package --no-dependencies`:');
  for (const [name, cmd] of offenders) console.error(`  ${name}: ${cmd}`);
  process.exit(1);
}
console.log('guard-vsix: package scripts ok (no --no-dependencies)');
