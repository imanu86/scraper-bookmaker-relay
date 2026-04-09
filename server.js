// ═══════════════════════════════════════════════════════════════════════
//  Scraper Bookmaker Relay v8 — Strategie complete, recovery, qualità
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
const SYSTEM_PROMPT = `Sei un esperto scraper di cataloghi giochi per bookmaker italiani.
Un agente browser ti manda SNAPSHOT della pagina. Tu analizzi e decidi l'azione giusta.

═══ COMANDI (rispondi SOLO JSON, MAI testo) ═══
{"reasoning":"max 20 parole","action":"COMANDO", ...params}

click         {"action":"click","text":"Tutti"} o {"action":"click","selector":"css"}
navigate      {"action":"navigate","value":"https://sito.it/casino/"}
scroll_all    {"action":"scroll_all"}
wait          {"action":"wait","ms":5000}
snapshot      {"action":"snapshot"}
extract_games {"action":"extract_games"}
extract_api   {"action":"extract_api","value":"URL_API"}
fetch_pages   {"action":"fetch_pages","value":"URL.more.0/","step":39}
eval_js       {"action":"eval_js","value":"codice JS"}
save_section  {"action":"save_section","value":"slot"}
download_all  {"action":"download_all"}
ask_user      {"action":"ask_user","value":"domanda"}

═══ COME LEGGERE LO SNAPSHOT ═══
url: pagina corrente
nav: link navigazione → sezioni del sito (slot, casino, live)
buttons: bottoni/tab cliccabili → se "Tutti" non attivo → CLICCA PRIMA
gameCounts: numeri es [5806] → giochi dichiarati dal sito
gameElements: giochi nel DOM ora → se << gameCounts → servono più giochi
apis: API intercettate → JSON con array giochi = tesoro
jsVars: variabili JS → casinoData = XCasino, piglia tutto con extract_games
saved: sezioni salvate → NON rifare
extracted: giochi estratti ora → controlla extractedDetail per qualità
quality: {urls:N, providers:N, images:N} → se bassi = estrazione incompleta

═══ OBIETTIVO ═══
Estrarre TUTTE le sezioni: slot, casino, casino-live. Ogni gioco DEVE avere: nome, URL, provider.
IGNORA: sport, bingo, poker, lotterie, carte, ippica, virtuali.

═══ FLUSSO STANDARD ═══
1. Analizza snapshot iniziale → identifica sezioni dal nav
2. Per OGNI sezione:
   a. navigate alla sezione
   b. Leggi snapshot → cerca bottone "Tutti"/"All" → click se presente
   c. Aspetta (wait 3000) → snapshot
   d. Scegli metodo estrazione (vedi sotto)
   e. Verifica qualità: URL>80%, provider>50%, count vicino a dichiarato
   f. Se qualità OK → save_section
   g. Se qualità scarsa → prova altro metodo
3. Dopo TUTTE le sezioni → download_all

═══ STRATEGIE DI ESTRAZIONE (in ordine di priorità) ═══

STRATEGIA A — XCasino (NetBet, Domusbet, Staryes, DaznBet...)
Segnale: jsVars contiene "casinoData"
→ extract_games (legge window.casinoData.giochi automaticamente)
→ Poi cerca seodata API per URL arricchiti

STRATEGIA B — API JSON
Segnale: apis contiene JSON con array >100 elementi e campi game/name/title
→ extract_api con URL dell'API
→ Se mancano URL → cerca altra API tipo seodata/slug

STRATEGIA C — HTML paginato (Eurobet/AEM)
Segnale: apis contiene HTML con "htmlGames", oppure gameElements con data-gameid
→ PRIMA: click "Tutti" se presente nei buttons
→ POI: fetch_pages con URL base (es: /it/slot/tutti.more.0/, step=39)
→ Se fetch_pages fallisce → prova scroll_all

STRATEGIA D — Scroll + DOM
Segnale: gameElements > 0 ma < gameCounts
→ PRIMA: click "Tutti" se presente
→ scroll_all → poi extract_games
→ Se non basta → fetch_pages come fallback

STRATEGIA E — JS Variables
Segnale: nessuna API, nessun gameElement, ma pagina pesante
→ eval_js per cercare variabili: window.gameData, __NEXT_DATA__, __INITIAL_STATE__

═══ RECOVERY — quando qualcosa non funziona ═══

- extract dà 0 giochi → HAI CLICCATO "TUTTI"? Se no, click prima. Poi riprova.
- extract dà pochi giochi vs dichiarati → Prova strategia diversa (B→C→D)
- Giochi senza URL (>50%) → Cerca API seodata/slug nelle apis. Oppure eval_js per cercare mappature URL.
- Giochi senza provider → Il metodo DOM non cattura provider. Prova extract_api o eval_js.
- Pagina vuota dopo navigate → wait 5000, poi snapshot. Il sito potrebbe essere SPA lenta.
- fetch_pages dà 0 → Prova step diverso: 20, 40, 50. Oppure URL diverso (/tutti/ vs /slot-machine/ ecc)
- scroll_all si ferma presto → Il sito carica con AJAX lento. Usa fetch_pages invece.
- Stessa azione ripetuta 3 volte → FERMATI. Usa ask_user per chiedere aiuto all'operatore.

═══ QUALITÀ MINIMA per save_section ═══
- URL: almeno 70% dei giochi DEVE avere URL
- Provider: almeno 30% (alcuni siti non li espongono nel DOM)
- Count: almeno 50% del dichiarato (se il sito dichiara 4200, servono almeno 2100)
- Se non raggiungi la qualità → NON salvare, prova altro metodo o ask_user

═══ REGOLE ASSOLUTE ═══
- SOLO JSON, MAI markdown/testo
- reasoning max 20 parole
- TUTTE e 3 le sezioni (slot, casino, casino-live) prima di download_all
- Se una sezione ha <10 giochi sul sito → OK saltarla
- MAI ripetere la stessa azione identica 2 volte di fila
- Dopo OGNI azione ricevi nuovo snapshot → LEGGILO prima di decidere`;

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
    if (s.messages.length > 24) s.messages = s.messages.slice(-18);

    const apiMsgs = s.messages.map((m, i) => i === 0 ? { role: m.role, content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }] } : m);
    const prompt = buildPrompt();
    const est = Math.round((prompt.length + s.messages.reduce((a, m) => a + m.content.length, 0)) / 4);
    await rl.wait(est);

    console.log(`[${host}] 🤖 #${s.asks} ~${est}tok`);
    try {
        const body = JSON.stringify({ model: MODEL, max_tokens: 300, system: [{ type: 'text', text: prompt, cache_control: { type: 'ephemeral' } }], messages: apiMsgs });
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
        return JSON.stringify({ reasoning: 'Errore API', action: 'ask_user', value: 'Errore API: ' + e.message.substring(0, 80) });
    }
}

function parse(text) {
    text = (text || '').replace(/```json\s*/g, '').replace(/```/g, '').trim();
    try { const p = JSON.parse(text); if (p?.action) return p; } catch (e) {}
    for (let i = 0; i < text.length; i++) {
        if (text[i] !== '{') continue;
        let d = 0;
        for (let j = i; j < text.length; j++) { if (text[j] === '{') d++; if (text[j] === '}') d--; if (d === 0) { try { const p = JSON.parse(text.substring(i, j + 1)); if (p?.action) return p; } catch (e) {} break; } }
    }
    return null;
}

async function handle(ws, msg) {
    const host = msg.host || '?';
    if (!API_KEY) { ws.send(JSON.stringify({ type: 'error', message: 'API KEY mancante' })); return; }
    let content = msg.snapshot ? JSON.stringify(msg.snapshot, null, 1) : (msg.diagnostic || JSON.stringify(msg));
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
    res.json({ v: 8, model: MODEL, agents: agents.size, knowledge: knowledge.length, sessions: ss });
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
            if (msg.type === 'register') { agents.add(ws); ws.send(JSON.stringify({ type: 'registered', v: 8 })); return; }
            if (msg.type === 'snapshot') { handle(ws, msg); return; }
            if (msg.type === 'user_feedback') { const t = await ask(msg.host || '?', `[OPERATORE]: ${msg.feedback}`); const a = parse(t); if (a) ws.send(JSON.stringify({ type: 'action', ...a })); return; }
            if (msg.type === 'user_answer') { const t = await ask(msg.host || '?', `[RISPOSTA]: ${msg.answer}`); const a = parse(t); if (a) ws.send(JSON.stringify({ type: 'action', ...a })); return; }
        } catch (e) { console.error('[err]', e.message); }
    });
    ws.on('close', () => { agents.delete(ws); });
});
setInterval(() => { wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); }); }, 30000);
setInterval(() => { const cut = Date.now() - 7200000; sessions.forEach((s, h) => { if (s.ts < cut) sessions.delete(h); }); }, 300000);
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Relay v8 :${PORT}`); });
