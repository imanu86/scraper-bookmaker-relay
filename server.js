// ═══════════════════════════════════════════════════════════════════════
//  Scraper Bookmaker Relay v7 — Claude vede la pagina, decide cosa fare
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
if (!API_KEY) console.warn('⚠️ ANTHROPIC_API_KEY mancante');

let agents = new Set();

// ═══ SYSTEM PROMPT ═══
const SYSTEM_PROMPT = `Sei un operatore che guida un agente browser per estrarre il catalogo giochi completo da siti di bookmaker italiani.

L'agente ti manda SNAPSHOT della pagina: URL, link di navigazione, bottoni visibili, conteggi giochi, elementi nel DOM, API intercettate, variabili JS, giochi già estratti/salvati.

Tu VEDI la pagina attraverso gli occhi dell'agente. Analizza lo snapshot e decidi L'AZIONE GIUSTA.

COMANDI (rispondi SOLO JSON):
{"reasoning":"max 20 parole","action":"COMANDO", ...parametri}

click       → {"action":"click","text":"Tutti"} o {"action":"click","selector":".btn-all"}
navigate    → {"action":"navigate","value":"https://www.sito.it/casino/"}
scroll_all  → {"action":"scroll_all"} — scrolla gradualmente per caricare tutti i giochi
wait        → {"action":"wait","ms":5000} — aspetta che il contenuto carichi
snapshot    → {"action":"snapshot"} — rileggimi la pagina
extract_games → {"action":"extract_games"} — estrai giochi dal DOM (o da window.casinoData se presente)
extract_api → {"action":"extract_api","value":"https://api.sito.it/games"} — fetcha un API JSON
fetch_pages → {"action":"fetch_pages","value":"https://sito.it/slot/tutti.more.0/","step":39} — pagine HTML
eval_js     → {"action":"eval_js","value":"window.casinoData.giochi.length"}
save_section → {"action":"save_section","value":"slot"}
download_all → {"action":"download_all"}
ask_user    → {"action":"ask_user","value":"domanda per l'operatore"}

COME LEGGERE LO SNAPSHOT:
- nav: link di navigazione → ti dice quali sezioni ha il sito (slot, casino, live)
- buttons: bottoni/tab cliccabili → se vedi "Tutti"/"All" E gameElements è basso, CLICCA PRIMA
- gameCounts: numeri tipo "5806 Giochi" → quanti giochi DICHIARA il sito
- gameElements: quanti giochi sono nel DOM ORA → se molto meno di gameCounts, serve scroll o fetch_pages
- apis: API intercettate → se c'è un JSON con array di giochi, usa extract_api
- jsVars: variabili JS → se c'è casinoData, usa extract_games (lo fa automaticamente)
- saved: sezioni già salvate → non rifare quelle già fatte
- extracted: giochi già estratti → se >0, controlla urls e providers nel extractedDetail

STRATEGIA:
1. GUARDA i bottoni — se c'è "Tutti"/"Tutte le slot"/"All games" e NON è già attivo → click prima!
2. GUARDA gameElements vs gameCounts — se pochi nel DOM → scroll_all o fetch_pages
3. GUARDA jsVars — se c'è casinoData → extract_games (XCasino, piglia tutto subito)
4. GUARDA apis — se c'è un JSON grosso con array → extract_api
5. Dopo extract, GUARDA extractedDetail — se urls o providers sono bassi → il metodo è sbagliato, prova un altro
6. Sezioni: slot → casino → casino-live → download_all

REGOLE:
- SOLO JSON, MAI testo o markdown
- reasoning max 20 parole
- Se non capisci la pagina → ask_user
- NON salvare senza URL
- Dopo ogni azione l'agente ti manda un nuovo snapshot — RILEGGILO prima di decidere`;

// ═══ KNOWLEDGE ═══
let knowledge = [];
function buildPrompt() {
    let p = SYSTEM_PROMPT;
    if (knowledge.length) p += '\n\nCONOSCENZE APPRESE:\n' + knowledge.map((k, i) => `${i + 1}. ${k.pattern}`).join('\n');
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
        const body = JSON.stringify({ model: MODEL, max_tokens: 250, system: [{ type: 'text', text: prompt, cache_control: { type: 'ephemeral' } }], messages: apiMsgs });
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
        return JSON.stringify({ reasoning: 'Errore API, chiedo aiuto', action: 'ask_user', value: 'Errore API Claude: ' + e.message.substring(0, 100) });
    }
}

function parse(text) {
    text = (text || '').replace(/```json\s*/g, '').replace(/```/g, '').trim();
    try { const p = JSON.parse(text); if (p?.action) return p; } catch (e) {}
    // Try to find JSON in text
    for (let i = 0; i < text.length; i++) {
        if (text[i] !== '{') continue;
        let d = 0;
        for (let j = i; j < text.length; j++) { if (text[j] === '{') d++; if (text[j] === '}') d--; if (d === 0) { try { const p = JSON.parse(text.substring(i, j + 1)); if (p?.action) return p; } catch (e) {} break; } }
    }
    return null;
}

// ═══ HANDLE ═══
async function handle(ws, msg) {
    const host = msg.host || '?';
    if (!API_KEY) { ws.send(JSON.stringify({ type: 'error', message: 'API KEY mancante' })); return; }

    // Build message from snapshot
    let content;
    if (msg.snapshot) {
        content = 'SNAPSHOT:\n' + JSON.stringify(msg.snapshot, null, 1);
    } else {
        content = msg.diagnostic || msg.report || JSON.stringify(msg);
    }

    const text = await ask(host, content);
    const action = parse(text);
    if (action) ws.send(JSON.stringify({ type: 'action', ...action }));
    else ws.send(JSON.stringify({ type: 'error', message: 'Non parsabile: ' + text.substring(0, 150) }));
}

// ═══ HTTP ═══
app.use(express.json());
app.get('/', (req, res) => {
    const ss = {}; sessions.forEach((s, h) => { ss[h] = { asks: s.asks, msgs: s.messages.length, tokens: s.tokens,
        cost: `$${((s.tokens.i / 1e6) * 3 + (s.tokens.o / 1e6) * 15 + (s.tokens.cr / 1e6) * 0.3 + (s.tokens.cw / 1e6) * 3.75).toFixed(4)}` }; });
    res.json({ v: 7, model: MODEL, agents: agents.size, knowledge: knowledge.length, sessions: ss });
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
            if (msg.type === 'register') { agents.add(ws); ws.send(JSON.stringify({ type: 'registered', v: 7 })); return; }
            if (msg.type === 'snapshot' || msg.type === 'diagnostic') { handle(ws, msg); return; }
            if (msg.type === 'user_feedback') { const t = await ask(msg.host || '?', `[OPERATORE]: ${msg.feedback}`); const a = parse(t); if (a) ws.send(JSON.stringify({ type: 'action', ...a })); return; }
            if (msg.type === 'user_answer') { const t = await ask(msg.host || '?', `[RISPOSTA]: ${msg.answer}`); const a = parse(t); if (a) ws.send(JSON.stringify({ type: 'action', ...a })); return; }
        } catch (e) { console.error('[err]', e.message); }
    });
    ws.on('close', () => { agents.delete(ws); });
});
setInterval(() => { wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); }); }, 30000);
setInterval(() => { const cut = Date.now() - 7200000; sessions.forEach((s, h) => { if (s.ts < cut) sessions.delete(h); }); }, 300000);
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Relay v7 :${PORT}`); });
