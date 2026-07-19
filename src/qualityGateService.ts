import * as vscode from 'vscode';
import { getState } from './stateManager';
import {
  TyneValidateReviewResult,
  QualityGateResult,
  QualityGateRuleResult,
  QualityGateType,
  ReviewFindingSeverity,
} from './validateReviewTypes';
import { getTierPolicy } from './reviewGuardrailEngine';

// ── QualityGateService ───────────────────────────────────────────────────────
// Evaluates quality gate rules before commit/push.
// Rules: critical finding, acceptance criteria not met, required test missing,
// secret detected, high vibe-code risk, custom guardrail violated.

export function getQualityGateService(context: vscode.ExtensionContext): QualityGateService {
  return new QualityGateService(context);
}

export class QualityGateService {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async evaluateGate(
    gateType: QualityGateType,
    tier: string,
    branchName: string,
    reviewResult?: TyneValidateReviewResult | null,
  ): Promise<QualityGateResult> {
    const normalizedTier = this._normalizeTier(tier);
    const policy = getTierPolicy(normalizedTier);
    const blocks: QualityGateRuleResult[] = [];
    const warnings: QualityGateRuleResult[] = [];

    // If no review result, only basic checks apply
    if (!reviewResult) {
      if (gateType === 'pre_commit') {
        warnings.push({
          rule: 'no_review',
          passed: false,
          reason: 'No Validate & Review report found. Run a review before committing.',
          severity: 'warn',
        });
      }
      return { passed: warnings.length === 0, gateType, branchName, blocks, warnings, overridden: false };
    }

    // Rule 1: Critical finding exists → BLOCK
    const criticalFindings = reviewResult.findings.filter(f => f.severity === 'critical');
    if (criticalFindings.length > 0) {
      blocks.push({
        rule: 'critical_finding',
        passed: false,
        reason: `${criticalFindings.length} critical finding(s): ${criticalFindings.map(f => f.title).slice(0, 3).join(', ')}`,
        severity: 'block',
      });
    }

    // Rule 2: High severity findings → WARN
    const highFindings = reviewResult.findings.filter(f => f.severity === 'high');
    if (highFindings.length > 0) {
      warnings.push({
        rule: 'high_finding',
        passed: false,
        reason: `${highFindings.length} high-severity finding(s) unresolved`,
        severity: 'warn',
      });
    }

    // Rule 3: Acceptance criteria not met (PM alignment) — Pro/Max only
    if (policy.pmAlignmentEnabled && reviewResult.pendingGoals) {
      const unmetCriteria = reviewResult.pendingGoals.filter(g => g.priority === 'high');
      if (unmetCriteria.length > 0) {
        blocks.push({
          rule: 'acceptance_criteria_not_met',
          passed: false,
          reason: `${unmetCriteria.length} high-priority pending goal(s): ${unmetCriteria.map(g => g.title).slice(0, 3).join(', ')}`,
          severity: 'block',
        });
      }
    }

    // Rule 4: Required test missing → WARN (block for Max with custom guardrails)
    if (policy.missingTestReviewEnabled && reviewResult.missingTests && reviewResult.missingTests.length > 0) {
      const testRule: QualityGateRuleResult = {
        rule: 'required_test_missing',
        passed: false,
        reason: `${reviewResult.missingTests.length} missing test(s): ${reviewResult.missingTests.map(t => t.title).slice(0, 3).join(', ')}`,
        severity: policy.customGuardrailsEnabled ? 'block' : 'warn',
      };
      if (testRule.severity === 'block') {
        blocks.push(testRule);
      } else {
        warnings.push(testRule);
      }
    }

    // Rule 5: Secret detected → BLOCK
    const secretFindings = reviewResult.findings.filter(f => f.category === 'security' && f.severity === 'critical');
    if (secretFindings.length > 0) {
      blocks.push({
        rule: 'secret_detected',
        passed: false,
        reason: `Potential secret/security issue detected: ${secretFindings.map(f => f.title).join(', ')}`,
        severity: 'block',
      });
    }

    // Rule 6: High vibe-code risk → WARN (block for Max)
    if (reviewResult.vibeCodeRisk === 'high') {
      const vibeRule: QualityGateRuleResult = {
        rule: 'high_vibe_code_risk',
        passed: false,
        reason: 'High vibe-code risk detected. Review for AI-generated mistakes before committing.',
        severity: policy.customGuardrailsEnabled ? 'block' : 'warn',
      };
      if (vibeRule.severity === 'block') {
        blocks.push(vibeRule);
      } else {
        warnings.push(vibeRule);
      }
    }

    // Rule 6b: Low quality score / high debt minutes → WARN
    if (typeof reviewResult.qualityScore === 'number' && reviewResult.qualityScore < 65) {
      warnings.push({
        rule: 'low_quality_score',
        passed: false,
        reason: `Code quality score is ${reviewResult.qualityScore}/100. Address maintainability and vibe findings.`,
        severity: 'warn',
      });
    }
    if (typeof reviewResult.debtMinutes === 'number' && reviewResult.debtMinutes >= 90) {
      warnings.push({
        rule: 'high_tech_debt',
        passed: false,
        reason: `Estimated ${reviewResult.debtMinutes} minutes of new technical debt in this change.`,
        severity: 'warn',
      });
    }

    // Rule 7: Custom guardrail violated (Max only)
    if (policy.customGuardrailsEnabled) {
      const guardrailFindings = reviewResult.findings.filter(f => f.category === 'breaking_change');
      if (guardrailFindings.length > 0) {
        blocks.push({
          rule: 'custom_guardrail_violated',
          passed: false,
          reason: `Custom guardrail violation: ${guardrailFindings.map(f => f.title).join(', ')}`,
          severity: 'block',
        });
      }
    }

    // Rule 8: Review status is "blocked" → BLOCK
    if (reviewResult.status === 'blocked') {
      blocks.push({
        rule: 'review_blocked',
        passed: false,
        reason: 'Review status is "blocked". Resolve issues before committing.',
        severity: 'block',
      });
    }

    // Rule 9: Security status is "blocked" or blocking security findings → BLOCK
    const securityFindings = (reviewResult as any).securityFindings || [];
    const blockingSecurity = securityFindings.filter((f: any) =>
      f.confidence !== 'low' && (f.blocking === true || f.severity === 'critical' || (f.severity === 'high' && f.confidence === 'high'))
    );
    if ((reviewResult as any).securityStatus === 'blocked' || blockingSecurity.length > 0) {
      const topSecurity = blockingSecurity.slice(0, 2).map((f: any) => f.title).join('; ');
      blocks.push({
        rule: 'security_blocked',
        passed: false,
        reason: `Security gate: ${blockingSecurity.length} blocking security finding${blockingSecurity.length === 1 ? '' : 's'}${topSecurity ? ` (${topSecurity})` : ''}. Fix before committing.`,
        severity: 'block',
      });
    }

    // Rule 10: Compliance hard-block cannot be overridden by PM/score
    const complianceFindings = (reviewResult as any).complianceFindings
      || reviewResult.findings.filter(f => f.category === 'compliance');
    const complianceStatus = (reviewResult as any).complianceStatus;
    const blockingCompliance = complianceFindings.filter((f: any) =>
      f.confidence !== 'low' && (
        f.severity === 'critical' ||
        (f.severity === 'high' && f.confidence === 'high') ||
        (f.blocking === true && (f.severity === 'critical' || f.severity === 'high'))
      )
    );
    if (complianceStatus === 'blocked' || blockingCompliance.length > 0) {
      blocks.push({
        rule: 'compliance_blocked',
        passed: false,
        reason: 'Compliance assessment blocked this change. Resolve critical/high-confidence compliance findings before committing.',
        severity: 'block',
      });
    }

    const passed = blocks.length === 0;
    return { passed, gateType, branchName, blocks, warnings, overridden: false };
  }

  shouldHardBlock(result: QualityGateResult): boolean {
    return result.blocks.length > 0;
  }

  formatGateMessage(result: QualityGateResult): string {
    const lines: string[] = [];
    if (result.blocks.length > 0) {
      lines.push('BLOCKED — resolve these issues before committing:');
      for (const b of result.blocks) {
        lines.push(`  ✗ ${b.reason}`);
      }
    }
    if (result.warnings.length > 0) {
      lines.push('Warnings:');
      for (const w of result.warnings) {
        lines.push(`  ⚠ ${w.reason}`);
      }
    }
    return lines.join('\n');
  }

  private _normalizeTier(tier: string): 'free' | 'pro' | 'max' {
    const t = tier.toLowerCase();
    if (t === 'pro') return 'pro';
    if (t === 'max') return 'max';
    return 'free';
  }
}
