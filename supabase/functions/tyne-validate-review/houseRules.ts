/**
 * House-rule prompt section — the bridge between `.tyne/learnings.md` and the
 * review model.
 *
 * Split out of `index.ts` so the one part of the house-rules feature that is
 * pure text can be tested directly, the same way `dodo-webhook/decide.ts`
 * separates the money-critical branch from the request handler. Nothing here
 * touches the network, the database, or Deno globals.
 *
 * Everything in `rules` is untrusted client input: it originates in a file in
 * the user's repo, which in a shared repo is attacker-influenceable. Text is
 * therefore coerced, length-capped, count-capped, and wrapped in an
 * `<untrusted_team_rules>` block so the model treats it as data.
 */

export interface TeamRuleInput {
  id?: unknown;
  text?: unknown;
  scope?: unknown;
}

/** Rules beyond this dilute model attention and cost tokens for no gain. */
export const MAX_PROMPT_RULES = 20;
const MAX_ID_CHARS = 8;
const MAX_TEXT_CHARS = 300;
const MAX_SCOPE_CHARS = 120;

/**
 * Render the house-rules block, or `''` when the team has none.
 *
 * The instructions are deliberately strict about attribution: the model must
 * echo the rule id in `ruleId`, because the client drops any finding citing
 * an id that was never sent. Without that round trip a house-rule finding
 * would be indistinguishable from a deterministic engine finding — and these
 * are model judgment, not evidence.
 */
export function buildHouseRuleSection(rules: unknown): string {
  const list = (Array.isArray(rules) ? rules as TeamRuleInput[] : [])
    .slice(0, MAX_PROMPT_RULES)
    .map(rule => ({
      id: String(rule?.id ?? '').slice(0, MAX_ID_CHARS).trim(),
      text: String(rule?.text ?? '').slice(0, MAX_TEXT_CHARS).trim(),
      scope: rule?.scope ? String(rule.scope).slice(0, MAX_SCOPE_CHARS).trim() : '',
    }))
    // A rule with no id cannot be attributed back, and one with no text
    // cannot be checked — either way it is not worth prompt space.
    .filter(rule => rule.id && rule.text);

  if (!list.length) { return ''; }

  const rendered = list
    .map(rule => `- [${rule.id}] ${rule.text}${rule.scope ? ` (applies to: ${rule.scope})` : ''}`)
    .join('\n');

  return `

TEAM HOUSE RULES — conventions this team has chosen to enforce:
<untrusted_team_rules>
${rendered}
</untrusted_team_rules>
Report a violation ONLY when the changed code plainly breaks one of these
rules. When you do:
  - set "ruleId" to the rule's bracketed id exactly (e.g. "HR1")
  - set "category" to "style" or "maintainability"
  - set "confidence" to "medium" or "low" — these are team conventions, not
    defects you can prove
  - quote the offending code in "codeSnippet"
Do not restate a rule as a finding when the code already follows it, and do
not invent rule ids. At most 2 findings per rule.`;
}

// ── Usage telemetry ─────────────────────────────────────────────────────────

export interface HouseRuleUsage {
  ruleHash: string;
  ruleText: string;
  ruleScope: string | null;
  findingsCount: number;
}

/**
 * Stable identity for a rule across reviews.
 *
 * Deliberately NOT the `HR<n>` id: those are assigned per parse and shift the
 * moment anyone edits the file, so a row keyed on them could never be
 * compared across two reviews. Normalized text is the thing that actually
 * stays the same while the file is reordered around it.
 *
 * FNV-1a rather than a crypto hash — this is a grouping key, not a security
 * boundary, and it keeps the function dependency-free.
 */
export function ruleHash(text: string): string {
  const normalized = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  let h = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++) {
    h ^= normalized.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Pair every rule that was sent with how many findings cited it.
 *
 * Rules that produced nothing are returned with `findingsCount: 0` on
 * purpose — "evaluated and never fired" is precisely the signal staleness
 * detection needs, so dropping those rows would defeat the feature.
 */
export function summarizeHouseRuleUsage(
  rules: unknown,
  findings: unknown,
): HouseRuleUsage[] {
  const list = (Array.isArray(rules) ? rules as TeamRuleInput[] : [])
    .slice(0, MAX_PROMPT_RULES)
    .map(rule => ({
      id: String(rule?.id ?? '').trim().toUpperCase(),
      text: String(rule?.text ?? '').trim(),
      scope: rule?.scope ? String(rule.scope).trim() : '',
    }))
    .filter(rule => rule.id && rule.text);
  if (!list.length) { return []; }

  const counts = new Map<string, number>();
  for (const finding of (Array.isArray(findings) ? findings : []) as Array<Record<string, unknown>>) {
    const cited = String(finding?.ruleId ?? '').trim().toUpperCase();
    if (cited) { counts.set(cited, (counts.get(cited) || 0) + 1); }
  }

  return list.map(rule => ({
    ruleHash: ruleHash(rule.text),
    ruleText: rule.text.slice(0, MAX_TEXT_CHARS),
    ruleScope: rule.scope || null,
    findingsCount: counts.get(rule.id) || 0,
  }));
}
