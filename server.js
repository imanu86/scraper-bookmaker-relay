// ═══════════════════════════════════════════════════════════════════════
//  Scraper Bookmaker Relay v4 — Direct Claude API
//  Agent → WS → Server → Claude API → Server → WS → Agent
//  No bridge needed. Server calls Claude directly.
//
//  ENV: ANTHROPIC_API_KEY=sk-ant-...
//  Deploy: Railway
// ═══════════════════════════════════════════════════════════════════════

const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const https = require('https');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 2 * 1024 * 1024 });

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';

if (!API_KEY) console.warn('⚠️  ANTHROPIC_API_KEY non impostata! Claude API non funzionerà.');

let agents = new Set();

// ═══════════════════════════════════════════════════════════════════════
//  SYSTEM PROMPT — istruzioni per Claude (mandato una sola volta)
// ═══════════════════════════════════════════════════════════════════════
const SYSTEM_PROMPT = `Sei un agente che controlla un browser tramite comandi JSON. Obiettivo: estrarre il catalogo completo dei giochi (slot/casino) da un bookmaker italiano.

Lo script nel browser intercetta tutte le chiamate network e ti manda campioni del contenuto reale. Tu analizzi e rispondi con UN SOLO comando alla volta.

════════════════════════════════════════
FORMATO RISPOSTA (OBBLIGATORIO)
════════════════════════════════════════
Rispondi ESCLUSIVAMENTE con questo JSON, niente altro testo:
{"reasoning":"max 15 parole","action":{"type":"COMANDO","value":"parametro"}}

════════════════════════════════════════
COMANDI DISPONIBILI
════════════════════════════════════════

navigate
  Naviga a un URL. Lo script cambia pagina e ti manda il nuovo contesto.
  {"type":"navigate","value":"https://sito.it/casino/slot"}

scroll
  Scrolla in fondo alla pagina per triggerare lazy loading.
  {"type":"scroll","value":"bottom"}

click
  Clicca un elemento nel DOM usando un CSS selector.
  {"type":"click","value":"button.load-more"}

wait_apis
  Aspetta N millisecondi che il sito carichi API (utile dopo navigate su SPA Angular/React).
  {"type":"wait_apis","delay":5000}

fetch_api
  Esegue una fetch HTTP. Lo script intercetta la risposta e ti manda un campione.
  GET: {"type":"fetch_api","value":"https://api.sito.it/games","method":"GET"}
  POST: {"type":"fetch_api","value":"https://api.sito.it/games","method":"POST","body":"{\\"category\\":\\"slot\\"}"}

fetch_paginated
  Fetcha un endpoint paginato. Lo script itera tutte le pagine.
  {"type":"fetch_paginated","value":"https://api.sito.it/games","pageParam":"page","pageSize":50,"maxPages":30}

scrape_dom
  Estrae giochi dal DOM: immagini, data-attributes, JSON inline.
  {"type":"scrape_dom"}

eval_js
  Esegue JavaScript nella pagina. Utile per variabili globali tipo window.gameData.
  {"type":"eval_js","value":"window.casinoData.giochi"}

scan_js
  Scansiona la pagina cercando variabili JS globali con dati (window.*, __NEXT_DATA__, ecc).
  {"type":"scan_js"}

use_api
  Seleziona dati di un'API già intercettata. Value = URL o URL→path per sub-array.
  {"type":"use_api","value":"https://api.sito.it/games"}

fetch_merge
  Fetcha una seconda API e unisce i dati (es: URL) al catalogo già caricato. Serve per arricchire il catalogo con link, slug SEO, ecc.
  {"type":"fetch_merge","value":"https://sito.it/api/seodata","joinKey":"chiaveGioco","urlPrefix":"https://sito.it/slots/","extractPath":"gamesUrlPreview"}
  joinKey: campo nel catalogo per fare il match
  urlPrefix: prefisso da aggiungere allo slug per costruire URL completo
  extractPath: percorso nell'oggetto JSON per trovare la mappa di URL (es: "gamesUrlPreview")
  Il risultato aggiunge campo "url" a ogni gioco che ha un match.

run
  Esegue codice JS arbitrario con accesso ai dati. Variabili disponibili: CATALOG (array giochi), APIS (dati API salvati), SAMPLES (campioni API). Assegna il risultato a RESULT.
  {"type":"run","value":"var count = CATALOG.filter(g => g.url).length; RESULT = 'Giochi con URL: ' + count"}

download
  Scarica i dati correnti come file JSON.
  {"type":"download","filename":"sito_catalog.json"}

save_section
  Salva il catalogo corrente con un'etichetta. I dati persistono anche dopo navigazione. Dopo il salvataggio i dati correnti vengono resettati, pronto per la prossima sezione.
  {"type":"save_section","value":"slots"}

download_all
  Unisce TUTTE le sezioni salvate (deduplicando) e scarica un unico file completo.
  {"type":"download_all","filename":"sito_catalog_complete.json"}

approve
  Catalogo completo e buono. Termina con successo.
  {"type":"approve"}

retry_different
  Resetta tutti i dati e riparti con strategia diversa.
  {"type":"retry_different"}

done
  Impossibile estrarre. Termina.
  {"type":"done"}

════════════════════════════════════════
STRATEGIA
════════════════════════════════════════
1. Guarda le API intercettate — array con name/title/provider = catalogo
2. API grossa non-JSON = HTML con dati JS inline → scan_js poi eval_js
3. Nessuna API utile → naviga a pagina slot, poi wait_apis
4. Dopo navigate senza API → scroll per lazy load
5. Endpoint sospetto → fetch_api
6. scrape_dom solo come ultima risorsa
7. MAI scaricare senza verificare che i dati contengano nomi giochi reali
8. MAI ripetere un'azione già fatta
9. Preferisci SEMPRE JSON da API rispetto a scrape DOM
10. PRIMA di scaricare, cerca API con URL/slug SEO e usa fetch_merge per aggiungere i link
11. ESPLORA TUTTE LE SEZIONI: dopo aver completato slot, usa save_section per salvare, poi naviga a casino, poi casino live. Alla fine usa download_all per unire tutto
12. Flusso multi-sezione: estrai slot → fetch_merge URL → save_section "slots" → navigate /casino → estrai → fetch_merge → save_section "casino" → navigate /casino-live → estrai → save_section "casino_live" → download_all
13. Rispondi SEMPRE e SOLO col JSON, max 15 parole nel reasoning`;

// ═══════════════════════════════════════════════════════════════════════
//  SESSION — conversazione con Claude per ogni host
// ═══════════════════════════════════════════════════════════════════════
const sessions = new Map();

function getSession(host) {
    if (!sessions.has(host)) {
        sessions.set(host, {
            host,
            ts: Date.now(),
            messages: [],  // storico conversazione Claude
            actions: [],
            actionKeys: new Set(),
            asks: 0,
            tokens: { input: 0, output: 0 },
        });
    }
    return sessions.get(host);
}

// ═══════════════════════════════════════════════════════════════════════
//  CLAUDE API
// ═══════════════════════════════════════════════════════════════════════
async function askClaude(host, userMessage) {
    const session = getSession(host);
    session.asks++;

    // Aggiungi messaggio utente alla conversazione
    session.messages.push({ role: 'user', content: userMessage });

    // Tieni max 30 messaggi per non sforare il contesto
    if (session.messages.length > 30) {
        session.messages = session.messages.slice(-20);
    }

    console.log(`[${host}] 🤖 Claude ask #${session.asks} (${session.messages.length} msgs, ${userMessage.length} chars)`);

    try {
        const body = JSON.stringify({
            model: MODEL,
            max_tokens: 300,
            system: SYSTEM_PROMPT,
            messages: session.messages,
        });

        const result = await new Promise((resolve, reject) => {
            const req = https.request({
                hostname: 'api.anthropic.com',
                path: '/v1/messages',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': API_KEY,
                    'anthropic-version': '2023-06-01',
                    'Content-Length': Buffer.byteLength(body),
                },
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    if (res.statusCode !== 200) {
                        reject(new Error(`API ${res.statusCode}: ${data.substring(0, 200)}`));
                        return;
                    }
                    try { resolve(JSON.parse(data)); }
                    catch (e) { reject(new Error('JSON parse: ' + e.message)); }
                });
            });
            req.on('error', reject);
            req.write(body);
            req.end();
        });

        const text = result.content?.[0]?.text || '';

        if (result.usage) {
            session.tokens.input += result.usage.input_tokens || 0;
            session.tokens.output += result.usage.output_tokens || 0;
        }

        session.messages.push({ role: 'assistant', content: text });
        console.log(`[${host}] ✅ Claude: ${text.substring(0, 100)}`);
        return { text };

    } catch (e) {
        console.error(`[${host}] ❌ Fetch error: ${e.message}`);
        return { error: e.message };
    }
}

// ═══════════════════════════════════════════════════════════════════════
//  PARSE JSON dalla risposta di Claude
// ═══════════════════════════════════════════════════════════════════════
function parseAction(text) {
    // Pulisci markdown
    text = text.replace(/```json\s*/g, '').replace(/```/g, '').trim();

    // Prova JSON diretto
    try {
        const p = JSON.parse(text);
        if (p?.action?.type) return p;
    } catch (e) {}

    // Brace matching
    for (let i = 0; i < text.length; i++) {
        if (text[i] !== '{') continue;
        let depth = 0;
        for (let j = i; j < text.length; j++) {
            if (text[j] === '{') depth++;
            if (text[j] === '}') depth--;
            if (depth === 0) {
                try {
                    const p = JSON.parse(text.substring(i, j + 1));
                    if (p?.action?.type) return p;
                } catch (e) {}
                break;
            }
        }
    }

    // Fallback: estrai type
    const typeMatch = text.match(/"type"\s*:\s*"(\w+)"/);
    const valueMatch = text.match(/"value"\s*:\s*"([^"]+)"/);
    if (typeMatch) {
        return { reasoning: 'parse parziale', action: { type: typeMatch[1], value: valueMatch?.[1] || '' } };
    }

    return null;
}

// ═══════════════════════════════════════════════════════════════════════
//  ANTI-LOOP
// ═══════════════════════════════════════════════════════════════════════
function checkLoop(host, action) {
    const s = getSession(host);
    const key = action.type + '|' + (action.value || '').substring(0, 50);

    if (['scroll', 'scrape_dom'].includes(action.type)) {
        if (s.actions.filter(a => a.type === action.type).length >= 4) return true;
    } else if (s.actionKeys.has(key)) return true;

    s.actionKeys.add(key);
    s.actions.push({ type: action.type, value: action.value, ts: Date.now() });
    return false;
}

// ═══════════════════════════════════════════════════════════════════════
//  BUILD USER MESSAGE from agent context
// ═══════════════════════════════════════════════════════════════════════
function buildFirstMessage(ctx) {
    const parts = [];
    parts.push(`Sito: ${ctx.url}`);
    parts.push(`Framework: ${ctx.framework}`);
    parts.push(`Immagini giochi DOM: ${ctx.domImgs || 0}`);

    if (ctx.links?.length) {
        parts.push('\nLink:');
        ctx.links.forEach(l => parts.push(`  ${l.t} → ${l.h}`));
    }

    if (ctx.intercepted?.length) {
        parts.push('\nAPI intercettate:');
        ctx.intercepted.forEach((api, i) => {
            parts.push(`\n[#${i + 1}] ${Math.round(api.size / 1024)}KB ${api.method} ${api.url}`);
            parts.push(`  ${api.isJson ? 'JSON ' + api.type : 'non-JSON'}`);
            if (api.keys) parts.push(`  Chiavi: ${api.keys.join(', ')}`);
            if (api.type === 'array') parts.push(`  Array ${api.length} elementi`);
            if (api.arrays) api.arrays.forEach(a => parts.push(`  "${a.key}": ${a.length} elem → ${a.sampleItem}`));
            if (api.sample) parts.push(`  Campione: ${api.sample}`);
            if (api.note) parts.push(`  ${api.note}`);
        });
    } else {
        parts.push('\nNessuna API grossa intercettata.');
    }

    if (ctx.savedSections && Object.keys(ctx.savedSections).length) {
        parts.push('\nSezioni già salvate: ' + Object.entries(ctx.savedSections).map(([k,v]) => k+':'+v).join(', '));
    }

    parts.push('\nAnalizza e dimmi la prima azione.');
    return parts.join('\n');
}

function buildFollowUp(ctx, result) {
    const parts = [result];

    if (ctx.intercepted?.length) {
        const big = ctx.intercepted.filter(a => a.size > 30000);
        if (big.length) {
            parts.push('\nAPI grosse:');
            big.slice(0, 4).forEach(api => {
                parts.push(`${Math.round(api.size / 1024)}KB ${api.isJson ? 'JSON' : 'altro'} ${api.url.substring(0, 80)}`);
                if (api.type === 'array') parts.push(`  → ${api.length} elem: ${api.sample}`);
                if (api.arrays) api.arrays.slice(0, 2).forEach(a => parts.push(`  → ${a.key}(${a.length}): ${a.sampleItem}`));
            });
        }
    }

    if (ctx.savedSections && Object.keys(ctx.savedSections).length) {
        parts.push('Sezioni salvate: ' + Object.entries(ctx.savedSections).map(([k,v]) => k+':'+v).join(', '));
    }

    parts.push(`\nStep ${ctx.step}/${ctx.maxSteps}. Prossima azione?`);
    return parts.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════
//  HANDLE AGENT REQUEST
// ═══════════════════════════════════════════════════════════════════════
async function handleNeedHelp(agentWs, msg) {
    const ctx = msg.context;
    const host = ctx.host;

    if (!API_KEY) {
        agentWs.send(JSON.stringify({ type: 'error', message: 'ANTHROPIC_API_KEY non configurata sul server' }));
        return;
    }

    // Costruisci messaggio
    const userMsg = msg.isFirst
        ? buildFirstMessage(ctx)
        : buildFollowUp(ctx, msg.result || 'Nessun risultato');

    // Chiama Claude
    const response = await askClaude(host, userMsg);

    if (response.error) {
        agentWs.send(JSON.stringify({ type: 'error', message: 'Claude API: ' + response.error }));
        return;
    }

    // Parsa la risposta
    const parsed = parseAction(response.text);
    if (!parsed?.action) {
        console.log(`[${host}] ⚠️ Non parsabile: ${response.text}`);
        agentWs.send(JSON.stringify({
            type: 'action',
            reasoning: '[ERRORE] Risposta Claude non parsabile, provo scrape_dom',
            action: { type: 'scrape_dom' }
        }));
        return;
    }

    // Anti-loop
    if (checkLoop(host, parsed.action)) {
        console.log(`[${host}] ⚠️ Loop "${parsed.action.type}" → richiedo alternativa`);
        // Chiedi a Claude di suggerire qualcosa di diverso
        const loopMsg = `ERRORE: azione "${parsed.action.type}: ${parsed.action.value || ''}" già eseguita. Azioni fatte: ${[...getSession(host).actionKeys].join(', ')}. Suggerisci qualcosa di DIVERSO.`;
        const retry = await askClaude(host, loopMsg);
        if (retry.text) {
            const retryParsed = parseAction(retry.text);
            if (retryParsed?.action) {
                // Registra anche questa
                checkLoop(host, retryParsed.action);
                agentWs.send(JSON.stringify({
                    type: 'action',
                    reasoning: '[CLAUDE] ' + (retryParsed.reasoning || ''),
                    action: retryParsed.action
                }));
                return;
            }
        }
        // Fallback se anche il retry fallisce
        agentWs.send(JSON.stringify({
            type: 'action',
            reasoning: '[FALLBACK] Loop irrisolvibile',
            action: { type: 'done' }
        }));
        return;
    }

    // Invia azione all'agent
    agentWs.send(JSON.stringify({
        type: 'action',
        reasoning: '[CLAUDE] ' + (parsed.reasoning || ''),
        action: parsed.action
    }));
}

// ═══════════════════════════════════════════════════════════════════════
//  HTTP
// ═══════════════════════════════════════════════════════════════════════
app.use(express.json());

app.get('/', (req, res) => {
    const ss = {};
    sessions.forEach((s, h) => {
        ss[h] = {
            asks: s.asks,
            messages: s.messages.length,
            actions: s.actions.length,
            tokens: s.tokens,
            cost: `$${((s.tokens.input / 1000000) * 1 + (s.tokens.output / 1000000) * 5).toFixed(4)}`,
        };
    });
    res.json({
        status: 'ok',
        service: 'relay-v4-api',
        model: MODEL,
        apiKey: API_KEY ? 'set (' + API_KEY.substring(0, 10) + '...)' : 'NOT SET',
        agents: agents.size,
        uptime: Math.round(process.uptime()) + 's',
        sessions: ss,
    });
});

app.get('/sessions', (req, res) => {
    const out = {};
    sessions.forEach((s, h) => {
        out[h] = {
            messages: s.messages,
            actions: s.actions,
            tokens: s.tokens,
        };
    });
    res.json(out);
});

app.get('/sessions/:host/chat', (req, res) => {
    const s = sessions.get(req.params.host);
    if (!s) return res.status(404).json({ error: 'not found' });
    res.json(s.messages);
});

app.delete('/sessions', (req, res) => { sessions.clear(); res.json({ ok: true }); });
app.delete('/sessions/:host', (req, res) => { sessions.delete(req.params.host); res.json({ ok: true }); });

// ═══════════════════════════════════════════════════════════════════════
//  WEBSOCKET
// ═══════════════════════════════════════════════════════════════════════
wss.on('connection', (ws, req) => {
    console.log(`[+] ${req.headers['x-forwarded-for'] || req.socket.remoteAddress}`);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw);

            if (msg.type === 'register') {
                agents.add(ws);
                ws._role = 'agent';
                ws.send(JSON.stringify({ type: 'registered', role: 'agent', mode: 'direct-api-v4' }));
                console.log(`[agent] Registrato (${agents.size})`);
                return;
            }

            if (ws._role === 'agent' && msg.type === 'need_help') {
                handleNeedHelp(ws, msg);
                return;
            }

            if (msg.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong' }));
                return;
            }
        } catch (e) {
            console.error('[err]', e.message);
        }
    });

    ws.on('close', () => {
        agents.delete(ws);
    });
});

setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

// Pulizia sessioni >2h
setInterval(() => {
    const cut = Date.now() - 7200000;
    sessions.forEach((s, h) => { if (s.ts < cut) sessions.delete(h); });
}, 300000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Relay v4 (direct API) on :${PORT}`);
    console.log(`Model: ${MODEL}`);
    console.log(`API Key: ${API_KEY ? 'configured' : '⚠️ NOT SET'}`);
});
