import type { PrivacyMode, DataResidency, PrivacySettings } from './privacyPolicy';
import {
  DEFAULT_PRIVACY_SETTINGS,
  normalizeDataResidency,
  normalizePrivacyMode,
} from './privacyPolicy';

export interface PrivacySettingsSource {
  privacyMode?: unknown;
  dataResidency?: unknown;
  evidencePersistenceDisabled?: unknown;
}

/** Resolve privacy settings from automation settings (workspaceState). */
export function resolvePrivacySettings(source?: PrivacySettingsSource | null): PrivacySettings {
  if (!source) return { ...DEFAULT_PRIVACY_SETTINGS };
  return {
    privacyMode: normalizePrivacyMode(source.privacyMode),
    dataResidency: normalizeDataResidency(source.dataResidency),
    evidencePersistenceDisabled: source.evidencePersistenceDisabled === true
      || normalizePrivacyMode(source.privacyMode) === 'local_compliance',
  };
}

export function getPrivacyMode(source?: PrivacySettingsSource | null): PrivacyMode {
  return resolvePrivacySettings(source).privacyMode;
}

export function getDataResidency(source?: PrivacySettingsSource | null): DataResidency {
  return resolvePrivacySettings(source).dataResidency;
}

export function allowsByokRelayToBackend(_mode: PrivacyMode): boolean {
  // Phase 3: BYOK never leaves the machine — extension calls the provider directly.
  return false;
}

export function allowsSourceCodeEgress(mode: PrivacyMode): boolean {
  return mode !== 'local_compliance';
}

export function requiresClientRedaction(mode: PrivacyMode): boolean {
  return mode === 'privacy_enhanced' || mode === 'local_compliance';
}
