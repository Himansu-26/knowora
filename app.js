const $ = id => document.getElementById(id);
let sb, session, lastQuiz = null;

(async () => {
  try {
    const response = await fetch('/api/config');
    if (!response.ok) throw new Error('The server could not load its configuration.');
    const c = await response.json();
    if (!c.configured) {
      $('amsg').textContent = 'Set up Supabase in .env to enable sign-in. See README.md for setup steps.';
      $('in').disabled = $('up').disabled = true;
      return;
    }
    if (!window.supabase?.createClient) throw new Error('The sign-in service did not load. Check your internet connection and reload.');
    sb = window.supabase.createClient(c.url, c.anon);
    const { data, error } = await sb.auth.getSession();
    if (error) throw error;
    setSession(data.session);
    sb.auth.onAuthStateChange((_, s) => setSession(s));
  } catch (error) {
    $('amsg').textContent = error.message || 'Knowora could not connect. Check that the server is running, then reload.';
    $('in').disabled = $('up').disabled = true;
  }
})();

function setSession(s) {
  session = s; $('auth').hidden = !!s; $('out').hidden = !s;
  document.querySelectorAll('.tab').forEach(t => t.hidden = true);
  if (s) show('home');
}
function show(tab) {
  if (!session) return;
  document.querySelectorAll('.tab').forEach(t => t.hidden = t.id !== tab);
  document.querySelectorAll('nav [data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  if (tab === 'history') loadHistory(); if (tab === 'quiz') renderQuiz();
}
document.querySelectorAll('nav [data-tab]').forEach(b => b.onclick = () => show(b.dataset.tab));
$('out').onclick = () => sb.auth.signOut();

async function auth(kind) {
  if (!sb) return;
  const f = kind === 'up' ? sb.auth.signUp : sb.auth.signInWithPassword;
  const { error } = await f.call(sb.auth, { email: $('em').value, password: $('pw').value });
  $('amsg').textContent = error ? error.message : (kind === 'up' ? 'Account created! If asked, confirm your email, then sign in.' : '');
}
$('in').onclick = () => auth('in'); $('up').onclick = () => auth('up');

// resize image to ~1024px JPEG so each photo = one small, fast request
function compress(file) {
  return new Promise((res, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error('This image could not be opened. Try another image.')); };
    img.onload = () => {
      const s = Math.min(1, 1024 / Math.max(img.width, img.height)), cv = document.createElement('canvas');
      cv.width = img.width * s; cv.height = img.height * s; cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(objectUrl);
      const url = cv.toDataURL('image/jpeg', .8); $('prev').src = url; $('prev').hidden = false; res(url.split(',')[1]);
    }; img.src = objectUrl;
  });
}
async function ready() {                                   // handles Render cold start quietly
  for (let i = 0; i < 12; i++) { try { if ((await fetch('/health')).ok) return; } catch {} $('status').textContent = 'Getting Knowora ready…'; await new Promise(r => setTimeout(r, 4000)); }
  throw new Error('Knowora is taking too long to respond. Please try again in a minute.');
}
let busy = false;
async function identify(body) {
  if (!session) { $('status').textContent = 'Please sign in before identifying something.'; return; }
  if (busy) return; busy = true; $('result').innerHTML = ''; $('status').textContent = 'Knowora is looking… 🔍';
  try {
    await ready();
    const r = await fetch('/api/identify', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token }, body: JSON.stringify({ ...body, lang: $('lang').value }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `The server returned an error (${r.status}).`);
    $('status').textContent = j.soft || j.error ? (j.message || j.error) : '';
    if (j.result) render(j.result);
  } catch (error) { $('status').textContent = error.message || 'Connection hiccup. Please tap once more.'; }
  finally { busy = false; }
}
['cam', 'up-file'].forEach(id => $(id).onchange = async e => {
  try { if (e.target.files[0]) await identify({ image: await compress(e.target.files[0]) }); }
  catch (error) { $('status').textContent = error.message; }
  finally { e.target.value = ''; }
});
$('search-form').addEventListener('submit', event => {
  event.preventDefault();
  const t = $('q').value.trim();
  if (!t) { $('q').focus(); return; }
  $('prev').hidden = true;
  identify({ text: t });
});

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function render(r) {
  lastQuiz = r.quiz;
  const itemName = r.name || '';
  const amazonUrl = `https://www.amazon.in/s?${new URLSearchParams({ k: itemName })}`;
  const flipkartUrl = `https://www.flipkart.com/search?${new URLSearchParams({ q: itemName })}`;
  const sec = (t, v) => v ? `<h3>${esc(t)}</h3><p>${esc(v)}</p>` : '';
  const list = (title, items) => Array.isArray(items) && items.length ? `<h3>${title}</h3><ul>${items.map(item => `<li>${esc(item)}</li>`).join('')}</ul>` : '';
  const living = r.living === true;
  const shoppingLinks = !living && r.category !== 'other'
    ? `<h3>Shop online</h3><p>Open search results for ${esc(itemName)}. Prices and availability may vary.</p><div class="row shopping-links"><a class="btn" href="${amazonUrl}" target="_blank" rel="noopener noreferrer" aria-label="Search for ${esc(itemName)} on Amazon India">Open Amazon India</a><a class="btn alt" href="${flipkartUrl}" target="_blank" rel="noopener noreferrer" aria-label="Search for ${esc(itemName)} on Flipkart">Open Flipkart</a></div>`
    : '';
  $('result').innerHTML = `<div class="card"><h2>${esc(r.name)}</h2><span class="tag">${esc(r.category)}</span>
  ${r.living === true ? '<span class="tag">Living</span>' : r.living === false ? '<span class="tag">Non-living</span>' : ''}
  ${r.scientificName ? `<span class="tag"><i>${esc(r.scientificName)}</i></span>` : ''}
  ${r.confidence ? `<span class="tag">${esc(r.confidence)}% sure</span>` : ''}
  <p>${esc(r.summary)}</p><button id="say">🔊 Listen</button>
  ${list('Characteristics', r.characteristics)}
  ${living ? sec('Habitat', r.habitat) : ''}
  ${living ? sec('Food / diet', r.food) : ''}
  ${sec(living ? 'Behaviour' : 'How it works / how to use', r.behaviourOrUse || r.howItWorksOrUse)}
  ${(r.details || []).map(d => sec(d.title, d.text)).join('')}
  ${!living ? sec('Approximate price', r.priceRange) : ''}
  ${r.priceNote ? `<p class="msg">${esc(r.priceNote)}</p>` : ''}
  ${sec(living ? 'Where it lives' : 'Where to find it', r.whereToFind)}
  ${sec('Purchase note', r.purchaseNote)}
  ${list('Interesting facts', r.funFacts)}
  ${r.conservation?.status ? `<h3>Conservation</h3><p><b>${esc(r.conservation.status)}</b> — ${esc(r.conservation.note)}</p>` : ''}
  ${r.similar?.length ? `<h3>Similar</h3>${r.similar.map(s => `<span class="tag">${esc(s)}</span>`).join('')}` : ''}
  ${shoppingLinks}</div>`;
  $('say').onclick = () => { speechSynthesis.cancel(); speechSynthesis.speak(new SpeechSynthesisUtterance(r.name + '. ' + r.summary)); };
}
async function loadHistory() {
  try {
    const response = await fetch('/api/history', { headers: { Authorization: 'Bearer ' + session.access_token } });
    const j = await response.json();
    if (!response.ok) throw new Error(j.error || 'Could not load history.');
    $('hlist').innerHTML = j.items.length ? '' : '<p class="msg">Nothing yet.</p>';
  j.items.forEach(i => { const d = document.createElement('div'); d.className = 'card'; d.innerHTML = `<b>${esc(i.name)}</b> <span class="tag">${esc(i.category)}</span>`; d.onclick = () => { show('home'); render(i.result); }; $('hlist').append(d); });
  } catch (error) {
    $('hlist').innerHTML = `<p class="msg">${esc(error.message || 'Could not load history.')}</p>`;
  }
}
function renderQuiz() {
  const q = lastQuiz; if (!q) return;
  $('qbox').innerHTML = `<h3>${esc(q.question)}</h3>` + q.options.map((o, i) => `<button class="opt" data-i="${i}">${esc(o)}</button>`).join('') + '<p id="exp" class="msg"></p>';
  $('qbox').querySelectorAll('.opt').forEach(b => b.onclick = () => { const ok = +b.dataset.i === q.answerIndex; b.classList.add(ok ? 'good' : 'bad'); if (!ok) $('qbox').querySelector(`[data-i="${q.answerIndex}"]`).classList.add('good'); $('exp').textContent = q.explanation; });
}
