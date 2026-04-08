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
  Esegue una fetch HTTP e ti manda un campione del contenuto.
  ⚠️ ATTENZIONE: fetch_api scarica il contenuto RAW ma NON esegue JavaScript!
  Se la risposta è HTML con dati JS inline (window.X = ...), il fetch NON li rende disponibili.
  Per accedere a dati JS inline → usa NAVIGATE + eval_js, NON fetch_api.
  Usa fetch_api SOLO per endpoint che restituiscono JSON puro.
  GET: {"type":"fetch_api","value":"https://api.sito.it/games","method":"GET"}
  POST: {"type":"fetch_api","value":"https://api.sito.it/games","method":"POST","body":"{\\"category\\":\\"slot\\"}"}

fetch_paginated
  Fetcha un endpoint paginato. Lo script itera tutte le pagine.
  {"type":"fetch_paginated","value":"https://api.sito.it/games","pageParam":"page","pageSize":50,"maxPages":30}

scrape_dom
  Estrae giochi dal DOM della pagina CORRENTE: immagini, data-attributes, JSON inline.
  {"type":"scrape_dom"}

eval_js
  Esegue JavaScript nel contesto della pagina CORRENTE.
  ⚠️ CRITICO: eval_js funziona SOLO sulla pagina dove l'agent si trova adesso!
  Se devi estrarre dati da /livecasino, PRIMA naviga a /livecasino, POI usa eval_js.
  Se sei su /casino e fai eval_js, ottieni i dati di /casino, NON di /livecasino!
  Il risultato ti dice sempre "[Pagina: URL]" per confermare dove sei.
  {"type":"eval_js","value":"window.casinoData.giochi"}

scan_js
  Scansiona la pagina CORRENTE cercando variabili JS globali con dati.
  Stesse regole di eval_js: funziona solo sulla pagina dove sei.
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

verify_urls
  Testa N URL dal catalogo (HEAD request) per verificare che funzionino (200 OK).
  {"type":"verify_urls","value":"3"}
  Restituisce quanti funzionano e quali no. Usa SEMPRE dopo fetch_merge per controllare.

fix_urls
  Corregge gli URL nel catalogo: sostituisce un prefisso con un altro.
  {"type":"fix_urls","value":"https://sito.it/slots/","oldPrefix":"https://sito.it/"}
  Utile se verify_urls mostra che gli URL hanno il prefisso sbagliato.

run
  Esegue codice JS arbitrario con accesso ai dati. Variabili disponibili: CATALOG (array giochi), APIS (dati API salvati), SAMPLES (campioni API). Assegna il risultato a RESULT.
  {"type":"run","value":"var count = CATALOG.filter(g => g.url).length; RESULT = 'Giochi con URL: ' + count"}

download
  Scarica i dati correnti come file JSON.
  {"type":"download","filename":"sito_catalog.json"}

save_section
  RICHIEDE il salvataggio del catalogo corrente. Lo script VALIDA i dati automaticamente (controlla che siano giochi casino, non sport/bingo) e ti chiede conferma con un campione. Se i dati sono OK rispondi con confirm_save, altrimenti retry_different.
  {"type":"save_section","value":"casino"}

confirm_save
  Conferma il salvataggio. Lo script CLASSIFICA AUTOMATICAMENTE ogni gioco (slot/casino/casino-live) in base a nome e provider, non alla sezione del sito. Es: "Lightning Roulette" di Evolution → casino-live, "Book of Ra" → slot, anche se il sito li mette tutti sotto /casino.
  {"type":"confirm_save","value":"casino"}

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
COSA CERCHIAMO (e cosa NO)
════════════════════════════════════════
CERCHIAMO SOLO:
- Slot machine / slot online
- Giochi da casino (roulette, blackjack, baccarat, poker da casino)
- Casino live / live casino (tavoli con croupier dal vivo)
- Game show live (Crazy Time, Monopoly Live, ecc.)

NON CERCHIAMO (IGNORA queste sezioni):
- Scommesse sportive / sport / virtual sport / sport virtuali
- Bingo / bingo live
- Poker online (tornei poker, cash game)
- Lotterie (Lotto, Gratta e Vinci, 10eLotto)
- Carte (Scopa, Briscola, Burraco)
- Ippica / corse
- Tornei casino (classifiche, leaderboard) — NON sono cataloghi giochi
- Crash games / Aviator (se in sezione separata)

Se navighi e finisci su una pagina sbagliata → FERMATI, torna a una sezione casino.
Se l'agent ti dice "⚠️ ATTENZIONE: pagina NON-CASINO" → naviga SUBITO altrove.
Se un'API ha campi ds/disciplina/quota/match → dati sportivi, IGNORA.
Se i nomi sono "BI_BINGO01" o "PSG - Liverpool" → NON sono giochi casino.
Se un URL API contiene TOURNAMENT o VIRTUAL → IGNORA, non è un catalogo.

════════════════════════════════════════
STRATEGIA
════════════════════════════════════════
FASE 1 — MAPPATURA SEZIONI
- Guarda i link di navigazione per capire quali sezioni CASINO ha il sito
- Sezioni valide: /slots, /casino, /livecasino, /casino-live, /live-casino
- Sezioni da IGNORARE: /sport, /bingo, /poker, /lotterie, /carte, /ippica, /virtual
- Non tutti i siti hanno le stesse sezioni! Su alcuni le slot sono dentro /casino
- Le API spesso hanno system_code nel URL (SITO_SLOT, SITO_LIVE, SITO_CASINO)

FASE 2 — ESTRAZIONE PER SEZIONE
- Per ogni sezione casino: naviga → wait_apis → analizza campioni → estrai → fetch_merge URL → verify_urls → save_section
- PRIMA di save_section, VERIFICA i dati: guarda il campione. I giochi devono avere nomi tipo "Book of Ra", "Lightning Roulette", "Crazy Time" — NON "PSG-Liverpool" o "BI_BINGO01"
- Se il campione sembra sospetto (nomi con squadre, codici bingo, quote) → NON salvare, cerca altrove
- API con system_code tipo XXXXX_LIVE → catalogo live casino (NON bingo live!)
- Su alcuni siti le slot sono dentro casino → se /casino ha 3000+ giochi con nomi di slot, le slot sono lì

⚠️ REGOLA CRITICA — FETCH vs NAVIGATE:
- Se una pagina è HTML (non JSON), il suo JavaScript NON viene eseguito con fetch_api
- Per accedere a window.casinoData o altre variabili JS → devi NAVIGARE alla pagina, poi eval_js
- Esempio SBAGLIATO: fetch_api /livecasino → ricevi HTML → eval_js (FALLISCE perché sei ancora sulla pagina precedente)
- Esempio CORRETTO: navigate /livecasino → wait_apis 5000 → scan_js → eval_js window.casinoData.giochi
- Guarda sempre "[Pagina: URL]" nel risultato per sapere dove sei. Se devi dati da un'altra pagina → NAVIGA prima!

FASE 3 — VERIFICA COMPLETEZZA
- Dopo save_section, confronta i conteggi: se il DOM dice "Tutti (365)" e hai 365 → OK
- Se hai molto meno → cerca API paginata o scroll
- Prima di download_all, verifica che TUTTE le sezioni casino siano state salvate
- Il risultato finale deve avere giochi di casino REALI con: nome, provider, URL
- La CLASSIFICAZIONE (slot/casino/casino-live) è AUTOMATICA basata su nome e provider, non sulla sezione del sito. Non preoccuparti se il sito mette tutto sotto /casino — lo script classifica correttamente ogni gioco

REGOLE
1. Guarda le API intercettate — array con name/title/provider = catalogo
2. API grossa non-JSON = HTML con dati JS inline → NAVIGA alla pagina poi scan_js/eval_js (NON fetch!)
3. Nessuna API utile → naviga alla sezione, poi wait_apis per intercettare
4. Dopo navigate senza API → scroll per lazy load
5. Endpoint JSON sospetto → fetch_api (solo se è JSON, mai se è HTML!)
6. scrape_dom solo come ultima risorsa
7. MAI scaricare senza verificare che i dati siano GIOCHI CASINO reali
8. MAI ripetere un'azione già fatta
9. Preferisci SEMPRE JSON da API rispetto a scrape DOM
10. OGNI sezione DEVE avere URL! Fai SEMPRE fetch_merge su OGNI sezione prima di save_section. Se non trovi URL via API, costruiscili dal nome/slug del gioco
11. DOPO fetch_merge, usa SEMPRE verify_urls per testare gli URL
12. Se verify_urls dà 404, usa fix_urls per correggere il prefisso
13. MAI save_section senza URL — se i giochi non hanno URL, prima fai fetch_merge o costruiscili
14. Per cambiare sezione: save_section → navigate nuova sezione → wait_apis → estrai → fetch_merge → verify_urls → save_section
15. Rispondi SEMPRE e SOLO col JSON, max 15 parole nel reasoning`;

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
            tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
        });
    }
    return sessions.get(host);
}

// ═══════════════════════════════════════════════════════════════════════
//  RATE LIMITER — max 40K input tokens/min (buffer sotto il limite di 50K)
// ═══════════════════════════════════════════════════════════════════════
const rateLimiter = {
    tokenLog: [],  // [{ts, tokens}]
    MAX_TOKENS_PER_MIN: 40000,
    MIN_INTERVAL_MS: 3000,  // minimo 3s tra richieste
    lastRequestTs: 0,

    async waitIfNeeded(estimatedTokens) {
        const now = Date.now();

        // Pulisci log vecchi (>60s)
        this.tokenLog = this.tokenLog.filter(e => now - e.ts < 60000);

        // Calcola token usati nell'ultimo minuto
        const usedTokens = this.tokenLog.reduce((sum, e) => sum + e.tokens, 0);

        // Se sforiamo, aspetta
        if (usedTokens + estimatedTokens > this.MAX_TOKENS_PER_MIN) {
            const oldestTs = this.tokenLog.length ? this.tokenLog[0].ts : now;
            const waitMs = 60000 - (now - oldestTs) + 1000; // aspetta che il più vecchio scada + 1s buffer
            console.log(`[rate] ⏳ ${usedTokens}+${estimatedTokens} > ${this.MAX_TOKENS_PER_MIN} tokens/min → attendo ${Math.round(waitMs/1000)}s`);
            await new Promise(r => setTimeout(r, waitMs));
        }

        // Intervallo minimo tra richieste
        const elapsed = now - this.lastRequestTs;
        if (elapsed < this.MIN_INTERVAL_MS) {
            const wait = this.MIN_INTERVAL_MS - elapsed;
            await new Promise(r => setTimeout(r, wait));
        }

        this.lastRequestTs = Date.now();
    },

    record(tokens) {
        this.tokenLog.push({ ts: Date.now(), tokens });
    }
};

// ═══════════════════════════════════════════════════════════════════════
//  CLAUDE API
// ═══════════════════════════════════════════════════════════════════════
async function askClaude(host, userMessage, retryCount) {
    retryCount = retryCount || 0;
    const session = getSession(host);
    session.asks++;

    // Aggiungi messaggio utente alla conversazione
    session.messages.push({ role: 'user', content: userMessage });

    // Tieni max 20 messaggi per non sforare il contesto
    if (session.messages.length > 20) {
        session.messages = session.messages.slice(-14);
    }

    // Prepara messaggi con caching: marca il primo messaggio per cache
    const apiMessages = session.messages.map((m, i) => {
        if (i === 0) {
            // Il primo messaggio (contesto iniziale) viene cachato
            return { role: m.role, content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }] };
        }
        return m;
    });

    // Stima token (~4 char per token)
    const estimatedTokens = Math.round((SYSTEM_PROMPT.length + session.messages.reduce((s, m) => s + m.content.length, 0)) / 4);

    // Rate limit
    await rateLimiter.waitIfNeeded(estimatedTokens);

    console.log(`[${host}] 🤖 Claude ask #${session.asks} (~${estimatedTokens} tokens, ${session.messages.length} msgs)`);

    try {
        const body = JSON.stringify({
            model: MODEL,
            max_tokens: 300,
            // System prompt come array con cache_control
            system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
            messages: apiMessages,
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
                    'anthropic-beta': 'prompt-caching-2024-07-31',
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

        // Registra token usati per il rate limiter
        const actualTokens = (result.usage?.input_tokens || estimatedTokens) + (result.usage?.output_tokens || 0);
        rateLimiter.record(actualTokens);

        if (result.usage) {
            session.tokens.input += result.usage.input_tokens || 0;
            session.tokens.output += result.usage.output_tokens || 0;
            session.tokens.cache_read += result.usage.cache_read_input_tokens || 0;
            session.tokens.cache_write += result.usage.cache_creation_input_tokens || 0;
        }

        session.messages.push({ role: 'assistant', content: text });
        const cached = result.usage?.cache_read_input_tokens ? ` (${result.usage.cache_read_input_tokens} cached)` : '';
        console.log(`[${host}] ✅ Claude: ${text.substring(0, 100)}${cached}`);
        return { text };

    } catch (e) {
        console.error(`[${host}] ❌ ${e.message}`);

        // Rimuovi l'ultimo messaggio user dalla conversazione (non ha ricevuto risposta)
        if (session.messages.length && session.messages[session.messages.length - 1].role === 'user') {
            session.messages.pop();
        }

        // Retry su 429 (rate limit)
        if (e.message.includes('429') && retryCount < 3) {
            const waitSec = 15 * (retryCount + 1); // 15s, 30s, 45s
            console.log(`[${host}] 🔄 Retry #${retryCount + 1} tra ${waitSec}s...`);
            await new Promise(r => setTimeout(r, waitSec * 1000));
            session.asks--; // non contare il retry come ask separata
            return askClaude(host, userMessage, retryCount + 1);
        }

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

    // Sezioni del sito rilevate dal menu
    if (ctx.siteSections?.length) {
        parts.push('\nSezioni del sito (dal menu):');
        ctx.siteSections.forEach(s => parts.push(`  ${s.name} → ${s.url}`));
    }

    // Conteggi giochi visibili nel DOM
    if (ctx.gameCounts?.length) {
        parts.push('\nConteggi giochi visibili nel DOM:');
        ctx.gameCounts.forEach(g => parts.push(`  ${g.count} giochi — ${g.label}`));
    }

    if (ctx.links?.length) {
        parts.push('\nLink rilevanti:');
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
        parts.push('\nSezioni GIÀ SALVATE: ' + Object.entries(ctx.savedSections).map(([k,v]) => k+':'+v).join(', '));
        parts.push('Devi ancora completare le sezioni mancanti!');
    }

    parts.push('\nAnalizza le sezioni del sito, le API intercettate, e dimmi la prima azione.');
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

    // Sezioni del sito (se cambiate dopo navigazione)
    if (ctx.siteSections?.length) {
        parts.push('Sezioni sito: ' + ctx.siteSections.map(s => s.name + '→' + s.url.substring(0, 60)).join(' | '));
    }

    if (ctx.savedSections && Object.keys(ctx.savedSections).length) {
        parts.push('Salvate: ' + Object.entries(ctx.savedSections).map(([k,v]) => k+':'+v).join(', '));
    }

    // Game counts dal DOM
    if (ctx.gameCounts?.length) {
        parts.push('Giochi nel DOM: ' + ctx.gameCounts.map(g => g.count + ' (' + g.label.substring(0,20) + ')').join(', '));
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
            cost: `$${(
                (s.tokens.input / 1000000) * 1 + 
                (s.tokens.output / 1000000) * 5 + 
                (s.tokens.cache_write / 1000000) * 1.25 + 
                (s.tokens.cache_read / 1000000) * 0.1
            ).toFixed(4)}`,
        };
    });
    const recentTokens = rateLimiter.tokenLog.filter(e => Date.now() - e.ts < 60000).reduce((s, e) => s + e.tokens, 0);
    res.json({
        status: 'ok',
        service: 'relay-v4-api',
        model: MODEL,
        apiKey: API_KEY ? 'set (' + API_KEY.substring(0, 10) + '...)' : 'NOT SET',
        agents: agents.size,
        uptime: Math.round(process.uptime()) + 's',
        rateLimit: `${recentTokens}/${rateLimiter.MAX_TOKENS_PER_MIN} tokens/min`,
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
