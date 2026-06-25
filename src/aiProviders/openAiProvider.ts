import { TyneAiProvider, TyneAiProviderAdapter, TyneAiProviderTestResult, TyneValidationInput, TyneValidationResult } from '../validationTypes';
import { buildValidationPrompt, parseValidationResponse } from './validationPrompt';

export function createOpenAiProvider(): TyneAiProviderAdapter {
  return new OpenAiProvider();
}

class OpenAiProvider implements TyneAiProviderAdapter {
  readonly provider: TyneAiProvider = 'openai';

  async testConnection(apiKey?: string): Promise<TyneAiProviderTestResult> {
    if (!apiKey) { return { ok: false, error: 'No API key provided.' }; }
    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
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
    if (!apiKey) { throw new Error('No OpenAI API key provided.'); }
    const prompt = buildValidationPrompt(input);
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`Provider error ${response.status}: ${errorText.slice(0, 200)}`);
    }
    const data = await response.json() as { choices: Array<{ message: { content: string } }> };
    const text = data.choices?.[0]?.message?.content || '';
    return parseValidationResponse(text, input, this.provider);
  }
}
