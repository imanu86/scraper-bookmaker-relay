// ═══════════════════════════════════════════════════════════════════════
//  Scraper Bookmaker Relay v5 — Smart Agent + Minimal Claude
// ═══════════════════════════════════════════════════════════════════════

const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const https = require('https');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 2 * 1024 * 1024 });

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-20250514';

if (!API_KEY) console.warn('⚠️  ANTHROPIC_API_KEY non impostata!');

let agents = new Set();

// ═══ SYSTEM PROMPT — corto, Claude decide solo la strategia ═══
const SYSTEM_PROMPT = `Sei un coordinatore che guida un agente browser per estrarre cataloghi giochi da siti di scommesse italiani.
L'agente è intelligente: detecta la piattaforma, intercetta API, scrolla, parsa HTML/JSON, classifica giochi, verifica URL. Tu decidi solo la STRATEGIA.

COMANDI (rispondi SOLO con JSON):
- navigate_section: {"action":"navigate_section","value":"/casino-live"}
- extract: {"action":"extract"} — l'agente sceglie il metodo migliore automaticamente
- extract_scroll: {"action":"extract_scroll"} — forza estrazione via scroll DOM
- save_section: {"action":"save_section","value":"casino"}
- download_all: {"action":"download_all"}
- ask_user: {"action":"ask_user","value":"domanda"}
- custom: {"action":"custom","cmd":"eval_js","value":"window.X"} — per casi edge

OBIETTIVO: estrarre TUTTI i giochi (slot, casino, casino-live) con nome, provider, URL, immagine.
IGNORA: sport, bingo, poker, lotterie, carte, ippica, virtuali.

FLUSSO: per ogni sezione nel menu → navigate_section → extract → controlla report → save_section → prossima sezione → download_all.
Se extract fallisce → prova extract_scroll. Se anche quello fallisce → ask_user.
NON salvare senza URL. Reasoning max 15 parole. SOLO JSON.`;

// ═══ LEARNED KNOWLEDGE ═══
let learnedKnowledge = [];
function buildSystemPrompt() {
    let p = SYSTEM_PROMPT;
    if (learnedKnowledge.length) {
        p += '\n\nCONOSCENZE APPRESE:\n' + learnedKnowledge.map((k, i) => `${i + 1}. ${k.pattern}`).join('\n');
    }
    return p;
}

// ═══ SESSION + RATE LIMITER ═══
const sessions = new Map();
function getSession(h) {
    if (!sessions.has(h)) sessions.set(h, { host: h, ts: Date.now(), messages: [], asks: 0, tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 } });
    return sessions.get(h);
}

const rateLimiter = {
    log: [], MAX: 40000, MIN_MS: 3000, lastTs: 0,
    async wait(est) {
        const now = Date.now();
        this.log = this.log.filter(e => now - e.ts < 60000);
        const used = this.log.reduce((s, e) => s + e.t, 0);
        if (used + est > this.MAX) { const w = 60000 - (now - (this.log[0]?.ts || now)) + 1000; await new Promise(r => setTimeout(r, w)); }
        if (now - this.lastTs < this.MIN_MS) await new Promise(r => setTimeout(r, this.MIN_MS - (now - this.lastTs)));
        this.lastTs = Date.now();
    },
    add(t) { this.log.push({ ts: Date.now(), t }); }
};

// ═══ CLAUDE API ═══
async function askClaude(host, msg, retry) {
    retry = retry || 0;
    const s = getSession(host);
    s.asks++;
    s.messages.push({ role: 'user', content: msg });
    if (s.messages.length > 20) s.messages = s.messages.slice(-14);

    const apiMsgs = s.messages.map((m, i) => i === 0 ? { role: m.role, content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }] } : m);
    const prompt = buildSystemPrompt();
    const est = Math.round((prompt.length + s.messages.reduce((a, m) => a + m.content.length, 0)) / 4);
    await rateLimiter.wait(est);

    console.log(`[${host}] 🤖 #${s.asks} ~${est}tok`);
    try {
        const body = JSON.stringify({ model: MODEL, max_tokens: 200, system: [{ type: 'text', text: prompt, cache_control: { type: 'ephemeral' } }], messages: apiMsgs });
        const result = await new Promise((res, rej) => {
            const req = https.request({ hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'prompt-caching-2024-07-31', 'Content-Length': Buffer.byteLength(body) }
            }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { if (r.statusCode !== 200) rej(new Error(`API ${r.statusCode}: ${d.substring(0, 200)}`)); else try { res(JSON.parse(d)); } catch (e) { rej(e); } }); });
            req.on('error', rej); req.write(body); req.end();
        });
        const text = result.content?.[0]?.text || '';
        rateLimiter.add((result.usage?.input_tokens || est) + (result.usage?.output_tokens || 0));
        if (result.usage) { s.tokens.input += result.usage.input_tokens || 0; s.tokens.output += result.usage.output_tokens || 0; s.tokens.cache_read += result.usage.cache_read_input_tokens || 0; s.tokens.cache_write += result.usage.cache_creation_input_tokens || 0; }
        s.messages.push({ role: 'assistant', content: text });
        console.log(`[${host}] ✅ ${text.substring(0, 120)}`);
        return { text };
    } catch (e) {
        console.error(`[${host}] ❌ ${e.message}`);
        if (s.messages.length && s.messages[s.messages.length - 1].role === 'user') s.messages.pop();
        if ((e.message.includes('429') || e.message.includes('529')) && retry < 3) {
            console.log(`[${host}] 🔄 Retry ${retry + 1}`);
            await new Promise(r => setTimeout(r, 15000 * (retry + 1)));
            s.asks--; return askClaude(host, msg, retry + 1);
        }
        return { error: e.message };
    }
}

function parseAction(text) {
    text = text.replace(/```json\s*/g, '').replace(/```/g, '').trim();
    try { const p = JSON.parse(text); if (p?.action) return p; } catch (e) {}
    for (let i = 0; i < text.length; i++) {
        if (text[i] !== '{') continue;
        let d = 0;
        for (let j = i; j < text.length; j++) { if (text[j] === '{') d++; if (text[j] === '}') d--; if (d === 0) { try { const p = JSON.parse(text.substring(i, j + 1)); if (p?.action) return p; } catch (e) {} break; } }
    }
    return null;
}

async function handleAgent(ws, msg) {
    const host = msg.host || '?';
    if (!API_KEY) { ws.send(JSON.stringify({ type: 'error', message: 'API KEY mancante' })); return; }
    const response = await askClaude(host, msg.report || JSON.stringify(msg));
    if (response.error) { ws.send(JSON.stringify({ type: 'error', message: response.error })); return; }
    const parsed = parseAction(response.text);
    if (parsed) ws.send(JSON.stringify({ type: 'action', ...parsed }));
    else ws.send(JSON.stringify({ type: 'error', message: 'Non parsabile: ' + response.text.substring(0, 100) }));
}

// ═══ HTTP ═══
app.use(express.json());
app.get('/', (req, res) => {
    const ss = {}; sessions.forEach((s, h) => { ss[h] = { asks: s.asks, msgs: s.messages.length, tokens: s.tokens }; });
    res.json({ status: 'ok', v: 5, model: MODEL, agents: agents.size, knowledge: learnedKnowledge.length, sessions: ss });
});
app.get('/sessions/:h/chat', (req, res) => { const s = sessions.get(req.params.h); res.json(s ? s.messages : []); });
app.delete('/sessions', (req, res) => { sessions.clear(); res.json({ ok: true }); });
app.delete('/sessions/:h', (req, res) => { sessions.delete(req.params.h); res.json({ ok: true }); });
app.get('/knowledge', (req, res) => res.json(learnedKnowledge));
app.post('/knowledge', (req, res) => { if (!req.body.pattern) return res.status(400).json({ error: 'pattern required' }); learnedKnowledge.push({ pattern: req.body.pattern, ts: Date.now() }); res.json({ ok: true }); });
app.delete('/knowledge', (req, res) => { learnedKnowledge = []; res.json({ ok: true }); });

// ═══ WEBSOCKET ═══
wss.on('connection', (ws) => {
    ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', async (raw) => {
        try {
            const msg = JSON.parse(raw);
            if (msg.type === 'register') { agents.add(ws); ws.send(JSON.stringify({ type: 'registered', v: 5 })); return; }
            if (msg.type === 'report') { handleAgent(ws, msg); return; }
            if (msg.type === 'user_feedback') { const r = await askClaude(msg.host || '?', `[OPERATORE]: ${msg.feedback}`); if (r.text) { const p = parseAction(r.text); if (p) ws.send(JSON.stringify({ type: 'action', ...p })); } return; }
            if (msg.type === 'user_answer') { const r = await askClaude(msg.host || '?', `[RISPOSTA]: ${msg.answer}`); if (r.text) { const p = parseAction(r.text); if (p) ws.send(JSON.stringify({ type: 'action', ...p })); } return; }
        } catch (e) { console.error('[err]', e.message); }
    });
    ws.on('close', () => { agents.delete(ws); });
});

setInterval(() => { wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); }); }, 30000);
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Relay v5 :${PORT} — ${MODEL}`); });
