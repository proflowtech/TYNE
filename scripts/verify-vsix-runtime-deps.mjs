#!/usr/bin/env node
/**
 * Fail the build if the VSIX is missing runtime deps that esbuild leaves external.
 * Packaging with `vsce package --no-dependencies` causes infinite Marketplace load.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const vsix = readdirSync(root)
  .filter(f => /^tyne-\d+\.\d+\.\d+\.vsix$/.test(f))
  .sort()
  .at(-1);

if (!vsix) {
  console.error('verify-vsix: no tyne-*.vsix found');
  process.exit(1);
}

const listing = execFileSync('unzip', ['-l', join(root, vsix)], { encoding: 'utf8' });
const required = [
  'extension/node_modules/typescript/package.json',
  'extension/node_modules/web-tree-sitter/package.json',
  'extension/dist/extension.js',
];
const missing = required.filter(path => !listing.includes(path));
if (missing.length) {
  console.error(`verify-vsix: ${vsix} is missing runtime deps:`);
  for (const m of missing) console.error(`  - ${m}`);
  console.error('Do not use `vsce package --no-dependencies` — typescript/web-tree-sitter must ship.');
  process.exit(1);
}
console.log(`verify-vsix: ${vsix} includes typescript + web-tree-sitter`);
