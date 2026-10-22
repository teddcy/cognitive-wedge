// Cognitive Wedge — local server.
// Serves public/, proxies agent calls to the Claude API with YOUR key, stores sessions, documents and artifacts under ./data.
// No dependencies beyond Node 18+.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ---- config ---------------------------------------------------------------
try { // optional .env next to this file: KEY=value lines
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch (e) {}
const PORT = Number(process.env.PORT || 3000);
const KEY = process.env.ANTHROPIC_API_KEY || '';
const MODELS = { // tiers mirror the prototype: default = the agent, quick = the classifier
  default: process.env.MODEL_DEFAULT || 'claude-sonnet-5-5',
  complex: process.env.MODEL_COMPLEX || 'claude-opus-5-5',
  quick:   process.env.MODEL_QUICK   || 'claude-haiku-5-5',
};
const WEB_SEARCH_MAX_USES = Number(process.env.WEB_SEARCH_MAX_USES || 8); // per agent turn; $10 per 1,000 searches
const TEAM_PASSWORD = process.env.TEAM_PASSWORD || '';          // when set, the whole app sits behind this shared password
const MAX_TURNS_PER_SESSION = Number(process.env.MAX_TURNS_PER_SESSION || 400); // agent calls per session; a cost cap
const HOST = process.env.HOST || (process.env.TEAM_PASSWORD || process.env.RAILWAY_ENVIRONMENT || process.env.RENDER ? '0.0.0.0' : '127.0.0.1');
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC = path.join(__dirname, 'public');
fs.mkdirSync(DATA, { recursive: true });

// ---- helpers --------------------------------------------------------------
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readBody = (req, max = 40e6) => new Promise((ok, no) => { const chunks = []; let n = 0; req.on('data', c => { n += c.length; if (n > max) { no(new Error('too large')); req.destroy(); } chunks.push(c); }); req.on('end', () => ok(Buffer.concat(chunks))); req.on('error', no); });
const safeId = id => /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
const crypto = require('crypto');
const authToken = () => crypto.createHmac('sha256', 'cw-auth').update(TEAM_PASSWORD).digest('hex').slice(0, 40);
function authed(req) {
  if (!TEAM_PASSWORD) return true;
  const c = req.headers.cookie || ''; const m = c.match(/(?:^|;\s*)cw_auth=([a-f0-9]+)/);
  return !!m && m[1] === authToken();
}
const turnCounts = new Map(); // session id → agent calls this process lifetime (the session file holds the durable count)
const safeName = n => String(n || 'file').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
const sessionDir = id => path.join(DATA, id);
const sessionFile = id => path.join(DATA, id + '.json');

// ---- documents: stored per session; PDFs go to the API as document blocks, everything else as text
function docMeta(id) { const f = path.join(sessionDir(id), 'documents.json'); try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return []; } }
function saveDocMeta(id, list) { fs.mkdirSync(sessionDir(id), { recursive: true }); fs.writeFileSync(path.join(sessionDir(id), 'documents.json'), JSON.stringify(list, null, 1)); }
function docxToText(file) {
  // .docx is a zip; macOS and Linux ship unzip. Pull the body XML and strip the tags.
  const xml = execFileSync('unzip', ['-p', file, 'word/document.xml'], { maxBuffer: 50e6 }).toString('utf8');
  return xml.replace(/<\/w:p>/g, '\n').replace(/<w:tab\/>/g, '\t').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\n{3,}/g, '\n\n').trim();
}
function documentBlocks(id) {
  const blocks = []; const notes = [];
  for (const d of docMeta(id)) {
    const file = path.join(sessionDir(id), d.stored);
    if (!fs.existsSync(file)) continue;
    if (d.kind === 'pdf') { blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fs.readFileSync(file).toString('base64') }, title: d.name }); notes.push(d.name + ' (PDF, attached as a document)'); }
    else { const text = fs.readFileSync(file, 'utf8').slice(0, 400000); blocks.push({ type: 'text', text: 'DOCUMENT "' + d.name + '" (supplied by the participant):\n\n' + text }); notes.push(d.name + ' (' + text.length + ' chars)'); }
  }
  return { blocks, notes };
}

// ---- Claude API -------------------------------------------------------------
// The page sends a turn list; the leading user turn is the module instruction and becomes the system prompt.
async function sample(req, res, body) {
  if (!KEY) return json(res, 401, { error: 'ANTHROPIC_API_KEY is not set' });
  const turns = Array.isArray(body.turns) ? body.turns : [];
  if (!turns.length) return json(res, 400, { error: 'no turns' });
  let system = '';
  let messages = turns.map(t => ({ role: t.role === 'assistant' ? 'assistant' : 'user', content: String(t.content || '') }));
  if (messages.length > 1 && messages[0].role === 'user') { system = messages[0].content; messages = messages.slice(1); }
  const merged = [];
  for (const m of messages) { const last = merged[merged.length - 1]; if (last && last.role === m.role) last.content += '\n\n' + m.content; else merged.push({ ...m }); }
  if (merged[0] && merged[0].role !== 'user') merged.unshift({ role: 'user', content: '[Begin.]' });

  // Participant documents ride on the first user turn as content blocks (PDFs as documents, text inline).
  const sid = body.session && safeId(body.session);
  if (sid && body.documents) {
    const { blocks } = documentBlocks(sid);
    if (blocks.length) merged[0] = { role: 'user', content: [...blocks, { type: 'text', text: merged[0].content }] };
  }

  if (sid && body.modelTier !== 'quick') {
    let n = 0; try { n = JSON.parse(fs.readFileSync(sessionFile(sid), 'utf8')).turns.filter(t => t.role === 'assistant').length; } catch (e) {}
    if (n >= MAX_TURNS_PER_SESSION) return json(res, 429, { error: 'This session has reached its limit of ' + MAX_TURNS_PER_SESSION + ' agent turns.' });
  }
  const model = MODELS[body.modelTier] || MODELS.default;
  const payload = { model, max_tokens: body.modelTier === 'quick' ? 800 : 6000, stream: true, ...(system ? { system } : {}), messages: merged };
  if (body.webSearch) payload.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: WEB_SEARCH_MAX_USES }];

  const ac = new AbortController();
  req.on('close', () => ac.abort());
  let upstream;
  try {
    upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ac.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(payload),
    });
  } catch (e) { return json(res, 502, { error: 'could not reach the Claude API: ' + e.message }); }
  if (!upstream.ok) { const t = await upstream.text().catch(() => ''); console.error('Claude API', upstream.status, t.slice(0, 300)); return json(res, upstream.status, { error: 'Claude API ' + upstream.status + ': ' + t.slice(0, 500) }); }

  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache', 'x-model': model });
  const reader = upstream.body.getReader(); const dec = new TextDecoder(); let buf = '';
  const sources = new Map(); let searches = 0; let blockType = null;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i; while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = chunk.split('\n').find(l => l.startsWith('data:')); if (!line) continue;
        let ev; try { ev = JSON.parse(line.slice(5)); } catch (e) { continue; }
        if (ev.type === 'content_block_start') {
          blockType = ev.content_block && ev.content_block.type;
          if (blockType === 'server_tool_use') { searches++; res.write('\n[searching…]\n'); }
          if (blockType === 'web_search_tool_result' && Array.isArray(ev.content_block.content)) for (const r of ev.content_block.content) if (r.url) sources.set(r.url, r.title || r.url);
        } else if (ev.type === 'content_block_delta' && ev.delta) {
          if (ev.delta.type === 'text_delta' && ev.delta.text) res.write(ev.delta.text);
          else if (ev.delta.type === 'citations_delta' && ev.delta.citation && ev.delta.citation.url) sources.set(ev.delta.citation.url, ev.delta.citation.title || ev.delta.citation.url);
        } else if (ev.type === 'error') { console.error('API stream error (' + model + '):', JSON.stringify(ev.error)); }
      }
    }
  } catch (e) {} finally {
    if (sources.size) { res.write('\n\nSources (' + searches + ' search' + (searches === 1 ? '' : 'es') + '):\n' + [...sources].map(([u, t]) => '- ' + t + ' — ' + u).join('\n')); }
    res.end();
  }
}

// ---- artifacts: the build's output, saved as a file the participant can download
function saveArtifact(id, body) {
  const dir = path.join(sessionDir(id), 'artifacts'); fs.mkdirSync(dir, { recursive: true });
  const n = fs.readdirSync(dir).filter(f => f.endsWith('.md')).length + 1;
  const base = 'artifact-' + String(n).padStart(2, '0');
  const md = String(body.markdown || '');
  fs.writeFileSync(path.join(dir, base + '.md'), md);
  const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  // small markdown → html: headings, lists, tables, bold, paragraphs
  const html = md.split(/\n{2,}/).map(block => {
    const b = block.trim(); if (!b) return '';
    if (/^\|.*\|$/m.test(b)) { const rows = b.split('\n').filter(r => r.trim().startsWith('|') && !/^\|[\s:|-]+\|$/.test(r.trim())); return '<table>' + rows.map((r, i) => '<tr>' + r.trim().slice(1, -1).split('|').map(c => (i ? '<td>' : '<th>') + inline(c.trim()) + (i ? '</td>' : '</th>')).join('') + '</tr>').join('') + '</table>'; }
    const h = b.match(/^(#{1,4})\s+(.*)$/); if (h && !b.includes('\n')) return '<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>';
    if (/^(\d+\.|[-*])\s/.test(b)) { const ol = /^\d+\./.test(b); return (ol ? '<ol>' : '<ul>') + b.split('\n').map(l => '<li>' + inline(l.replace(/^(\d+\.|[-*])\s+/, '')) + '</li>').join('') + (ol ? '</ol>' : '</ul>'); }
    return '<p>' + inline(b).replace(/\n/g, '<br>') + '</p>';
  }).join('\n');
  function inline(s) { return esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\*(.+?)\*/g, '<i>$1</i>').replace(/`(.+?)`/g, '<code>$1</code>'); }
  const title = (md.match(/^#\s+(.*)$/m) || [, 'Artifact'])[1];
  fs.writeFileSync(path.join(dir, base + '.html'), '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(title) + '</title><style>body{font:16px/1.55 Georgia,serif;max-width:72ch;margin:40px auto;padding:0 20px;color:#1b2320}table{border-collapse:collapse;margin:1em 0}td,th{border:1px solid #ccd;padding:6px 10px;text-align:left;vertical-align:top}h1,h2,h3{font-family:system-ui,sans-serif;line-height:1.2}code{font-family:Menlo,monospace;font-size:.9em}</style></head><body>' + html + '</body></html>');
  return { id: base, title, md: '/api/session/' + id + '/artifacts/' + base + '.md', html: '/api/session/' + id + '/artifacts/' + base + '.html', words: md.split(/\s+/).filter(Boolean).length, saved_at: new Date().toISOString() };
}

function loginPage(bad) {
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cognitive Wedge</title><style>body{font-family:system-ui,sans-serif;background:#F5F7F5;color:#1B2320;display:grid;place-items:center;min-height:100vh;margin:0}form{background:#fff;border:1px solid #D7DDD8;border-radius:10px;padding:28px;width:min(90vw,340px)}h1{font:500 22px Georgia,serif;margin:0 0 14px}input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #D7DDD8;border-radius:6px;font-size:16px;margin:6px 0 12px}button{width:100%;padding:10px;background:#1E5E5A;color:#fff;border:0;border-radius:6px;font-size:15px}p{color:#9A2E2E;font-size:13px;margin:0 0 8px}</style></head><body><form method="post" action="/login"><h1>Cognitive Wedge</h1>' + (bad ? '<p>That password was not right.</p>' : '') + '<label>Team password<input type="password" name="password" autofocus required></label><button>Enter</button></form></body></html>';
}

// ---- static ---------------------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8' };
function sendFile(res, file, download) {
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  const h = { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' };
  if (download) h['content-disposition'] = 'attachment; filename="' + path.basename(file) + '"';
  res.writeHead(200, h); fs.createReadStream(file).pipe(res);
}
function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(404); return res.end('not found'); }
  sendFile(res, file);
}

// ---- router ---------------------------------------------------------------
http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x'); const P = url.pathname;
    if (P === '/login' && req.method === 'POST') {
      const body = (await readBody(req, 1e5)).toString('utf8'); const pw = decodeURIComponent((body.match(/(?:^|&)password=([^&]*)/) || [, ''])[1].replace(/\+/g, ' '));
      if (TEAM_PASSWORD && pw === TEAM_PASSWORD) { res.writeHead(302, { 'set-cookie': 'cw_auth=' + authToken() + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000', location: '/' }); return res.end(); }
      res.writeHead(302, { location: '/login?bad=1' }); return res.end();
    }
    if (P === '/login' || !authed(req)) {
      if (P.startsWith('/api/')) return json(res, 401, { error: 'sign in first' });
      res.writeHead(TEAM_PASSWORD ? 200 : 302, TEAM_PASSWORD ? { 'content-type': 'text/html; charset=utf-8' } : { location: '/' });
      return res.end(TEAM_PASSWORD ? loginPage(url.searchParams.has('bad')) : '');
    }
    if (P === '/api/health') return json(res, 200, { ok: true, keySet: !!KEY, models: MODELS, webSearchMaxUses: WEB_SEARCH_MAX_USES });
    if (P === '/api/sample' && req.method === 'POST') return sample(req, res, JSON.parse((await readBody(req, 5e6)).toString('utf8') || '{}'));
    if (P === '/api/sessions') return json(res, 200, fs.readdirSync(DATA).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)));
    let m;
    if ((m = P.match(/^\/api\/session\/([^/]+)$/))) {
      const id = safeId(m[1]); if (!id) return json(res, 400, { error: 'bad id' });
      if (req.method === 'GET') return sendFile(res, sessionFile(id));
      if (req.method === 'PUT') { const body = (await readBody(req, 20e6)).toString('utf8'); JSON.parse(body); fs.writeFileSync(sessionFile(id), body); return json(res, 200, { ok: true }); }
    }
    if ((m = P.match(/^\/api\/session\/([^/]+)\/documents$/))) {
      const id = safeId(m[1]); if (!id) return json(res, 400, { error: 'bad id' });
      if (req.method === 'GET') return json(res, 200, docMeta(id));
      if (req.method === 'POST') { // body: raw bytes; headers x-file-name, x-file-kind (pdf|docx|text)
        const name = safeName(decodeURIComponent(req.headers['x-file-name'] || 'document')); const kind = String(req.headers['x-file-kind'] || 'text');
        const bytes = await readBody(req, 32e6); fs.mkdirSync(sessionDir(id), { recursive: true });
        const list = docMeta(id); const stamp = Date.now().toString(36);
        let stored, note = '';
        if (kind === 'pdf') { stored = stamp + '-' + name; fs.writeFileSync(path.join(sessionDir(id), stored), bytes); }
        else if (kind === 'docx') { const tmp = path.join(sessionDir(id), stamp + '-' + name); fs.writeFileSync(tmp, bytes); let text; try { text = docxToText(tmp); } catch (e) { return json(res, 415, { error: 'could not read that Word file: ' + e.message }); } stored = stamp + '-' + name + '.txt'; fs.writeFileSync(path.join(sessionDir(id), stored), text); note = 'converted to text'; }
        else { stored = stamp + '-' + name + (name.endsWith('.txt') || name.endsWith('.md') ? '' : '.txt'); fs.writeFileSync(path.join(sessionDir(id), stored), bytes.toString('utf8')); }
        const entry = { name, kind: kind === 'pdf' ? 'pdf' : 'text', stored, bytes: bytes.length, note, added_at: new Date().toISOString() };
        list.push(entry); saveDocMeta(id, list); return json(res, 200, entry);
      }
    }
    if ((m = P.match(/^\/api\/session\/([^/]+)\/artifacts$/)) && req.method === 'POST') {
      const id = safeId(m[1]); if (!id) return json(res, 400, { error: 'bad id' });
      return json(res, 200, saveArtifact(id, JSON.parse((await readBody(req, 5e6)).toString('utf8') || '{}')));
    }
    if ((m = P.match(/^\/api\/session\/([^/]+)\/artifacts\/([^/]+)$/))) {
      const id = safeId(m[1]); const f = safeName(m[2]); if (!id) return json(res, 400, { error: 'bad id' });
      return sendFile(res, path.join(sessionDir(id), 'artifacts', f), url.searchParams.has('download'));
    }
    return serveStatic(req, res);
  } catch (e) { console.error(e); json(res, 500, { error: e.message }); }
}).listen(PORT, HOST, () => {
  console.log('Cognitive Wedge running at http://' + (HOST === '0.0.0.0' ? '0.0.0.0' : 'localhost') + ':' + PORT + (TEAM_PASSWORD ? '  (team password on)' : '') + (KEY ? '' : '   (ANTHROPIC_API_KEY not set)'));
  console.log('Models: agent=' + MODELS.default + '  classifier=' + MODELS.quick + '  web search: up to ' + WEB_SEARCH_MAX_USES + ' per turn  records → ' + DATA);
});
