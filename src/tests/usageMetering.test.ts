import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '../..');
const migration = readFileSync(join(root, 'supabase/migrations/20260726144304_harden_usage_metering_and_tier_source.sql'), 'utf8');
const validateReview = readFileSync(join(root, 'supabase/functions/tyne-validate-review/index.ts'), 'utf8');
const story = readFileSync(join(root, 'supabase/functions/tyne-story-decompose/index.ts'), 'utf8');
const pmIntel = readFileSync(join(root, 'supabase/functions/pm-task-intelligence/index.ts'), 'utf8');
const pmVal = readFileSync(join(root, 'supabase/functions/pm-task-validation/index.ts'), 'utf8');
const usage = readFileSync(join(root, 'supabase/functions/usage/index.ts'), 'utf8');

describe('usage metering hardening', () => {
  it('initializes current_cnt and allows managed event names', () => {
    assert.match(migration, /current_cnt := COALESCE\(current_cnt, 0\)/);
    assert.match(migration, /combined_validate_review/);
    assert.match(migration, /story_decomposition/);
    assert.match(migration, /event_type = 'combined_validate_review'/);
    assert.match(migration, /record_usage_atomic\(uid, 'combined_validate_review'/);
  });

  it('fails closed when metering RPC is missing or denied', () => {
    assert.match(validateReview, /usageResult\.allowed !== true/);
    assert.match(story, /usageCheck\.allowed !== true/);
    assert.match(pmIntel, /usageCheck\?\.allowed !== true/);
    assert.match(pmIntel, /isMax/);
  });

  it('meters Core Direct BYOK against the combined validation quota', () => {
    assert.match(validateReview, /mustMeter = isManaged \|\| policy\.tier === 'free'/);
    assert.match(validateReview, /5 Core validations/);
  });

  it('treats BYOK as payload-proven only (no client path bypass)', () => {
    assert.match(validateReview, /const isDirectByok = Boolean\(clientAiReview\)/);
    assert.doesNotMatch(
      validateReview,
      /isDirectByok = Boolean\(clientAiReview\) \|\| llmExecutionPath === 'direct_byok'/,
    );
    assert.match(validateReview, /direct_byok requires clientAiReview/);
  });

  it('derives tier from user_profiles, not request body', () => {
    assert.match(story, /tier: profile\.tier/);
    assert.doesNotMatch(story, /body\?\.tier/);
    assert.match(pmIntel, /const tier = profile\.tier/);
    assert.doesNotMatch(pmIntel, /body\?\.tier/);
    assert.match(pmVal, /const tier = profile\.tier/);
    assert.doesNotMatch(pmVal, /body\?\.tier/);
  });

  it('usage endpoint accepts Supabase JWT or GitHub token', () => {
    assert.match(usage, /supabase\.auth\.getUser\(token\)/);
    assert.match(usage, /api\.github\.com\/user/);
  });
});
