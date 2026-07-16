/**
 * Data residency routing for Validate & Review (Phase 3).
 * # ponytail: EU/enterprise URLs are config-driven; default to primary supabaseUrl when unset.
 */
import type { DataResidency, PrivacyMode } from './privacyPolicy';

export interface ResidencyEndpointConfig {
  supabaseUrl: string;
  /** Optional EU-region Supabase project URL. */
  supabaseUrlEu?: string;
  /** Self-hosted / enterprise-managed Validate & Review base URL (…/functions/v1 or full function URL). */
  enterpriseEndpoint?: string;
}

/** local_only forces on-device processing (same egress rules as local_compliance). */
export function effectivePrivacyMode(mode: PrivacyMode, residency: DataResidency): PrivacyMode {
  if (residency === 'local_only') return 'local_compliance';
  return mode;
}

export function resolveValidateReviewBaseUrl(
  residency: DataResidency,
  config: ResidencyEndpointConfig,
): string {
  const primary = String(config.supabaseUrl || '').replace(/\/+$/, '');
  if (residency === 'enterprise_managed') {
    const enterprise = String(config.enterpriseEndpoint || '').replace(/\/+$/, '');
    if (enterprise) return enterprise;
    return primary;
  }
  if (residency === 'eu') {
    const eu = String(config.supabaseUrlEu || '').replace(/\/+$/, '');
    if (eu) return eu;
    return primary;
  }
  // us | local_only — local_only still persists aggregates to primary project
  return primary;
}

/** Build full function URL; accepts base project URL or a path already ending in tyne-validate-review. */
export function resolveValidateReviewFunctionUrl(
  residency: DataResidency,
  config: ResidencyEndpointConfig,
): string {
  const base = resolveValidateReviewBaseUrl(residency, config);
  if (/\/tyne-validate-review\/?$/.test(base)) return base.replace(/\/+$/, '');
  if (/\/functions\/v1\/?$/.test(base)) return `${base.replace(/\/+$/, '')}/tyne-validate-review`;
  return `${base}/functions/v1/tyne-validate-review`;
}

export type LlmExecutionPath = 'managed' | 'direct_byok' | 'local';

export function describeResidency(residency: DataResidency): string {
  if (residency === 'eu') return 'EU';
  if (residency === 'local_only') return 'Local Only';
  if (residency === 'enterprise_managed') return 'Enterprise Managed';
  return 'US';
}
