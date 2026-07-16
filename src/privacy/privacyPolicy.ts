/** Privacy policy types and defaults for Validate & Review. */

export type PrivacyMode = 'cloud' | 'privacy_enhanced' | 'local_compliance';

export type DataResidency = 'us' | 'eu' | 'local_only' | 'enterprise_managed';

export type SourceProcessingType = 'cloud' | 'sanitized_cloud' | 'local';

export interface PrivacySettings {
  privacyMode: PrivacyMode;
  dataResidency: DataResidency;
  /** When true, skip persisting evidence snippets server-side (edge honors this). */
  evidencePersistenceDisabled: boolean;
}

export const DEFAULT_PRIVACY_SETTINGS: PrivacySettings = {
  privacyMode: 'cloud',
  dataResidency: 'us',
  evidencePersistenceDisabled: false,
};

export function normalizePrivacyMode(value: unknown): PrivacyMode {
  const raw = String(value || '').toLowerCase().replace(/\s+/g, '_');
  if (raw === 'privacy_enhanced' || raw === 'privacy-enhanced') return 'privacy_enhanced';
  if (raw === 'local_compliance' || raw === 'local-compliance' || raw === 'local') return 'local_compliance';
  return 'cloud';
}

export function normalizeDataResidency(value: unknown): DataResidency {
  const raw = String(value || '').toLowerCase().replace(/\s+/g, '_');
  if (raw === 'eu') return 'eu';
  if (raw === 'local_only' || raw === 'local') return 'local_only';
  if (raw === 'enterprise_managed' || raw === 'enterprise') return 'enterprise_managed';
  return 'us';
}

export function privacyModeLabel(mode: PrivacyMode): string {
  if (mode === 'privacy_enhanced') return 'Privacy Enhanced';
  if (mode === 'local_compliance') return 'Local Compliance';
  return 'Cloud Review';
}

export function sourceProcessingForMode(mode: PrivacyMode): SourceProcessingType {
  if (mode === 'local_compliance') return 'local';
  if (mode === 'privacy_enhanced') return 'sanitized_cloud';
  return 'cloud';
}

export type LlmExecutionPath = 'managed' | 'direct_byok' | 'local';

export function dataResidencyLabel(residency: DataResidency): string {
  if (residency === 'eu') return 'EU';
  if (residency === 'local_only') return 'Local Only';
  if (residency === 'enterprise_managed') return 'Enterprise Managed';
  return 'US';
}
