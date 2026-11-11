import express from 'express';
import crypto from 'crypto';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const { GEMINI_API_KEY, GEMINI_MODEL = 'gemini-2.5-flash-lite', SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY, PORT = 3000 } = process.env;
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

const PROMPT = (lang, text) => `You are Knowora, an expert identifier. ${text ? `The user searched: "${text}".` : 'Identify the main thing in the photo.'}
Reply ONLY with JSON in ${lang} (keep keys in English):
{"name":"","scientificName":"","category":"animal|bird|plant|object|technology|other","living":true,"confidence":0-100,
"summary":"2-3 sentences","details":[{"title":"","text":""}],
"howItWorksOrUse":"","funFacts":["","",""],
"priceRange":"approx price with currency, or null","whereToFind":"where it lives (living) or where to buy/find it",
"canBePurchased":true,"purchaseNote":"for living things: legality/ethics of keeping or buying, else null",
"conservation":{"status":"IUCN status or null","note":""},
"similar":["","",""],
"quiz":{"question":"","options":["","","",""],"answerIndex":0,"explanation":""}}
For animals/birds/plants include physical traits, habitat, food, behaviour, wild vs domestic in details. For objects include types and how to use. Never invent shopping URLs.`;

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
    const key = crypto.createHash('sha256').update(`${image || queryText.toLowerCase()}${lang}`).digest('hex');

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
        const j = await r.json();
        if (!r.ok) throw new Error(j.error?.message || `Gemini returned HTTP ${r.status}`);
        result = JSON.parse(j.candidates[0].content.parts[0].text);
        await db.from('cache').upsert({ hash: key, result });
      } catch (e) {
        console.error('AI failed:', e.message);
        result = queryText ? await wikiFallback(queryText) : null;
        if (!result) return res.json({ soft: true, message: 'Knowora could not read this one clearly. Try a closer, well-lit photo, or type its name in search.' });
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
