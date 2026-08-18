#!/usr/bin/env node
/**
 * After a successful extension compile/package, insert one row into public.changelog.
 *
 * Existing schema (do not invent columns):
 *   id uuid PK
 *   title text NOT NULL
 *   version text
 *   description text
 *   is_published boolean default true
 *   created_at timestamptz
 *   published_at timestamptz
 *
 * Soft-fails (warn, exit 0) when secrets are missing or the network insert fails,
 * so local contributors without service-role access are not blocked.
 *
 * Usage: node scripts/record-changelog.mjs [compile|package|vsix|release]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const event = String(process.argv[2] || 'compile').toLowerCase();
const allowed = new Set(['compile', 'package', 'vsix', 'release']);
if (!allowed.has(event)) {
  console.error(`record-changelog: unknown event "${event}" (use compile|package|vsix|release)`);
  process.exit(1);
}

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

loadEnvFile(join(root, '.env'));
loadEnvFile(join(root, '.env.local'));

const url = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
if (!url || !key || key === 'replace-me') {
  console.warn('record-changelog: skipped (set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to record builds)');
  process.exit(0);
}

function jwtRole(token) {
  try {
    const part = String(token).split('.')[1];
    if (!part) return '';
    return String(JSON.parse(Buffer.from(part, 'base64url').toString()).role || '');
  } catch {
    return '';
  }
}

const role = jwtRole(key);
if (role && role !== 'service_role') {
  console.warn(
    `record-changelog: skipped (SUPABASE_SERVICE_ROLE_KEY is a "${role}" key; need the service_role secret from Supabase → Project Settings → API)`
  );
  process.exit(0);
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = String(pkg.version || '0.0.0');
const packageName = String(pkg.name || 'tyne');

function git(args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

const gitSha = git(['rev-parse', 'HEAD']);
const gitBranch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
const gitSubject = git(['log', '-1', '--pretty=%s']);
const dirty = Boolean(git(['status', '--porcelain']));

function changelogSectionFor(ver) {
  try {
    const md = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
    const escaped = ver.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = md.match(new RegExp(`## \\[${escaped}\\][\\s\\S]*?(?=\\n## \\[|$)`));
    return match ? match[0].trim() : '';
  } catch {
    return '';
  }
}

const title = `${event}: ${packageName}@${version}`;
const description = [
  changelogSectionFor(version),
  gitSubject && `commit: ${gitSubject}`,
  gitSha && `sha: ${gitSha}`,
  gitBranch && `branch: ${gitBranch}`,
  dirty && 'working tree: dirty',
  `node: ${process.version}`,
  `platform: ${process.platform}/${process.arch}`,
].filter(Boolean).join('\n\n');

// Internal build events stay unpublished; vsix/release can show on public feed.
const isPublished = event === 'vsix' || event === 'release';

const row = {
  title,
  version,
  description,
  is_published: isPublished,
  published_at: isPublished ? new Date().toISOString() : null,
};

try {
  const res = await fetch(`${url}/rest/v1/changelog`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(row),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.warn(`record-changelog: insert failed (${res.status}): ${body.slice(0, 400)}`);
    process.exit(0);
  }

  console.log(`record-changelog: ${title}${gitSha ? ` @ ${gitSha.slice(0, 7)}` : ''}`);
} catch (err) {
  console.warn(`record-changelog: skipped (${err && err.message ? err.message : err})`);
  process.exit(0);
}
