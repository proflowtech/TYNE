import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { TyneAiProvider, TyneAiProviderTestResult, TyneByokConfig } from './validationTypes';
import { createAnthropicProvider } from './aiProviders/anthropicProvider';
import { createOpenAiProvider } from './aiProviders/openAiProvider';

const SECRET_KEY = {
  anthropic: 'tyne.ai.anthropic.apiKey',
  openai: 'tyne.ai.openai.apiKey',
};

const CONFIG_DIR = '.tyne';
const CONFIG_FILE = 'config.json';

export function getByokKeyService(context: vscode.ExtensionContext): ByokKeyService {
  return new ByokKeyService(context);
}

export class ByokKeyService {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async getSelectedProvider(): Promise<TyneAiProvider | null> {
    const config = await this._loadConfig();
    return config.ai.provider || null;
  }

  async saveApiKey(provider: TyneAiProvider, apiKey: string): Promise<void> {
    if (!apiKey.trim()) {
      throw new Error('API key is required.');
    }
    if (provider !== 'anthropic' && provider !== 'openai') {
      throw new Error('Unsupported provider.');
    }
    const maskedKey = maskKey(apiKey.trim());
    await this.context.secrets.store(SECRET_KEY[provider], apiKey.trim());
    await this._saveConfig({
      ai: {
        provider,
        hasKey: true,
        maskedKey,
        updatedAt: new Date().toISOString(),
      },
    });
  }

  async getApiKey(provider: TyneAiProvider): Promise<string | null> {
    if (provider !== 'anthropic' && provider !== 'openai') { return null; }
    const key = await this.context.secrets.get(SECRET_KEY[provider]);
    return key || null;
  }

  async deleteApiKey(provider: TyneAiProvider): Promise<void> {
    if (provider !== 'anthropic' && provider !== 'openai') { return; }
    await this.context.secrets.delete(SECRET_KEY[provider]);
    const config = await this._loadConfig();
    if (config.ai.provider === provider) {
      await this._saveConfig({
        ai: {
          provider: 'anthropic',
          hasKey: false,
          maskedKey: '',
          updatedAt: new Date().toISOString(),
        },
      });
    }
  }

  async hasApiKey(provider?: TyneAiProvider): Promise<boolean> {
    if (provider) {
      const key = await this.getApiKey(provider);
      return Boolean(key);
    }
    const [anthropic, openai] = await Promise.all([
      this.hasApiKey('anthropic'),
      this.hasApiKey('openai'),
    ]);
    return anthropic || openai;
  }

  async getMaskedKey(provider: TyneAiProvider): Promise<string | null> {
    const config = await this._loadConfig();
    if (config.ai.provider === provider && config.ai.hasKey) {
      return config.ai.maskedKey;
    }
    return null;
  }

  async getConfig(): Promise<TyneByokConfig> {
    return this._loadConfig();
  }

  async testConnection(provider: TyneAiProvider): Promise<TyneAiProviderTestResult> {
    const apiKey = await this.getApiKey(provider);
    if (!apiKey) {
      return { ok: false, error: 'No API key saved for this provider.' };
    }
    const adapter = provider === 'anthropic' ? createAnthropicProvider() : createOpenAiProvider();
    return adapter.testConnection(apiKey);
  }

  async testApiKey(provider: TyneAiProvider): Promise<TyneAiProviderTestResult> {
    return this.testConnection(provider);
  }

  private async _loadConfig(): Promise<TyneByokConfig> {
    const configPath = this._configPath();
    try {
      const raw = await fs.readFile(configPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<TyneByokConfig>;
      return {
        ai: {
          provider: (parsed.ai?.provider as TyneAiProvider) || 'anthropic',
          hasKey: Boolean(parsed.ai?.hasKey),
          maskedKey: parsed.ai?.maskedKey || '',
          updatedAt: parsed.ai?.updatedAt || '',
        },
      };
    } catch {
      return {
        ai: {
          provider: 'anthropic',
          hasKey: false,
          maskedKey: '',
          updatedAt: '',
        },
      };
    }
  }

  private async _saveConfig(config: TyneByokConfig): Promise<void> {
    const configPath = this._configPath();
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
  }

  private _configPath(): string {
    return path.join(os.homedir(), CONFIG_DIR, CONFIG_FILE);
  }
}

export function maskKey(apiKey: string): string {
  if (apiKey.length <= 8) {
    return '*'.repeat(apiKey.length);
  }
  const prefix = apiKey.slice(0, 7);
  const suffix = apiKey.slice(-4);
  return `${prefix}****${suffix}`;
}
