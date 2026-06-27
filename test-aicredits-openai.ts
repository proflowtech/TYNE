import OpenAI from 'openai';
import * as dotenv from 'dotenv';

dotenv.config();

const apiKey = process.env.AICREDITS_API_KEY;
const baseURL = process.env.AICREDITS_BASE_URL;

if (!apiKey || apiKey === 'sk-your-api-key-here') {
  console.error('❌ AICREDITS_API_KEY is not set in .env');
  process.exit(1);
}
if (!baseURL) {
  console.error('❌ AICREDITS_BASE_URL is not set in .env');
  process.exit(1);
}

const client = new OpenAI({ apiKey, baseURL });

interface ModelConfig {
  id: string;
  name: string;
  input_price: number;
  output_price: number;
}

const MODELS: Record<'free' | 'pro' | 'max', ModelConfig> = {
  free: {
    id: process.env.MODEL_FREE ?? 'deepseek/deepseek-chat',
    name: 'Deepseek Chat',
    input_price: 0.14,
    output_price: 0.28,
  },
  pro: {
    id: process.env.MODEL_PRO ?? 'google/gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    input_price: 0.008,
    output_price: 0.032,
  },
  max: {
    id: process.env.MODEL_MAX ?? 'anthropic/claude-haiku-4.5',
    name: 'Claude 3.5 Haiku',
    input_price: 0.80,
    output_price: 4.00,
  },
};

interface TestResult {
  success: boolean;
  cost: number;
}

function calculateCostUSD(
  inputTokens: number,
  outputTokens: number,
  inputPrice: number,
  outputPrice: number,
): number {
  return (inputTokens * inputPrice + outputTokens * outputPrice) / 1_000_000;
}

function printCost(costUSD: number): void {
  console.log(`Cost (USD): $${costUSD.toFixed(8)}`);
  console.log(`Cost (INR): ₹${(costUSD * 85).toFixed(4)}`);
}

async function runTest(
  tier: 'free' | 'pro' | 'max',
  testNum: number,
  goal: string,
  code: string,
  maxTokens = 300,
): Promise<TestResult> {
  const model = MODELS[tier];
  console.log(`\n${'━'.repeat(52)}`);
  console.log(`TEST ${testNum}: ${model.name.toUpperCase()} (${tier.toUpperCase()} TIER)`);
  console.log('━'.repeat(52));
  console.log('Model ID:', model.id);
  console.log('SDK: OpenAI (AICredits Gateway)');
  console.log('Waiting for response...\n');

  const prompt = tier === 'max'
    ? `Goal: ${goal}\n\nCode:\n\`\`\`\n${code}\n\`\`\`\n\nDoes this code accomplish the goal?\nRespond in JSON: { "status": "PASS|FAIL|PARTIAL", "explanation": "...", "risk": "LOW|MEDIUM|HIGH", "details": "..." }`
    : `Goal: ${goal}\n\nCode:\n\`\`\`\n${code}\n\`\`\`\n\nDoes this code accomplish the goal?\nRespond in JSON: { "status": "PASS|FAIL|PARTIAL", "explanation": "..." }`;

  try {
    const response = await client.chat.completions.create({
      model: model.id,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    });

    const content = response.choices[0]?.message?.content ?? '';
    const usage = response.usage;

    if (!usage) {
      throw new Error('No usage data returned — check model ID or API key');
    }

    const costUSD = calculateCostUSD(
      usage.prompt_tokens,
      usage.completion_tokens,
      model.input_price,
      model.output_price,
    );

    console.log('✅ Response received!');
    console.log('Input tokens :', usage.prompt_tokens);
    console.log('Output tokens:', usage.completion_tokens);
    printCost(costUSD);
    console.log('Model response:', content.substring(0, 300));

    return { success: true, cost: costUSD };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('❌ Error:', message);
    return { success: false, cost: 0 };
  }
}

async function main(): Promise<void> {
  console.log('\n' + '═'.repeat(52));
  console.log('  AICREDITS + OPENAI SDK TEST');
  console.log('═'.repeat(52));
  console.log('API Key :', `${apiKey!.substring(0, 10)}...`);
  console.log('Base URL:', baseURL);
  console.log('SDK     : OpenAI (AICredits is OpenAI-compatible)');
  console.log('═'.repeat(52));

  const test1 = await runTest(
    'free', 1,
    'Add email validation to login form',
    `const validateEmail = (email) => {
  return /^[^@]+@[^@]+\\.[^@]+$/.test(email);
};`,
  );

  const test2 = await runTest(
    'pro', 2,
    'Parse JSON with error handling',
    `const parseJSON = (jsonStr) => {
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    return { error: e.message };
  }
};`,
  );

  const test3 = await runTest(
    'max', 3,
    'Implement user authentication with JWT',
    `const jwt = require("jsonwebtoken");

function generateToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET);
}

function verifyToken(token) {
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch (e) {
    return null;
  }
}`,
    500,
  );

  const totalCost = test1.cost + test2.cost + test3.cost;

  console.log('\n' + '═'.repeat(52));
  console.log('  TEST SUMMARY');
  console.log('═'.repeat(52));
  console.log('Test 1 (Deepseek):', test1.success ? '✅ PASS' : '❌ FAIL');
  console.log('Test 2 (Kimi)    :', test2.success ? '✅ PASS' : '❌ FAIL');
  console.log('Test 3 (Claude)  :', test3.success ? '✅ PASS' : '❌ FAIL');
  console.log('─'.repeat(52));
  console.log(`Total Cost: $${totalCost.toFixed(8)} (~₹${(totalCost * 85).toFixed(4)})`);
  console.log('═'.repeat(52));

  if (test1.success && test2.success && test3.success) {
    console.log('✅ ALL TESTS PASSED!');
    console.log('✅ OpenAI SDK works with AICredits!');
    console.log('✅ Ready to deploy to Supabase!');
    process.exit(0);
  } else {
    console.log('❌ Some tests failed — check API key and model IDs in .env');
    process.exit(1);
  }
}

main();
