// AI helper: Google Gemini ya Claude (Anthropic), jo .env mein set ho
// AI_PROVIDER=gemini ya claude. Khaali ho to: GEMINI_API_KEY ho to Gemini, warna Claude.

function provider() {
  const p = String(process.env.AI_PROVIDER || '').trim().toLowerCase();
  if (p === 'gemini' || p === 'claude') return p;
  if (process.env.GEMINI_API_KEY) return 'gemini';
  return 'claude';
}

function aiConfigured() {
  return provider() === 'gemini' ? Boolean(process.env.GEMINI_API_KEY) : Boolean(process.env.ANTHROPIC_API_KEY);
}

function aiName() {
  return provider() === 'gemini' ? 'Google Gemini' : 'Claude (Anthropic)';
}

function fail(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// ---------- Claude ----------
async function viaClaude({ system, content, maxTokens }) {
  const base = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: process.env.AI_MODEL || 'claude-sonnet-5-5',
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content }],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('Claude error:', res.status, data?.error?.message || data);
    throw fail(502, res.status === 401 ? 'AI key is not valid. Check ANTHROPIC_API_KEY.' : 'AI is busy right now. Please try again in a minute.');
  }
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

// ---------- Gemini ----------
// Claude jaisa content ([{type:'image',source:{...}}, {type:'text',text}]) Gemini ke format mein badalna
function toGeminiParts(content) {
  if (typeof content === 'string') return [{ text: content }];
  return (content || []).map((b) => {
    if (b.type === 'image' && b.source?.data) {
      return { inline_data: { mime_type: b.source.media_type || 'image/jpeg', data: b.source.data } };
    }
    return { text: String(b.text || '') };
  });
}

async function geminiCall(model, { system, content, maxTokens }) {
  const base = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';
  const res = await fetch(`${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      contents: [{ role: 'user', parts: toGeminiParts(content) }],
      // Naye Gemini "thinking" bhi tokens khate hain, isliye jagah thodi zyada
      generationConfig: { maxOutputTokens: Math.max(maxTokens, 4096), responseMimeType: 'application/json' },
    }),
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

async function viaGemini(args) {
  const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
  let { res, data } = await geminiCall(model, args);
  // Server busy (500/503) ho to ek baar dobara
  if (res.status === 500 || res.status === 503) {
    await new Promise((r) => setTimeout(r, 1500));
    ({ res, data } = await geminiCall(model, args));
  }
  if (!res.ok) {
    const msg = data?.error?.message || '';
    const reason = data?.error?.status || data?.error?.details?.[0]?.reason || '';
    console.error('Gemini error:', res.status, reason, msg || JSON.stringify(data));
    const short = `(Gemini ${res.status}${reason ? ' ' + reason : ''}: ${msg.slice(0, 140)})`;
    if (res.status === 400 && /api key/i.test(msg)) throw fail(502, `AI key is not valid. Check GEMINI_API_KEY. ${short}`);
    if (res.status === 401 || res.status === 403) throw fail(502, `AI key was refused. Check GEMINI_API_KEY and GEMINI_MODEL. ${short}`);
    if (res.status === 404) throw fail(502, `AI model "${model}" not found. Check GEMINI_MODEL in backend/.env. ${short}`);
    if (res.status === 429) throw fail(502, `AI limit reached for now. Please try again after some time. ${short}`);
    if (res.status === 500 || res.status === 503) throw fail(502, `AI is busy right now. Please try again in a minute. ${short}`);
    throw fail(502, `AI could not answer. ${short}`);
  }
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.map((p) => p.text || '').join('\n').trim();
  if (!text) {
    console.error('Gemini empty answer:', JSON.stringify(data?.promptFeedback || data?.candidates?.[0]?.finishReason || data));
    throw fail(502, 'AI could not read this photo. Please try a clearer photo.');
  }
  return text;
}

async function askAI({ system, content, maxTokens = 1500 }) {
  if (!aiConfigured()) {
    throw fail(503, provider() === 'gemini'
      ? 'AI is not set up yet. Add GEMINI_API_KEY in backend/.env'
      : 'AI is not set up yet. Add GEMINI_API_KEY or ANTHROPIC_API_KEY in backend/.env');
  }
  return provider() === 'gemini' ? viaGemini({ system, content, maxTokens }) : viaClaude({ system, content, maxTokens });
}

// AI ke jawab se JSON nikalna (```json ... ``` ho to bhi)
function parseJson(text) {
  const clean = String(text || '').replace(/```json|```/g, '').trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Bad AI response');
  return JSON.parse(clean.slice(start, end + 1));
}

// askClaude purane naam se bhi chalta rahe
module.exports = { askAI, askClaude: askAI, parseJson, aiConfigured, aiName, provider };
