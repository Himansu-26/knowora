import express from 'express';
import crypto from 'crypto';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const { GEMINI_API_KEY, GEMINI_MODEL = 'gemini-3.5-flash-lite', SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY, PORT = 3000 } = process.env;
const hasSupabase = Boolean(
  SUPABASE_URL &&
  SUPABASE_ANON_KEY &&
  SUPABASE_SERVICE_KEY &&
  !SUPABASE_URL.includes('xxxx') &&
  !SUPABASE_ANON_KEY.startsWith('your_') &&
  !SUPABASE_SERVICE_KEY.startsWith('your_')
);
const db = hasSupabase ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;
const app = express();
const appDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = [
  path.join(appDir, 'public'),
  path.join(appDir, 'knowora', 'public')
].find(dir => existsSync(path.join(dir, 'index.html')));
const frontendDir = publicDir || (existsSync(path.join(appDir, 'index.html')) ? appDir : null);
const indexFile = frontendDir ? path.join(frontendDir, 'index.html') : null;
app.use(express.json({ limit: '6mb' }));
if (publicDir) app.use(express.static(publicDir));
if (!publicDir && frontendDir) {
  app.get('/app.js', (_, res) => res.sendFile(path.join(frontendDir, 'app.js')));
  app.get('/style.css', (_, res) => res.sendFile(path.join(frontendDir, 'style.css')));
}
app.get('/', (_, res) => {
  if (indexFile) return res.sendFile(indexFile);
  res.status(503).type('text').send(
    'Knowora frontend files are missing from this deployment. Include public/index.html, public/app.js, and public/style.css in the deployed service.'
  );
});

app.get('/health', (_, res) => res.json({ ok: true, configured: hasSupabase, frontend: Boolean(indexFile) }));
app.get('/api/config', (_, res) => res.json({
  url: hasSupabase ? SUPABASE_URL : null,
  anon: hasSupabase ? SUPABASE_ANON_KEY : null,
  configured: hasSupabase
}));

const PROMPT = (lang, text) => `You are Knowora, a careful visual and text identification assistant. ${text ? `The user searched for: "${text}".` : 'Identify the main visible subject in the photo.'}
Reply with valid JSON only, in ${lang}; keep JSON keys in English. Use this exact shape:
{"name":"","scientificName":null,"category":"animal|bird|plant|object|technology|other","living":null,"confidence":0,
"summary":"A clear, useful 2-3 sentence overview.",
"characteristics":["Visible or defining trait","",""],
"habitat":null,
"food":null,
"behaviourOrUse":"",
"details":[{"title":"","text":""}],
"funFacts":["","",""],
"priceRange":null,
"priceNote":"",
"whereToFind":"",
"canBePurchased":null,
"purchaseNote":"",
"conservation":{"status":null,"note":""},
"similar":["","",""],
"quiz":{"question":"","options":["","","",""],"answerIndex":0,"explanation":""}}
For animals, birds, and plants: include identifying physical characteristics, natural habitat/range, typical food or diet, behavior, and conservation only when known. For objects and technology: describe visible characteristics, common types, how it works or is used, and a realistic approximate price range in Indian rupees only if reasonably known. Mark unknown values null or explain uncertainty; never invent exact current prices, product availability, conservation status, or facts. Give 2-3 genuinely interesting facts. The app creates marketplace search links separately; never provide or invent URLs.`;

async function wikiFallback(q) {
  try {
    const s = await (await fetch(`https://en.wikipedia.org/w/api.php?action=opensearch&limit=1&format=json&search=${encodeURIComponent(q)}`)).json();
    if (!s[1]?.[0]) return null;
    const p = await (await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(s[1][0])}`)).json();
    return { name: p.title, category: 'other', living: null, confidence: 50, summary: p.extract, details: [], funFacts: [], similar: [], fromFallback: true };
  } catch { return null; }
}

app.post('/api/identify', async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Add your Supabase settings to .env before using Knowora.' });
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    const { data: u } = await db.auth.getUser(token);
    if (!u?.user) return res.status(401).json({ error: 'Please sign in again.' });
    const { image, text, lang = 'English' } = req.body || {};
    const queryText = typeof text === 'string' ? text.trim() : '';
    if (!image && !queryText) return res.status(400).json({ error: 'Add a photo or type something to identify.' });
    if (!GEMINI_API_KEY) return res.status(503).json({ error: 'Add your Gemini API key to .env before identifying items.' });
    const key = crypto.createHash('sha256')
      .update(JSON.stringify({ input: image || queryText.toLowerCase(), lang, promptVersion: 2 }))
      .digest('hex');

    let result, cached = await db.from('cache').select('result').eq('hash', key).maybeSingle();
    result = cached.data?.result;

    if (!result) {
      const parts = [{ text: PROMPT(lang, queryText) }];
      if (image) parts.push({ inline_data: { mime_type: 'image/jpeg', data: image } });
      try {
        const ctl = AbortSignal.timeout(40000);
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
          method: 'POST', signal: ctl,
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
          body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseMimeType: 'application/json', temperature: 0.3 } })
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          const error = new Error(j.error?.message || `Gemini returned HTTP ${r.status}`);
          error.status = r.status;
          throw error;
        }
        const answer = j.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('').trim();
        if (!answer) {
          const reason = j.candidates?.[0]?.finishReason;
          throw new Error(reason ? `Gemini returned no answer (${reason}).` : 'Gemini returned an empty answer.');
        }
        result = JSON.parse(answer);
        if (!result.name) throw new Error('Gemini response did not include an identified name.');
        await db.from('cache').upsert({ hash: key, result });
      } catch (e) {
        console.error('AI identification failed:', e.message);
        result = queryText ? await wikiFallback(queryText) : null;
        if (!result) {
          let message = 'The identification service could not process this request. Please try again.';
          const reason = e.message.toLowerCase();
          if (e.status === 401 || e.status === 403 || /api[_ ]key|permission denied/.test(reason)) message = 'Gemini rejected the API key. Check GEMINI_API_KEY in Render settings and confirm the key has API access.';
          else if (e.status === 404 || /model .*not found|unsupported model/.test(reason)) message = 'The Gemini model setting is invalid or unavailable. Check GEMINI_MODEL in Render settings.';
          else if (e.status === 429) message = 'The Gemini API quota or rate limit has been reached. Check the API usage and billing limits, then try again.';
          else if (e.status === 400) message = 'Gemini rejected the request. Check the model and API key settings in Render, then try again.';
          else if (e.name === 'TimeoutError' || e.name === 'AbortError') message = 'Image identification timed out. Try a smaller photo or try again in a moment.';
          else if (e instanceof SyntaxError) message = 'The AI returned an unreadable answer. Please try again.';
          else if (/no answer|empty answer/i.test(e.message)) message = 'The AI could not identify the main subject in that photo. Try a clearer photo with one main subject.';
          return res.status(e.status && e.status >= 400 && e.status < 500 ? e.status : 502).json({ error: message });
        }
      }
    }
    await db.from('identifications').insert({ user_id: u.user.id, query: queryText || 'photo', name: result.name, category: result.category, result });
    res.json({ result });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Something went wrong while identifying this item. Please try again.' });
  }
});

app.get('/api/history', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Add your Supabase settings to .env before using history.' });
  const { data: u } = await db.auth.getUser((req.headers.authorization || '').replace('Bearer ', ''));
  if (!u?.user) return res.status(401).json({ error: 'Please sign in again.' });
  const { data } = await db.from('identifications').select('id,name,category,result,created_at').eq('user_id', u.user.id).order('created_at', { ascending: false }).limit(30);
  res.json({ items: data || [] });
});

app.listen(PORT, () => console.log(`Knowora running at http://localhost:${PORT}`));
