import { TyneAiProvider, TyneAiProviderAdapter, TyneAiProviderTestResult, TyneValidationInput, TyneValidationResult } from '../validationTypes';
import { buildValidationPrompt, parseValidationResponse } from './validationPrompt';

export function createAnthropicProvider(): TyneAiProviderAdapter {
  return new AnthropicProvider();
}

class AnthropicProvider implements TyneAiProviderAdapter {
  readonly provider: TyneAiProvider = 'anthropic';

  async testConnection(apiKey?: string): Promise<TyneAiProviderTestResult> {
    if (!apiKey) { return { ok: false, error: 'No API key provided.' }; }
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-3-haiku-20240307',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });
      if (response.ok) { return { ok: true }; }
      const errorText = await response.text().catch(() => 'Unknown error');
      return { ok: false, error: `API key could not be verified. Check the key and provider. (${response.status}: ${errorText.slice(0, 120)})` };
    } catch (err: unknown) {
      return { ok: false, error: `Connection failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async validateCode(input: TyneValidationInput, apiKey?: string): Promise<TyneValidationResult> {
    if (!apiKey) { throw new Error('No Anthropic API key provided.'); }
    const prompt = buildValidationPrompt(input);
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`Provider error ${response.status}: ${errorText.slice(0, 200)}`);
    }
    const data = await response.json() as { content: Array<{ type: string; text: string }> };
    const text = data.content?.find(c => c.type === 'text')?.text || '';
    return parseValidationResponse(text, input, this.provider);
  }
}
