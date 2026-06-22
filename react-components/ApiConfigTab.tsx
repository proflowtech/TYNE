import React, { useState } from 'react';
import { useAuth } from './AuthProvider';

// VS Code API acquisition helper (if running inside extension webview)
const getVsCodeApi = () => {
  if (typeof window !== 'undefined' && (window as any).acquireVsCodeApi) {
    return (window as any).acquireVsCodeApi();
  }
  return null;
};

const vscode = getVsCodeApi();

export const ApiConfigTab: React.FC = () => {
  const { profile, loading } = useAuth();
  
  const [provider, setProvider] = useState<'claude' | 'openai'>('claude');
  const [apiKey, setApiKey] = useState('');
  const [overrideByok, setOverrideByok] = useState(false);
  const [saveStatus, setSaveStatus] = useState('No key saved.');

  const userTier = profile?.tier || 'CORE';

  // Save BYOK handler
  const handleSaveKey = () => {
    if (!apiKey.trim()) {
      alert('Please enter an API key.');
      return;
    }
    if (vscode) {
      vscode.postMessage({
        type: 'saveByokKey',
        apiKey: apiKey.trim(),
        provider: provider,
      });
    }
    setSaveStatus('Key saved.');
    setApiKey('');
  };

  const handleUpgradeClick = (e: React.MouseEvent) => {
    e.preventDefault();
    if (vscode) {
      vscode.postMessage({ type: 'openExternal', url: 'https://tyne.proflowtech.io/upgrade' });
    } else {
      window.open('https://tyne.proflowtech.io/upgrade', '_blank');
    }
  };

  const handleOverrideToggle = (e: React.ChangeEvent<HTMLInputElement>) => {
    const checked = e.target.checked;
    setOverrideByok(checked);
    if (vscode) {
      vscode.postMessage({
        type: 'settingChange',
        key: 'aiAccessMode',
        value: checked ? 'byok' : 'max'
      });
    }
  };

  if (loading) {
    return (
      <div style={styles.container}>
        <div style={styles.monoText}>LOADING CONFIGURATION...</div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.label}>API CONFIGURATION</div>

      {/* CORE Plan Config Block */}
      {userTier === 'CORE' && (
        <div>
          <div style={styles.warnNotice}>
            <span style={styles.warnTitle}>[ WARNING ]</span> Free tier requires your own API key.{' '}
            <a href="#" onClick={handleUpgradeClick} style={styles.upgradeLink}>
              [ Upgrade to PRO ]
            </a>{' '}
            to use Tyne's default models.
          </div>

          <div style={styles.field}>
            <label style={styles.fieldLabel}>API PROVIDER</label>
            <div style={styles.modeGrid}>
              <button
                type="button"
                onClick={() => setProvider('claude')}
                style={{ ...styles.modeBtn, ...(provider === 'claude' ? styles.modeBtnActive : {}) }}
              >
                CLAUDE
              </button>
              <button
                type="button"
                onClick={() => setProvider('openai')}
                style={{ ...styles.modeBtn, ...(provider === 'openai' ? styles.modeBtnActive : {}) }}
              >
                OPENAI
              </button>
            </div>
          </div>

          <div style={styles.field}>
            <label style={styles.fieldLabel}>API KEY</label>
            <input
              type="password"
              placeholder="sk-ant-... or sk-..."
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              style={styles.input}
              autoComplete="off"
            />
          </div>

          <button onClick={handleSaveKey} style={styles.primaryBtn}>
            SAVE KEY
          </button>
          <div style={styles.statusText}>{saveStatus}</div>
        </div>
      )}

      {/* PRO & MAX Plan Config Block */}
      {(userTier === 'PRO' || userTier === 'MAX') && (
        <div>
          <div style={styles.goodNotice}>
            ✓ Connected to Tyne Premium Models
          </div>

          {/* Override Checkbox */}
          <div style={styles.overrideRow}>
            <input
              type="checkbox"
              id="overrideByokToggle"
              checked={overrideByok}
              onChange={handleOverrideToggle}
              style={styles.checkbox}
            />
            <label htmlFor="overrideByokToggle" style={styles.checkboxLabel}>
              Override with Custom API Key (BYOK)
            </label>
          </div>

          {/* BYOK Override Section */}
          {overrideByok && (
            <div style={styles.overrideSection}>
              <div style={styles.field}>
                <label style={styles.fieldLabel}>API PROVIDER</label>
                <div style={styles.modeGrid}>
                  <button
                    type="button"
                    onClick={() => setProvider('claude')}
                    style={{ ...styles.modeBtn, ...(provider === 'claude' ? styles.modeBtnActive : {}) }}
                  >
                    CLAUDE
                  </button>
                  <button
                    type="button"
                    onClick={() => setProvider('openai')}
                    style={{ ...styles.modeBtn, ...(provider === 'openai' ? styles.modeBtnActive : {}) }}
                  >
                    OPENAI
                  </button>
                </div>
              </div>

              <div style={styles.field}>
                <label style={styles.fieldLabel}>API KEY</label>
                <input
                  type="password"
                  placeholder="sk-ant-... or sk-..."
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  style={styles.input}
                  autoComplete="off"
                />
              </div>

              <button onClick={handleSaveKey} style={styles.primaryBtn}>
                SAVE KEY
              </button>
              <div style={styles.statusText}>{saveStatus}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// Brutalist Style Tokens (flat, borders, monospace)
const styles = {
  container: {
    padding: '16px',
    backgroundColor: '#000000',
    color: '#ffffff',
    fontFamily: '"JetBrains Mono", "SF Mono", Monaco, Consolas, monospace',
  },
  label: {
    fontSize: '10px',
    letterSpacing: '0.12em',
    color: '#888888',
    marginBottom: '16px',
    fontWeight: 'bold' as const,
  },
  monoText: {
    fontSize: '12px',
    color: '#888888',
  },
  warnNotice: {
    border: '1px solid #E5A33D', // Amber
    padding: '12px',
    marginBottom: '16px',
    fontSize: '11px',
    lineHeight: '1.5',
    color: '#bbbbbb',
  },
  warnTitle: {
    color: '#E5A33D',
    fontWeight: 'bold' as const,
  },
  upgradeLink: {
    color: '#38E54D', // Green
    textDecoration: 'underline',
    cursor: 'pointer',
  },
  goodNotice: {
    border: '1px solid #38E54D', // Green
    padding: '12px',
    marginBottom: '16px',
    fontSize: '12px',
    color: '#38E54D',
  },
  field: {
    marginBottom: '16px',
  },
  fieldLabel: {
    display: 'block',
    fontSize: '10px',
    color: '#888888',
    marginBottom: '6px',
    fontWeight: 'bold' as const,
  },
  modeGrid: {
    display: 'flex',
    gap: '8px',
  },
  modeBtn: {
    flex: 1,
    border: '1px solid rgba(255, 255, 255, 0.12)',
    backgroundColor: 'transparent',
    color: '#888888',
    fontFamily: 'inherit',
    fontSize: '10px',
    padding: '8px 0',
    cursor: 'pointer',
    textAlign: 'center' as const,
    outline: 'none',
  },
  modeBtnActive: {
    borderColor: '#1A56DB', // Bold Blue
    color: '#1A56DB',
  },
  input: {
    width: '100%',
    backgroundColor: '#000000',
    color: '#ffffff',
    border: '1px solid rgba(255, 255, 255, 0.12)',
    padding: '8px 12px',
    fontFamily: 'inherit',
    fontSize: '13px',
    outline: 'none',
    boxSizing: 'border-box' as const,
  },
  primaryBtn: {
    width: '100%',
    backgroundColor: '#1A56DB', // Bold Blue
    color: '#ffffff',
    border: 'none',
    padding: '10px 16px',
    fontFamily: 'inherit',
    fontSize: '12px',
    fontWeight: 'bold' as const,
    cursor: 'pointer',
    textAlign: 'center' as const,
    outline: 'none',
  },
  statusText: {
    fontSize: '11px',
    color: '#888888',
    marginTop: '6px',
  },
  overrideRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    marginBottom: '16px',
  },
  checkbox: {
    margin: 0,
    cursor: 'pointer',
  },
  checkboxLabel: {
    fontSize: '12px',
    color: '#ffffff',
    cursor: 'pointer',
  },
  overrideSection: {
    borderTop: '1px solid rgba(255, 255, 255, 0.12)',
    paddingTop: '16px',
    marginTop: '16px',
  },
};
