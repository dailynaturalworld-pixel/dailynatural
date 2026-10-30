// AI key ki jaanch:  backend folder mein  node scripts/test-ai.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { askAI, provider, aiConfigured } = require('../services/ai');

(async () => {
  console.log('AI provider:', provider());
  if (!aiConfigured()) {
    console.log('❌ Key nahi mili. backend/.env mein GEMINI_API_KEY (ya ANTHROPIC_API_KEY) daaliye.');
    process.exit(1);
  }

  if (provider() === 'gemini') {
    const key = process.env.GEMINI_API_KEY;
    console.log('Key shuru:', key.slice(0, 3) + '...  (lambai ' + key.length + ')');
    console.log('Model:', process.env.GEMINI_MODEL || 'gemini-3.8-flash');
    // 1) Key se kaunse models milte hain
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', {
      headers: { 'x-goog-api-key': key },
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.log(`❌ Models list: ${r.status} ${d?.error?.status || ''} ${d?.error?.message || ''}`);
    } else {
      const flash = (d.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map((m) => m.name.replace('models/', ''))
        .filter((n) => /flash/.test(n));
      console.log('✅ Key chal rahi hai. Flash models:', flash.join(', ') || '(koi nahi)');
    }
  }

  // 2) Chhota sa sawaal
  try {
    const text = await askAI({
      system: 'Reply only with JSON.',
      content: [{ type: 'text', text: 'Return {"ok": true, "fruit": "banana"}' }],
      maxTokens: 200,
    });
    console.log('✅ AI ka jawab:', text.slice(0, 200));
    console.log('Sab theek hai. Ab app mein food scan chalaiye.');
  } catch (e) {
    console.log('❌ AI error:', e.message);
  }
})();
