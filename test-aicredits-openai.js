"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const openai_1 = __importDefault(require("openai"));
const dotenv = __importStar(require("dotenv"));
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
const client = new openai_1.default({ apiKey, baseURL });
const MODELS = {
    free: {
        id: process.env.MODEL_FREE ?? 'deepseek/deepseek-chat',
        name: 'Deepseek Chat',
        input_price: 0.14,
        output_price: 0.28,
    },
    pro: {
        id: process.env.MODEL_PRO ?? 'kimi/qwen-plus',
        name: 'Kimi Code',
        input_price: 0.008,
        output_price: 0.032,
    },
    max: {
        id: process.env.MODEL_MAX ?? 'anthropic/claude-3-5-haiku-20241022',
        name: 'Claude Haiku',
        input_price: 0.80,
        output_price: 4.00,
    },
};
function calculateCostUSD(inputTokens, outputTokens, inputPrice, outputPrice) {
    return (inputTokens * inputPrice + outputTokens * outputPrice) / 1000000;
}
function printCost(costUSD) {
    console.log(`Cost (USD): $${costUSD.toFixed(8)}`);
    console.log(`Cost (INR): ₹${(costUSD * 85).toFixed(4)}`);
}
async function runTest(tier, testNum, goal, code, maxTokens = 300) {
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
        const costUSD = calculateCostUSD(usage.prompt_tokens, usage.completion_tokens, model.input_price, model.output_price);
        console.log('✅ Response received!');
        console.log('Input tokens :', usage.prompt_tokens);
        console.log('Output tokens:', usage.completion_tokens);
        printCost(costUSD);
        console.log('Model response:', content.substring(0, 300));
        return { success: true, cost: costUSD };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('❌ Error:', message);
        return { success: false, cost: 0 };
    }
}
async function main() {
    console.log('\n' + '═'.repeat(52));
    console.log('  AICREDITS + OPENAI SDK TEST');
    console.log('═'.repeat(52));
    console.log('API Key :', `${apiKey.substring(0, 10)}...`);
    console.log('Base URL:', baseURL);
    console.log('SDK     : OpenAI (AICredits is OpenAI-compatible)');
    console.log('═'.repeat(52));
    const test1 = await runTest('free', 1, 'Add email validation to login form', `const validateEmail = (email) => {
  return /^[^@]+@[^@]+\\.[^@]+$/.test(email);
};`);
    const test2 = await runTest('pro', 2, 'Parse JSON with error handling', `const parseJSON = (jsonStr) => {
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    return { error: e.message };
  }
};`);
    const test3 = await runTest('max', 3, 'Implement user authentication with JWT', `const jwt = require("jsonwebtoken");

function generateToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET);
}

function verifyToken(token) {
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch (e) {
    return null;
  }
}`, 500);
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
    }
    else {
        console.log('❌ Some tests failed — check API key and model IDs in .env');
        process.exit(1);
    }
}
main();
//# sourceMappingURL=test-aicredits-openai.js.map