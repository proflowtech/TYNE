#!/usr/bin/env node

const baseUrl = 'https://api.aicredits.in/v1';
const apiKey = (process.env.AICREDITS_API_KEY || '').replace(/\s+/g, '');

if (!apiKey) {
  console.error('AICREDITS_API_KEY is required.');
  process.exit(1);
}

const response = await fetch(`${baseUrl}/models`, {
  method: 'GET',
  headers: {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
  },
});

const text = await response.text();
if (!response.ok) {
  console.error(`AICredits /models failed (${response.status}): ${text.slice(0, 500)}`);
  process.exit(1);
}

let payload;
try {
  payload = JSON.parse(text);
} catch {
  console.error('AICredits /models returned non-JSON response:');
  console.error(text.slice(0, 500));
  process.exit(1);
}

const ids = Array.isArray(payload.data)
  ? payload.data.map((model) => typeof model?.id === 'string' ? model.id : '').filter(Boolean)
  : [];

console.log(JSON.stringify({ event: 'aicredits_supported_models', count: ids.length, modelIds: ids }, null, 2));
