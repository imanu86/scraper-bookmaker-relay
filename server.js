// ═══════════════════════════════════════════════════════════════════════
//  Scraper Bookmaker Relay v2 — Smart Relay
//  Rules engine + session memory + fallback a Claude bridge
//
//  L'80% delle decisioni viene preso dal server.
//  Solo i casi ambigui passano al bridge (claude.ai).
//
//  Deploy: Railway, set PORT env var
// ═══════════════════════════════════════════════════════════════════════

const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 2 * 1024 * 1024 }); // 2MB

// ─── Connections ───
let agents = new Set();
let activeAgent = null;
let bridge = null;

// ═══════════════════════════════════════════════════════════════════════
//  SESSION MEMORY — tiene traccia di tutto per ogni host
// ═══════════════════════════════════════════════════════════════════════
const sessions = new Map(); // host → session

function getSession(host) {
    if (!sessions.has(host)) {
        sessions.set(host, {
            host,
            startedAt: Date.now(),
            step: 0,
            actions: [],           // tutte le azioni eseguite
            actionKeys: new Set(), // hash per anti-loop
            catalogs: [],
            bestCount: 0,
            pagesVisited: [],
            apisCalled: [],
            domScraped: false,
            scrolled: false,
            downloaded: false,
            claudeAsks: 0,        // quante volte abbiamo chiesto a Claude
            localDecisions: 0,    // quante volte abbiamo deciso da soli
            lastContext: null,
        });
    }
    return sessions.get(host);
}

function logSession(host, msg) {
    console.log(`[${host}] ${msg}`);
}

// ═══════════════════════════════════════════════════════════════════════
//  KNOWN BOOKMAKER PATTERNS
//  Strategie note per siti già visti
// ═══════════════════════════════════════════════════════════════════════
const KNOWN_PATTERNS = {
    'sisal.it': {
        strategy: 'api',
        steps: [
            { action: { type: 'navigate', value: '/casinogames/slot' }, reasoning: 'Sisal: navigo alla pagina slot per triggerare le API' },
            { action: { type: 'fetch_api', value: 'https://recommender.sisal.it/recommender/v2/casino/games?pageSize=1000&category=slot', method: 'GET' }, reasoning: 'Sisal: endpoint recommender noto con tutti i giochi' },
        ]
    },
    'snai.it': {
        strategy: 'api_paginated',
        steps: [
            { action: { type: 'navigate', value: '/casino/slot' }, reasoning: 'SNAI: navigo alle slot per attivare le API' },
            { action: { type: 'fetch_paginated', value: 'https://apipreview.snai.it/v2/casino/games', pageParam: 'pageNumber', pageSize: 48, maxPages: 60 }, reasoning: 'SNAI: API paginata nota' },
        ]
    },
    'lottomatica.it': {
        strategy: 'api',
        steps: [
            { action: { type: 'navigate', value: '/casino/slot' }, reasoning: 'Lottomatica: pagina slot' },
            { action: { type: 'fetch_api', value: 'https://www.lottomatica.it/api/casino/GetGamesListLight', method: 'POST', body: '{"category":"slot","pageSize":1000}' }, reasoning: 'Lottomatica: API POST nota' },
        ]
    },
    'betflag.it': {
        strategy: 'navigate_scrape',
        steps: [
            { action: { type: 'navigate', value: '/casino/slots' }, reasoning: 'Betflag: pagina slot' },
            { action: { type: 'scroll', value: 'bottom' }, reasoning: 'Betflag: scroll per lazy load' },
            { action: { type: 'scrape_dom' }, reasoning: 'Betflag: scrape DOM dopo scroll' },
        ]
    },
    'bet365.it': {
        strategy: 'navigate_scrape',
        steps: [
            { action: { type: 'navigate', value: '/casino/slot' }, reasoning: 'Bet365: pagina slot' },
            { action: { type: 'scroll', value: 'bottom' }, reasoning: 'Bet365: scroll per caricare tutto' },
            { action: { type: 'scrape_dom' }, reasoning: 'Bet365: scrape DOM' },
        ]
    },
    'goldbet.it': {
        strategy: 'navigate_scrape',
        steps: [
            { action: { type: 'navigate', value: '/casino/slot-machine' }, reasoning: 'Goldbet: navigo alle slot' },
            { action: { type: 'scrape_dom' }, reasoning: 'Goldbet: scrape DOM' },
        ]
    },
    'eurobet.it': {
        strategy: 'navigate_scrape',
        steps: [
            { action: { type: 'navigate', value: '/casino/slot' }, reasoning: 'Eurobet: pagina slot' },
            { action: { type: 'scrape_dom' }, reasoning: 'Eurobet: scrape DOM' },
        ]
    },
    'netbet.it': {
        strategy: 'navigate_scrape',
        steps: [
            { action: { type: 'navigate', value: '/slots' }, reasoning: 'NetBet: pagina slot' },
            { action: { type: 'scroll', value: 'bottom' }, reasoning: 'NetBet: scroll per caricare giochi' },
            { action: { type: 'scrape_dom' }, reasoning: 'NetBet: scrape DOM per immagini giochi' },
        ]
    },
    'starcasino.it': {
        strategy: 'navigate_scrape',
        steps: [
            { action: { type: 'navigate', value: '/casino/slot' }, reasoning: 'StarCasino: pagina slot' },
            { action: { type: 'scrape_dom' }, reasoning: 'StarCasino: scrape DOM' },
        ]
    },
    'leovegas.it': {
        strategy: 'navigate_scrape',
        steps: [
            { action: { type: 'navigate', value: '/it-it/casino/slot' }, reasoning: 'LeoVegas: pagina slot' },
            { action: { type: 'scroll', value: 'bottom' }, reasoning: 'LeoVegas: scroll per lazy load' },
            { action: { type: 'scrape_dom' }, reasoning: 'LeoVegas: scrape DOM' },
        ]
    },
    '888.it': {
        strategy: 'navigate_scrape',
        steps: [
            { action: { type: 'navigate', value: '/casino/slots/' }, reasoning: '888: pagina slot' },
            { action: { type: 'scrape_dom' }, reasoning: '888: scrape DOM' },
        ]
    },
    'williamhill.it': {
        strategy: 'navigate_scrape',
        steps: [
            { action: { type: 'navigate', value: '/casino/slots' }, reasoning: 'WilliamHill: pagina slot' },
            { action: { type: 'scrape_dom' }, reasoning: 'WilliamHill: scrape DOM' },
        ]
    },
    'pokerstars.it': {
        strategy: 'navigate_scrape',
        steps: [
            { action: { type: 'navigate', value: '/casino/slots' }, reasoning: 'PokerStars: pagina slot' },
            { action: { type: 'scrape_dom' }, reasoning: 'PokerStars: scrape DOM' },
        ]
    },
    'admiralbet.it': {
        strategy: 'navigate_scrape',
        steps: [
            { action: { type: 'navigate', value: '/casino/slot' }, reasoning: 'AdmiralBet: pagina slot' },
            { action: { type: 'scrape_dom' }, reasoning: 'AdmiralBet: scrape DOM' },
        ]
    },
};

// ═══════════════════════════════════════════════════════════════════════
//  RULES ENGINE — decisioni automatiche
// ═══════════════════════════════════════════════════════════════════════

function tryDecideLocally(context) {
    const session = getSession(context.host);
    session.step = context.step;
    session.lastContext = context;

    // Aggiorna cataloghi nella sessione
    if (context.catalogs && context.catalogs.length > 0) {
        session.catalogs = context.catalogs;
        session.bestCount = Math.max(...context.catalogs.map(c => c.n || 0), 0);
    }

    const bestCount = session.bestCount;
    const domImgs = context.domImgs || 0;
    const hasCatalogs = session.catalogs.length > 0;
    const step = context.step || 0;
    const maxSteps = context.maxSteps || 15;
    const lastActions = context.lastActions || [];
    const apis = context.apis || [];
    const links = context.links || [];

    // ───────────────────────────────────────────────────
    //  REGOLA 0: Pattern noto per questo host
    // ───────────────────────────────────────────────────
    const hostKey = Object.keys(KNOWN_PATTERNS).find(k => context.host.includes(k));
    if (hostKey && !session._patternExhausted) {
        const pattern = KNOWN_PATTERNS[hostKey];
        // Trova il prossimo step del pattern non ancora eseguito
        const doneCount = session.actions.filter(a => a.source === 'pattern').length;
        if (doneCount < pattern.steps.length) {
            const next = pattern.steps[doneCount];
            // Non ripetere se già fatto
            const key = (next.action.type) + '|' + (next.action.value || '').substring(0, 50);
            if (!session.actionKeys.has(key)) {
                logSession(context.host, `📋 Pattern "${hostKey}" step ${doneCount + 1}/${pattern.steps.length}`);
                return { ...next, _source: 'pattern' };
            }
        }
        session._patternExhausted = true;
        logSession(context.host, `📋 Pattern "${hostKey}" esaurito, passo a regole`);
    }

    // ───────────────────────────────────────────────────
    //  REGOLA 1: Catalogo grande → download + done
    // ───────────────────────────────────────────────────
    if (bestCount >= 100 && !session.downloaded) {
        logSession(context.host, `✅ ${bestCount} giochi trovati → download`);
        session.downloaded = true;
        return {
            reasoning: `Trovati ${bestCount} giochi, catalogo sufficiente → download`,
            action: { type: 'download', filename: context.host + '_catalog.json' },
            _source: 'rule'
        };
    }

    // Se già scaricato → done
    if (session.downloaded) {
        logSession(context.host, `✅ Già scaricato → done`);
        return {
            reasoning: 'Catalogo già scaricato, completato',
            action: { type: 'done' },
            _source: 'rule'
        };
    }

    // ───────────────────────────────────────────────────
    //  REGOLA 2: Tante immagini DOM ma nessun JSON → scrape
    // ───────────────────────────────────────────────────
    if (domImgs >= 20 && !hasCatalogs && !session.domScraped) {
        logSession(context.host, `🔍 ${domImgs} immagini DOM senza JSON → scrape_dom`);
        session.domScraped = true;
        return {
            reasoning: `${domImgs} immagini giochi nel DOM ma nessun catalogo JSON → scrape DOM`,
            action: { type: 'scrape_dom' },
            _source: 'rule'
        };
    }

    // ───────────────────────────────────────────────────
    //  REGOLA 3: Dopo scrape DOM con risultati → download se bastano
    // ───────────────────────────────────────────────────
    if (session.domScraped && bestCount >= 15 && bestCount < 100 && !session.scrolled) {
        logSession(context.host, `📜 ${bestCount} giochi da DOM, provo scroll per caricarne altri`);
        session.scrolled = true;
        return {
            reasoning: `${bestCount} giochi trovati via DOM ma probabilmente ce ne sono altri → scroll per lazy load`,
            action: { type: 'scroll', value: 'bottom' },
            _source: 'rule'
        };
    }

    // Dopo scroll → ri-scrape
    if (session.scrolled && session.domScraped && !session._rescrapedAfterScroll) {
        session._rescrapedAfterScroll = true;
        logSession(context.host, `🔍 Re-scrape dopo scroll`);
        return {
            reasoning: 'Scroll completato → ri-scrape DOM per nuovi elementi caricati',
            action: { type: 'scrape_dom' },
            _source: 'rule'
        };
    }

    // ───────────────────────────────────────────────────
    //  REGOLA 4: API grossa intercettata → prova fetch
    // ───────────────────────────────────────────────────
    if (apis.length > 0 && !hasCatalogs) {
        const bigApi = apis.find(a =>
            a.s > 50000 &&
            !session.apisCalled.includes(a.u) &&
            !/google|analytics|gtm|facebook|optimove|iesnare|boomerang/.test(a.u)
        );
        if (bigApi) {
            session.apisCalled.push(bigApi.u);
            logSession(context.host, `📡 API grossa (${Math.round(bigApi.s / 1024)}KB) → fetch`);
            return {
                reasoning: `API intercettata di ${Math.round(bigApi.s / 1024)}KB sembra contenere dati → fetch diretto`,
                action: { type: 'fetch_api', value: bigApi.u, method: bigApi.m || 'GET' },
                _source: 'rule'
            };
        }
    }

    // ───────────────────────────────────────────────────
    //  REGOLA 5: Siamo alla home / pagina generica → trova link casino/slot
    // ───────────────────────────────────────────────────
    if (step <= 2 && !hasCatalogs && session.pagesVisited.length === 0) {
        // Cerca link casino/slot nei link disponibili
        const slotLink = links.find(l =>
            /slot/i.test(l.h + ' ' + l.t) &&
            !/(sport|live|promo|bonus|help|faq|login|registr)/i.test(l.h)
        );
        const casinoLink = links.find(l =>
            /casino/i.test(l.h + ' ' + l.t) &&
            !/(sport|live|promo|bonus|help|faq|login|registr)/i.test(l.h) &&
            !/live.?casino/i.test(l.h + ' ' + l.t)
        );
        const target = slotLink || casinoLink;
        if (target) {
            session.pagesVisited.push(target.h);
            logSession(context.host, `🔗 Link trovato: "${target.t}" → ${target.h}`);
            return {
                reasoning: `Trovato link "${target.t}" → navigo per cercare catalogo giochi`,
                action: { type: 'navigate', value: target.h },
                _source: 'rule'
            };
        }
    }

    // ───────────────────────────────────────────────────
    //  REGOLA 6: Pochi step rimasti → forza scrape e download
    // ───────────────────────────────────────────────────
    if (step >= maxSteps - 2) {
        if (bestCount > 0 && !session.downloaded) {
            logSession(context.host, `⏱ Ultimi step, download forzato (${bestCount} giochi)`);
            session.downloaded = true;
            return {
                reasoning: `Quasi al limite step → download forzato con ${bestCount} giochi`,
                action: { type: 'download', filename: context.host + '_catalog.json' },
                _source: 'rule'
            };
        }
        if (!session.domScraped) {
            session.domScraped = true;
            return {
                reasoning: 'Ultimi step senza dati → tentativo scrape DOM finale',
                action: { type: 'scrape_dom' },
                _source: 'rule'
            };
        }
        return {
            reasoning: 'Limite step raggiunto, termino',
            action: { type: 'done' },
            _source: 'rule'
        };
    }

    // ───────────────────────────────────────────────────
    //  REGOLA 7: Catalogo piccolo (15-99) + link "tutti/all" → naviga
    // ───────────────────────────────────────────────────
    if (bestCount >= 15 && bestCount < 100) {
        const allLink = links.find(l =>
            /tutt|all|complet|vedi.?tutt|mostra.?tutt|show.?all|load.?more/i.test(l.t) &&
            !session.pagesVisited.includes(l.h)
        );
        if (allLink) {
            session.pagesVisited.push(allLink.h);
            logSession(context.host, `🔗 Link "tutti": "${allLink.t}" → ${allLink.h}`);
            return {
                reasoning: `${bestCount} giochi ma c'è link "${allLink.t}" che potrebbe caricare il catalogo completo`,
                action: { type: 'navigate', value: allLink.h },
                _source: 'rule'
            };
        }
    }

    // ───────────────────────────────────────────────────
    //  NESSUNA REGOLA → passa a Claude
    // ───────────────────────────────────────────────────
    return null;
}

// ═══════════════════════════════════════════════════════════════════════
//  ANTI-LOOP — blocca azioni ripetute
// ═══════════════════════════════════════════════════════════════════════
function checkAndRecordAction(host, action, source) {
    const session = getSession(host);
    const key = (action.type) + '|' + (action.value || '').substring(0, 50);

    if (session.actionKeys.has(key)) {
        logSession(host, `⚠️ LOOP bloccato: ${key} (già fatto)`);
        // Invece di ripetere, forziamo una strategia alternativa
        return getAntiLoopFallback(session);
    }

    session.actionKeys.add(key);
    session.actions.push({
        step: session.step,
        type: action.type,
        value: action.value,
        source,
        ts: Date.now()
    });

    return null; // nessun loop, procedi normalmente
}

function getAntiLoopFallback(session) {
    // Escalation progressiva
    if (!session.domScraped) {
        session.domScraped = true;
        return { reasoning: 'Loop rilevato → scrape DOM forzato', action: { type: 'scrape_dom' }, _source: 'antiloop' };
    }
    if (!session.scrolled) {
        session.scrolled = true;
        return { reasoning: 'Loop rilevato → scroll forzato', action: { type: 'scroll', value: 'bottom' }, _source: 'antiloop' };
    }
    if (session.bestCount > 0 && !session.downloaded) {
        session.downloaded = true;
        return { reasoning: `Loop rilevato → download forzato (${session.bestCount} giochi)`, action: { type: 'download' }, _source: 'antiloop' };
    }
    return { reasoning: 'Loop irrisolvibile → stop', action: { type: 'done' }, _source: 'antiloop' };
}

// ═══════════════════════════════════════════════════════════════════════
//  HANDLE NEED_HELP — il cuore del relay intelligente
// ═══════════════════════════════════════════════════════════════════════
function handleNeedHelp(agentWs, msg) {
    const ctx = msg.context;
    const session = getSession(ctx.host);

    // 1. Prova decisione locale (rules engine)
    let decision = tryDecideLocally(ctx);

    if (decision) {
        // Anti-loop check
        const loopAction = checkAndRecordAction(ctx.host, decision.action, decision._source || 'rule');
        if (loopAction) decision = loopAction;

        session.localDecisions++;
        logSession(ctx.host, `🧠 Decisione locale #${session.localDecisions}: ${decision.action.type} → ${(decision.action.value || '').substring(0, 60)}`);

        // Manda direttamente all'agent, senza passare da Claude
        agentWs.send(JSON.stringify({
            type: 'action',
            reasoning: `[AUTO] ${decision.reasoning}`,
            action: decision.action
        }));
        return;
    }

    // 2. Nessuna regola → passa al bridge (Claude)
    session.claudeAsks++;
    logSession(ctx.host, `🌉 Passo a Claude (ask #${session.claudeAsks}) — nessuna regola applicabile`);

    // Arricchisci il contesto con la memoria della sessione
    const enrichedMsg = {
        ...msg,
        context: {
            ...ctx,
            sessionHistory: session.actions.slice(-8).map(a => `${a.source}:${a.type}→${(a.value || '').substring(0, 40)}`),
            sessionStats: {
                localDecisions: session.localDecisions,
                claudeAsks: session.claudeAsks,
                bestCount: session.bestCount,
                domScraped: session.domScraped,
                scrolled: session.scrolled,
                pagesVisited: session.pagesVisited,
            }
        }
    };

    if (bridge && bridge.readyState === 1) {
        activeAgent = agentWs;
        bridge.send(JSON.stringify(enrichedMsg));
    } else {
        // Bridge non connesso → fallback
        logSession(ctx.host, `⚠️ Bridge offline → fallback locale`);
        const fallback = getFallbackAction(session, ctx);
        agentWs.send(JSON.stringify({
            type: 'action',
            reasoning: `[FALLBACK] ${fallback.reasoning}`,
            action: fallback.action
        }));
    }
}

// Fallback quando Claude non è disponibile
function getFallbackAction(session, ctx) {
    const links = ctx.links || [];

    // Prova a navigare a qualche link utile non visitato
    const unvisited = links.find(l =>
        /slot|casino|game|gioc/i.test(l.h + ' ' + l.t) &&
        !session.pagesVisited.includes(l.h) &&
        !/(sport|live|promo|bonus|help|faq|login|registr)/i.test(l.h)
    );
    if (unvisited) {
        session.pagesVisited.push(unvisited.h);
        return { reasoning: `Bridge offline, provo link "${unvisited.t}"`, action: { type: 'navigate', value: unvisited.h } };
    }
    if (!session.domScraped) {
        session.domScraped = true;
        return { reasoning: 'Bridge offline → scrape DOM', action: { type: 'scrape_dom' } };
    }
    if (session.bestCount > 0) {
        session.downloaded = true;
        return { reasoning: `Bridge offline → download ${session.bestCount} giochi`, action: { type: 'download' } };
    }
    return { reasoning: 'Bridge offline, niente da fare → stop', action: { type: 'done' } };
}

// ═══════════════════════════════════════════════════════════════════════
//  HEALTH ENDPOINT — con stats
// ═══════════════════════════════════════════════════════════════════════
app.get('/', (req, res) => {
    const sessionStats = {};
    sessions.forEach((s, host) => {
        sessionStats[host] = {
            step: s.step,
            bestCount: s.bestCount,
            localDecisions: s.localDecisions,
            claudeAsks: s.claudeAsks,
            actions: s.actions.length,
            downloaded: s.downloaded,
        };
    });
    res.json({
        status: 'ok',
        service: 'scraper-bookmaker-relay v2 (smart)',
        agents: agents.size + ' connected' + (activeAgent ? ' (1 active)' : ''),
        bridge: bridge ? 'connected' : 'disconnected',
        uptime: Math.round(process.uptime()) + 's',
        knownPatterns: Object.keys(KNOWN_PATTERNS).length,
        sessions: sessionStats,
    });
});

// Endpoint per aggiungere pattern al volo
app.use(express.json());
app.post('/patterns', (req, res) => {
    const { host, steps } = req.body;
    if (!host || !steps) return res.status(400).json({ error: 'host + steps required' });
    KNOWN_PATTERNS[host] = { strategy: 'custom', steps };
    console.log(`[+] Pattern aggiunto: ${host} (${steps.length} steps)`);
    res.json({ ok: true, patterns: Object.keys(KNOWN_PATTERNS).length });
});

// Endpoint per vedere/pulire sessioni
app.get('/sessions', (req, res) => {
    const out = {};
    sessions.forEach((s, host) => {
        out[host] = {
            step: s.step,
            bestCount: s.bestCount,
            actions: s.actions,
            localDecisions: s.localDecisions,
            claudeAsks: s.claudeAsks,
        };
    });
    res.json(out);
});
app.delete('/sessions', (req, res) => {
    sessions.clear();
    res.json({ ok: true, msg: 'Sessioni pulite' });
});
app.delete('/sessions/:host', (req, res) => {
    sessions.delete(req.params.host);
    res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════
//  WEBSOCKET — gestione connessioni
// ═══════════════════════════════════════════════════════════════════════
wss.on('connection', (ws, req) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    console.log(`[+] Nuova connessione da ${ip}`);

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw);

            // Registrazione ruolo
            if (msg.type === 'register') {
                if (msg.role === 'agent') {
                    agents.add(ws);
                    ws._role = 'agent';
                    console.log(`[agent] Registrato (${agents.size} totali)`);
                    ws.send(JSON.stringify({
                        type: 'registered', role: 'agent',
                        bridge: bridge ? 'online' : 'offline',
                        mode: 'smart-relay-v2'
                    }));
                    if (bridge && bridge.readyState === 1)
                        bridge.send(JSON.stringify({ type: 'agent_status', status: 'connected' }));
                } else if (msg.role === 'bridge') {
                    bridge = ws;
                    ws._role = 'bridge';
                    console.log('[bridge] Registrato');
                    ws.send(JSON.stringify({
                        type: 'registered', role: 'bridge',
                        agent: agents.size > 0 ? 'online' : 'offline',
                        mode: 'smart-relay-v2'
                    }));
                    agents.forEach(a => {
                        if (a.readyState === 1) a.send(JSON.stringify({ type: 'bridge_status', status: 'connected' }));
                    });
                }
                return;
            }

            // ─── AGENT chiede aiuto → SMART ROUTING ───
            if (ws._role === 'agent' && msg.type === 'need_help') {
                console.log(`[agent] need_help da ${msg.context?.host || '?'} step ${msg.context?.step || '?'}`);
                handleNeedHelp(ws, msg);
                return;
            }

            // ─── BRIDGE risponde → forward a agent attivo ───
            if (ws._role === 'bridge' && msg.type === 'action') {
                const actionType = msg.action?.type || '?';
                console.log(`[bridge→agent] action: ${actionType}`);

                // Anti-loop check anche sulle risposte di Claude
                if (activeAgent && activeAgent.readyState === 1) {
                    const host = Array.from(sessions.keys()).pop(); // ultimo host attivo
                    if (host) {
                        const loopAction = checkAndRecordAction(host, msg.action, 'claude');
                        if (loopAction) {
                            logSession(host, `⚠️ Claude ha suggerito azione in loop → override`);
                            activeAgent.send(JSON.stringify({
                                type: 'action',
                                reasoning: `[ANTI-LOOP] ${loopAction.reasoning}`,
                                action: loopAction.action
                            }));
                            return;
                        }
                    }
                    activeAgent.send(JSON.stringify(msg));
                } else {
                    ws.send(JSON.stringify({ type: 'error', message: 'Agent attivo non connesso' }));
                }
                return;
            }

            if (msg.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
                return;
            }

            console.log(`[${ws._role || '?'}] Messaggio sconosciuto:`, msg.type);
        } catch (e) {
            console.error('[error] Parse:', e.message);
        }
    });

    ws.on('close', () => {
        console.log(`[-] ${ws._role || '?'} disconnesso`);
        if (ws._role === 'agent') {
            agents.delete(ws);
            if (ws === activeAgent) activeAgent = null;
            if (bridge && bridge.readyState === 1)
                bridge.send(JSON.stringify({ type: 'agent_status', status: agents.size + ' connected' }));
        }
        if (ws === bridge) {
            bridge = null;
            agents.forEach(a => {
                if (a.readyState === 1) a.send(JSON.stringify({ type: 'bridge_status', status: 'disconnected' }));
            });
        }
    });
});

// ─── Heartbeat ───
setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

// ─── Pulizia sessioni vecchie (>1h) ───
setInterval(() => {
    const cutoff = Date.now() - 3600000;
    sessions.forEach((s, host) => {
        if (s.startedAt < cutoff) {
            console.log(`[cleanup] Sessione ${host} rimossa (>1h)`);
            sessions.delete(host);
        }
    });
}, 300000);

// ─── Start ───
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Scraper Bookmaker Smart Relay v2 running on :${PORT}`);
    console.log(`Known patterns: ${Object.keys(KNOWN_PATTERNS).length} bookmakers`);
    console.log(`Bridge fallback: enabled`);
});
