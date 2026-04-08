// ═══════════════════════════════════════════════════════════════════════
//  Scraper Bookmaker Relay v6 — Claude analizza diagnostica, decide strategia
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

// ═══ SYSTEM PROMPT ═══
const SYSTEM_PROMPT = `Sei un analista che guida un agente browser per estrarre cataloghi giochi da bookmaker.
L'agente ti manda DIAGNOSTICA compatta dopo ogni operazione. Tu analizzi i numeri e decidi la prossima mossa.

COMANDI (rispondi SOLO JSON, nessun testo o markdown):
{"reasoning":"max 15 parole","action":"COMANDO","value":"..."}

COMANDI DISPONIBILI:
- navigate_section: vai a una sezione → value="/it/slot/tutti/"
- extract: prova estrazione automatica (l'agente tenta: xcasino → api → html_pages → scroll → js_vars)
- retry_method: forza un metodo specifico → value="html_pages" o "scroll_dom" o "xcasino_js" o "json_api"
- save_section: salva sezione → value="slot"
- next_section: salva e naviga alla prossima sezione non estratta
- download_all: scarica catalogo completo
- ask_user: chiedi all'operatore → value="domanda"

COME ANALIZZARE LA DIAGNOSTICA:
- conteggio basso vs dichiarato → metodo sbagliato, prova retry_method con un altro
- provider vuoti → il metodo non cattura il provider, prova un altro
- URL vuoti → serve arricchimento o metodo diverso
- 0 giochi → pagina sbagliata o serve navigare prima

FLUSSO: navigate → extract → analizza diagnostica → se OK save, se problemi retry_method → quando tutto OK → download_all.
SOLO JSON. MAI markdown, MAI testo libero.`;

// ═══ KNOWLEDGE ═══
let knowledge = [];
function buildPrompt() {
    let p = SYSTEM_PROMPT;
    if (knowledge.length) p += '\n\nCONOSCENZE:\n' + knowledge.map((k, i) => `${i + 1}. ${k.pattern}`).join('\n');
    return p;
}

// ═══ SESSION + RATE LIMIT ═══
const sessions = new Map();
function getSession(h) { if (!sessions.has(h)) sessions.set(h, { host: h, ts: Date.now(), messages: [], asks: 0, tokens: { i: 0, o: 0, cr: 0, cw: 0 } }); return sessions.get(h); }

const rl = {
    log: [], MAX: 40000, MIN: 3000, last: 0,
    async wait(est) {
        const now = Date.now(); this.log = this.log.filter(e => now - e.t < 60000);
        const u = this.log.reduce((s, e) => s + e.n, 0);
        if (u + est > this.MAX) await new Promise(r => setTimeout(r, 60000 - (now - (this.log[0]?.t || now)) + 1000));
        if (now - this.last < this.MIN) await new Promise(r => setTimeout(r, this.MIN - (now - this.last)));
        this.last = Date.now();
    },
    add(n) { this.log.push({ t: Date.now(), n }); }
};

// ═══ CLAUDE API ═══
async function ask(host, msg, retry) {
    retry = retry || 0;
    const s = getSession(host); s.asks++; s.ts = Date.now();
    s.messages.push({ role: 'user', content: msg });
    if (s.messages.length > 20) s.messages = s.messages.slice(-14);

    const apiMsgs = s.messages.map((m, i) => i === 0 ? { role: m.role, content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }] } : m);
    const prompt = buildPrompt();
    const est = Math.round((prompt.length + s.messages.reduce((a, m) => a + m.content.length, 0)) / 4);
    await rl.wait(est);

    console.log(`[${host}] 🤖 #${s.asks} ~${est}tok`);
    try {
        const body = JSON.stringify({ model: MODEL, max_tokens: 200, system: [{ type: 'text', text: prompt, cache_control: { type: 'ephemeral' } }], messages: apiMsgs });
        const result = await new Promise((res, rej) => {
            const req = https.request({ hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'prompt-caching-2024-07-31', 'Content-Length': Buffer.byteLength(body) }
            }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { if (r.statusCode !== 200) rej(new Error(`${r.statusCode}: ${d.substring(0, 200)}`)); else try { res(JSON.parse(d)); } catch (e) { rej(e); } }); });
            req.on('error', rej); req.write(body); req.end();
        });
        const text = result.content?.[0]?.text || '';
        rl.add((result.usage?.input_tokens || est) + (result.usage?.output_tokens || 0));
        if (result.usage) { s.tokens.i += result.usage.input_tokens || 0; s.tokens.o += result.usage.output_tokens || 0; s.tokens.cr += result.usage.cache_read_input_tokens || 0; s.tokens.cw += result.usage.cache_creation_input_tokens || 0; }
        s.messages.push({ role: 'assistant', content: text });
        console.log(`[${host}] ✅ ${text.substring(0, 120)}`);
        return text;
    } catch (e) {
        console.error(`[${host}] ❌ ${e.message}`);
        if (s.messages.length && s.messages[s.messages.length - 1].role === 'user') s.messages.pop();
        if ((e.message.includes('429') || e.message.includes('529')) && retry < 3) {
            console.log(`[${host}] 🔄 Retry ${retry + 1}`); s.asks--;
            await new Promise(r => setTimeout(r, 15000 * (retry + 1)));
            return ask(host, msg, retry + 1);
        }
        return JSON.stringify({ reasoning: 'API error', action: 'ask_user', value: 'Errore API: ' + e.message });
    }
}

function parse(text) {
    text = (text || '').replace(/```json\s*/g, '').replace(/```/g, '').trim();
    try { const p = JSON.parse(text); if (p?.action) return p; } catch (e) {}
    const m = text.match(/\{[^{}]*"action"[^{}]*\}/);
    if (m) try { const p = JSON.parse(m[0]); if (p?.action) return p; } catch (e) {}
    return null;
}

// ═══ HANDLE MESSAGES ═══
async function handle(ws, msg) {
    const host = msg.host || '?';
    if (!API_KEY) { ws.send(JSON.stringify({ type: 'error', message: 'API KEY mancante' })); return; }
    const text = await ask(host, msg.diagnostic || msg.report || JSON.stringify(msg));
    const action = parse(text);
    if (action) ws.send(JSON.stringify({ type: 'action', ...action }));
    else ws.send(JSON.stringify({ type: 'error', message: 'Non parsabile: ' + text.substring(0, 150) }));
}

// ═══ HTTP ═══
app.use(express.json());
app.get('/', (req, res) => {
    const ss = {}; sessions.forEach((s, h) => { ss[h] = { asks: s.asks, msgs: s.messages.length, tokens: s.tokens,
        cost: `$${((s.tokens.i / 1e6) * 3 + (s.tokens.o / 1e6) * 15 + (s.tokens.cr / 1e6) * 0.3 + (s.tokens.cw / 1e6) * 3.75).toFixed(4)}` }; });
    res.json({ v: 6, model: MODEL, agents: agents.size, sessions: ss });
});
app.get('/sessions/:h/chat', (req, res) => { const s = sessions.get(req.params.h); res.json(s ? s.messages : []); });
app.delete('/sessions', (req, res) => { sessions.clear(); res.json({ ok: 1 }); });
app.delete('/sessions/:h', (req, res) => { sessions.delete(req.params.h); res.json({ ok: 1 }); });
app.get('/knowledge', (req, res) => res.json(knowledge));
app.post('/knowledge', (req, res) => { if (!req.body.pattern) return res.status(400).json({ err: 1 }); knowledge.push({ pattern: req.body.pattern, ts: Date.now() }); res.json({ ok: 1 }); });
app.delete('/knowledge', (req, res) => { knowledge = []; res.json({ ok: 1 }); });

// ═══ WS ═══
wss.on('connection', (ws) => {
    ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', async (raw) => {
        try {
            const msg = JSON.parse(raw);
            if (msg.type === 'register') { agents.add(ws); ws.send(JSON.stringify({ type: 'registered', v: 6 })); return; }
            if (msg.type === 'diagnostic') { handle(ws, msg); return; }
            if (msg.type === 'user_feedback') { const t = await ask(msg.host || '?', `[OPERATORE]: ${msg.feedback}`); const a = parse(t); if (a) ws.send(JSON.stringify({ type: 'action', ...a })); return; }
            if (msg.type === 'user_answer') { const t = await ask(msg.host || '?', `[RISPOSTA]: ${msg.answer}`); const a = parse(t); if (a) ws.send(JSON.stringify({ type: 'action', ...a })); return; }
        } catch (e) { console.error('[err]', e.message); }
    });
    ws.on('close', () => { agents.delete(ws); });
});
setInterval(() => { wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); }); }, 30000);
setInterval(() => { const cut = Date.now() - 7200000; sessions.forEach((s, h) => { if (s.ts < cut) sessions.delete(h); }); }, 300000);
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Relay v6 :${PORT}`); });
