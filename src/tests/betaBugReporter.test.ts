import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (...parts: string[]) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('beta bug reporter opens a sheet from Settings, not a new page/tab', () => {
  const html = read('src', 'sidebar', 'sidebarHtml.ts');
  const host = read('src', 'TyneSidebarProvider.ts')
    + '\n' + read('src', 'sidebar', 'messageRouter.ts');
  const js = read('media', 'tyne.js');
  const css = read('media', 'tyne.css');
  const migration = read('supabase', 'migrations', '20260726100000_beta_bug_reports.sql');
  const edge = read('supabase', 'functions', 'tyne-beta-bug', 'index.ts');
  const service = read('src', 'betaBugService.ts');

  assert.ok(html.includes('id="betaBugFab"'), 'Settings bug CTA must exist');
  assert.ok(html.includes('id="betaBugSheet"'), 'compact sheet form must exist');
  assert.ok(!html.includes('id="betaBugPage"'), 'must not add a dedicated page');
  assert.ok(js.includes("type: 'submitBetaBug'"), 'webview must post submitBetaBug');
  assert.ok(host.includes("case 'submitBetaBug'") && host.includes('betaBug.submit'), 'host must route submitBetaBug to controller');
  assert.ok(js.includes('function openBetaBugSheet'), 'sheet open helper required');
  assert.ok(css.includes('.beta-bug-fab'), 'bug CTA styles required');
  assert.ok(!css.includes('position: fixed;\n  right: 14px;\n  bottom: 14px'), 'must not float a FAB over the sidebar');
  assert.ok(migration.includes('create table if not exists public.beta_bug_reports'), 'migration must create bugs table');
  assert.ok(migration.includes('enable row level security'), 'bugs table must enable RLS');
  assert.ok(read('supabase', 'migrations', '20260726101000_beta_bug_reports_contact.sql').includes('user_email'), 'contact migration must add user_email');
  assert.ok(edge.includes('user_email'), 'edge function must persist user_email');
  assert.ok(edge.includes('github_username'), 'edge function must persist github_username');
  assert.ok(html.includes('id="betaBugEmail"'), 'form must collect reply email');
  assert.ok(service.includes('Add your email so we can follow up'), 'client must require email');
  assert.ok(edge.includes("from('beta_bug_reports')"), 'edge function must insert into beta_bug_reports');
  assert.ok(service.includes('/functions/v1/tyne-beta-bug'), 'client service must call tyne-beta-bug');
  assert.ok(read('supabase', 'config.toml').includes('[functions.tyne-beta-bug]'), 'config.toml must declare the function');
});
