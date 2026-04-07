// ═══════════════════════════════════════════════════════════════════════
//  Scraper Bookmaker Relay v2 — Smart Relay
//  Rules engine + data validation + session memory + bridge fallback
//
//  Flusso: agent manda contesto → server decide o chiede a Claude
//  Dopo scrape/download → agent manda dataReport → server valida
//  Se dati scarsi → chiede a Claude strategia alternativa
//
//  Deploy: Railway, set PORT env var
// ═══════════════════════════════════════════════════════════════════════

const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 2 * 1024 * 1024 });

// ─── Connections ───
let agents = new Set();
let activeAgent = null;
let bridge = null;

// ═══════════════════════════════════════════════════════════════════════
//  SESSION MEMORY
// ═══════════════════════════════════════════════════════════════════════
const sessions = new Map();

function getSession(host) {
    if (!sessions.has(host)) {
        sessions.set(host, {
            host,
            startedAt: Date.now(),
            step: 0,
            actions: [],
            actionKeys: new Set(),
            catalogs: [],
            bestCount: 0,
            bestScore: 0,
            pagesVisited: [],
            apisCalled: [],
            domScraped: false,
            domScrapedCount: 0,
            scrolled: false,
            scrollCount: 0,
            downloaded: false,
            approved: false,
            claudeAsks: 0,
            localDecisions: 0,
            lastDataReport: null,
            downloadHistory: [],
        });
    }
    return sessions.get(host);
}

function log(host, msg) {
    console.log(`[${host}] ${msg}`);
}

// ═══════════════════════════════════════════════════════════════════════
//  KNOWN API PATTERNS — solo quelli verificati con endpoint esatti
// ═══════════════════════════════════════════════════════════════════════
const KNOWN_API_PATTERNS = {
    'sisal.it': [
        { action: { type: 'navigate', value: '/casinogames/slot' }, reasoning: 'Sisal: navigo a slot per triggerare API' },
        { action: { type: 'fetch_api', value: 'https://recommender.sisal.it/recommender/v2/casino/games?pageSize=1000&category=slot', method: 'GET' }, reasoning: 'Sisal: endpoint recommender noto' },
    ],
    'snai.it': [
        { action: { type: 'navigate', value: '/casino/slot' }, reasoning: 'SNAI: navigo a slot' },
        { action: { type: 'fetch_paginated', value: 'https://apipreview.snai.it/v2/casino/games', pageParam: 'pageNumber', pageSize: 48, maxPages: 60 }, reasoning: 'SNAI: API paginata nota' },
    ],
    'lottomatica.it': [
        { action: { type: 'navigate', value: '/casino/slot' }, reasoning: 'Lottomatica: navigo a slot' },
        { action: { type: 'fetch_api', value: 'https://www.lottomatica.it/api/casino/GetGamesListLight', method: 'POST', body: '{"category":"slot","pageSize":1000}' }, reasoning: 'Lottomatica: API POST nota' },
    ],
};

// ═══════════════════════════════════════════════════════════════════════
//  RULES ENGINE
// ═══════════════════════════════════════════════════════════════════════

function tryDecideLocally(context) {
    const session = getSession(context.host);
    session.step = context.step;

    // Aggiorna sessione con dati dal contesto
    if (context.catalogs && context.catalogs.length > 0) {
        session.catalogs = context.catalogs;
        session.bestCount = Math.max(...context.catalogs.map(c => c.n || 0), 0);
    }
    if (context.dataReport) {
        session.lastDataReport = context.dataReport;
        session.bestScore = context.dataReport.score || 0;
    }

    const { bestCount, bestScore } = session;
    const domImgs = context.domImgs || 0;
    const hasCatalogs = session.catalogs.length > 0;
    const step = context.step || 0;
    const maxSteps = context.maxSteps || 25;
    const apis = context.apis || [];
    const links = context.links || [];
    const dataReport = context.dataReport;
    const downloadHistory = context.downloadHistory || [];

    // ─── PATTERN NOTO (solo API verificate) ───
    const hostKey = Object.keys(KNOWN_API_PATTERNS).find(k => context.host.includes(k));
    if (hostKey && !session._patternDone) {
        const steps = KNOWN_API_PATTERNS[hostKey];
        const done = session.actions.filter(a => a.source === 'pattern').length;
        if (done < steps.length) {
            const next = steps[done];
            const key = next.action.type + '|' + (next.action.value || '').substring(0, 50);
            if (!session.actionKeys.has(key)) {
                log(context.host, `📋 Pattern "${hostKey}" step ${done + 1}/${steps.length}`);
                return { ...next, _source: 'pattern' };
            }
        }
        session._patternDone = true;
    }

    // ─── DATI BUONI → approve ───
    if (dataReport && dataReport.score >= 60 && dataReport.count >= 50) {
        if (!session.downloaded) {
            session.downloaded = true;
            log(context.host, `✅ Dati buoni (${dataReport.score}/100, ${dataReport.count} giochi) → download`);
            return {
                reasoning: `Dati di buona qualità (score ${dataReport.score}/100, ${dataReport.count} giochi) → download`,
                action: { type: 'download', filename: context.host + '_catalog.json' },
                _source: 'rule'
            };
        }
        if (session.downloaded && !session.approved) {
            session.approved = true;
            log(context.host, `✅ Approvato!`);
            return {
                reasoning: `Catalogo scaricato e dati di qualità → completato`,
                action: { type: 'approve' },
                _source: 'rule'
            };
        }
    }

    // ─── DATI SCARSI DOPO DOWNLOAD → chiedi a Claude ───
    if (downloadHistory.length > 0 && dataReport && dataReport.score < 40) {
        log(context.host, `⚠️ Dati scarsi dopo download (score ${dataReport.score}) → chiedo a Claude`);
        return null; // forza passaggio a Claude con contesto pieno
    }

    // ─── CATALOGO GRANDE ma qualità sconosciuta → download per analizzare ───
    if (bestCount >= 100 && !session.downloaded && !dataReport) {
        session.downloaded = true;
        log(context.host, `📥 ${bestCount} giochi → download per analisi qualità`);
        return {
            reasoning: `${bestCount} giochi trovati, scarico per verificare la qualità dei dati`,
            action: { type: 'download', filename: context.host + '_catalog.json' },
            _source: 'rule'
        };
    }

    // ─── TANTE IMG DOM senza JSON → scrape (max 2 volte) ───
    if (domImgs >= 20 && !hasCatalogs && session.domScrapedCount < 2) {
        session.domScraped = true;
        session.domScrapedCount++;
        log(context.host, `🔍 ${domImgs} immagini DOM → scrape #${session.domScrapedCount}`);
        return {
            reasoning: `${domImgs} immagini giochi nel DOM ma nessun catalogo JSON → scrape DOM`,
            action: { type: 'scrape_dom' },
            _source: 'rule'
        };
    }

    // ─── Dopo scrape con pochi risultati → scroll ───
    if (session.domScraped && bestCount >= 5 && bestCount < 100 && session.scrollCount < 2) {
        session.scrollCount++;
        session.scrolled = true;
        log(context.host, `📜 ${bestCount} giochi, scroll #${session.scrollCount} per caricarne altri`);
        return {
            reasoning: `${bestCount} giochi trovati ma probabilmente incompleto → scroll per lazy load`,
            action: { type: 'scroll', value: 'bottom' },
            _source: 'rule'
        };
    }

    // ─── Dopo scroll → re-scrape ───
    if (session.scrolled && session.scrollCount > 0 && session.domScrapedCount < session.scrollCount + 1) {
        session.domScrapedCount++;
        log(context.host, `🔍 Re-scrape dopo scroll`);
        return {
            reasoning: 'Scroll completato → re-scrape per nuovi elementi',
            action: { type: 'scrape_dom' },
            _source: 'rule'
        };
    }

    // ─── API grossa non ancora fetchata ───
    if (apis.length > 0 && (!hasCatalogs || bestScore < 40)) {
        const bigApi = apis.find(a =>
            a.s > 50000 &&
            !session.apisCalled.includes(a.u) &&
            !/google|analytics|gtm|facebook|optimove|iesnare|boomerang|onetrust/.test(a.u)
        );
        if (bigApi) {
            session.apisCalled.push(bigApi.u);
            log(context.host, `📡 API (${Math.round(bigApi.s / 1024)}KB) → fetch`);
            return {
                reasoning: `API intercettata di ${Math.round(bigApi.s / 1024)}KB → fetch diretto`,
                action: { type: 'fetch_api', value: bigApi.u, method: bigApi.m || 'GET' },
                _source: 'rule'
            };
        }
    }

    // ─── Primo step, pagina generica → naviga a slot/casino ───
    if (step <= 3 && !hasCatalogs && session.pagesVisited.length === 0) {
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
            log(context.host, `🔗 Navigo a "${target.t}"`);
            return {
                reasoning: `Trovato link "${target.t}" → navigo per cercare catalogo`,
                action: { type: 'navigate', value: target.h },
                _source: 'rule'
            };
        }
    }

    // ─── Dopo navigazione in pagina con framework SPA → aspetta API ───
    if (session.pagesVisited.length > 0 && !hasCatalogs && apis.length === 0 && step <= 5) {
        const fw = context.framework || '';
        if (/angular|react|next|vue/i.test(fw) && !session._waitedApis) {
            session._waitedApis = true;
            log(context.host, `⏳ SPA (${fw}) → attendo API`);
            return {
                reasoning: `Sito ${fw} — attendo che le API si carichino dopo navigazione`,
                action: { type: 'wait_apis', delay: 5000 },
                _source: 'rule'
            };
        }
    }

    // ─── Link "tutti"/"all"/"vedi tutti" ───
    if (bestCount >= 15 && bestCount < 100) {
        const allLink = links.find(l =>
            /tutt|all|complet|vedi.?tutt|mostra.?tutt|show.?all|load.?more|more.?game/i.test(l.t) &&
            !session.pagesVisited.includes(l.h)
        );
        if (allLink) {
            session.pagesVisited.push(allLink.h);
            log(context.host, `🔗 Link "tutti": "${allLink.t}"`);
            return {
                reasoning: `${bestCount} giochi ma c'è link "${allLink.t}" per catalogo completo`,
                action: { type: 'navigate', value: allLink.h },
                _source: 'rule'
            };
        }
    }

    // ─── Ultimi step → forza download se c'è qualcosa ───
    if (step >= maxSteps - 3) {
        if (bestCount > 0 && !session.downloaded) {
            session.downloaded = true;
            log(context.host, `⏱ Ultimi step → download forzato (${bestCount} giochi)`);
            return {
                reasoning: `Quasi al limite step → download con ${bestCount} giochi`,
                action: { type: 'download', filename: context.host + '_catalog.json' },
                _source: 'rule'
            };
        }
        if (!session.domScraped) {
            session.domScraped = true;
            session.domScrapedCount++;
            return {
                reasoning: 'Ultimi step → scrape DOM finale',
                action: { type: 'scrape_dom' },
                _source: 'rule'
            };
        }
        if (session.downloaded || bestCount === 0) {
            return {
                reasoning: 'Limite step raggiunto',
                action: { type: 'done' },
                _source: 'rule'
            };
        }
    }

    // ─── Nessuna regola → Claude ───
    return null;
}

// ═══════════════════════════════════════════════════════════════════════
//  ANTI-LOOP
// ═══════════════════════════════════════════════════════════════════════
function checkAndRecordAction(host, action, source) {
    const session = getSession(host);
    const key = action.type + '|' + (action.value || '').substring(0, 50);

    // Permetti scroll e scrape_dom fino a 3 volte
    const repeatableActions = ['scroll', 'scrape_dom'];
    if (repeatableActions.includes(action.type)) {
        const count = session.actions.filter(a => a.type === action.type).length;
        if (count >= 3) {
            log(host, `⚠️ ${action.type} già fatto ${count} volte → skip`);
            return getAntiLoopFallback(session);
        }
    } else if (session.actionKeys.has(key)) {
        log(host, `⚠️ LOOP: ${key}`);
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
    return null;
}

function getAntiLoopFallback(session) {
    if (session.bestCount > 0 && !session.downloaded) {
        session.downloaded = true;
        return { reasoning: 'Loop → download forzato', action: { type: 'download' }, _source: 'antiloop' };
    }
    if (session.bestCount > 0 && session.downloaded) {
        return { reasoning: 'Loop dopo download → termino', action: { type: 'done' }, _source: 'antiloop' };
    }
    if (!session.domScraped) {
        session.domScraped = true;
        session.domScrapedCount++;
        return { reasoning: 'Loop → scrape DOM', action: { type: 'scrape_dom' }, _source: 'antiloop' };
    }
    return { reasoning: 'Loop irrisolvibile → stop', action: { type: 'done' }, _source: 'antiloop' };
}

// ═══════════════════════════════════════════════════════════════════════
//  HANDLE NEED_HELP — routing intelligente
// ═══════════════════════════════════════════════════════════════════════
function handleNeedHelp(agentWs, msg) {
    const ctx = msg.context;
    const session = getSession(ctx.host);

    // 1. Prova decisione locale
    let decision = tryDecideLocally(ctx);

    if (decision) {
        // Anti-loop check
        const loopAction = checkAndRecordAction(ctx.host, decision.action, decision._source || 'rule');
        if (loopAction) decision = loopAction;

        session.localDecisions++;
        log(ctx.host, `🧠 Auto #${session.localDecisions}: ${decision.action.type} → ${(decision.action.value || '').substring(0, 60)}`);

        agentWs.send(JSON.stringify({
            type: 'action',
            reasoning: `[AUTO] ${decision.reasoning}`,
            action: decision.action
        }));
        return;
    }

    // 2. Nessuna regola → Claude via bridge
    session.claudeAsks++;
    log(ctx.host, `🌉 Claude ask #${session.claudeAsks}`);

    const enrichedMsg = {
        ...msg,
        context: {
            ...ctx,
            sessionHistory: session.actions.slice(-10).map(a =>
                `[${a.source}] ${a.type}→${(a.value || '').substring(0, 40)}`
            ),
            sessionStats: {
                localDecisions: session.localDecisions,
                claudeAsks: session.claudeAsks,
                bestCount: session.bestCount,
                bestScore: session.bestScore,
                domScraped: session.domScraped,
                domScrapedCount: session.domScrapedCount,
                scrolled: session.scrolled,
                scrollCount: session.scrollCount,
                pagesVisited: session.pagesVisited,
                downloaded: session.downloaded,
                downloadHistory: session.downloadHistory,
            }
        }
    };

    if (bridge && bridge.readyState === 1) {
        activeAgent = agentWs;
        bridge.send(JSON.stringify(enrichedMsg));
    } else {
        log(ctx.host, `⚠️ Bridge offline → fallback`);
        const fallback = getFallbackAction(session, ctx);
        const loopCheck = checkAndRecordAction(ctx.host, fallback.action, 'fallback');
        const finalAction = loopCheck || fallback;
        agentWs.send(JSON.stringify({
            type: 'action',
            reasoning: `[FALLBACK] ${finalAction.reasoning}`,
            action: finalAction.action
        }));
    }
}

function getFallbackAction(session, ctx) {
    const links = ctx.links || [];

    const unvisited = links.find(l =>
        /slot|casino|game|gioc/i.test(l.h + ' ' + l.t) &&
        !session.pagesVisited.includes(l.h) &&
        !/(sport|live|promo|bonus|help|faq|login|registr)/i.test(l.h)
    );
    if (unvisited) {
        session.pagesVisited.push(unvisited.h);
        return { reasoning: `Bridge offline → provo "${unvisited.t}"`, action: { type: 'navigate', value: unvisited.h } };
    }
    if (!session.domScraped) {
        session.domScraped = true;
        session.domScrapedCount++;
        return { reasoning: 'Bridge offline → scrape DOM', action: { type: 'scrape_dom' } };
    }
    if (session.bestCount > 0 && !session.downloaded) {
        session.downloaded = true;
        return { reasoning: `Bridge offline → download ${session.bestCount}`, action: { type: 'download' } };
    }
    return { reasoning: 'Bridge offline, nulla da fare', action: { type: 'done' } };
}

// ═══════════════════════════════════════════════════════════════════════
//  HTTP ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════
app.use(express.json());

app.get('/', (req, res) => {
    const sessionStats = {};
    sessions.forEach((s, host) => {
        sessionStats[host] = {
            step: s.step,
            bestCount: s.bestCount,
            bestScore: s.bestScore,
            local: s.localDecisions,
            claude: s.claudeAsks,
            actions: s.actions.length,
            downloaded: s.downloaded,
            approved: s.approved,
        };
    });
    res.json({
        status: 'ok',
        service: 'scraper-bookmaker-relay v2',
        agents: agents.size,
        bridge: bridge ? 'connected' : 'disconnected',
        uptime: Math.round(process.uptime()) + 's',
        knownPatterns: Object.keys(KNOWN_API_PATTERNS).length,
        sessions: sessionStats,
    });
});

app.get('/sessions', (req, res) => {
    const out = {};
    sessions.forEach((s, host) => {
        out[host] = {
            step: s.step,
            bestCount: s.bestCount,
            bestScore: s.bestScore,
            actions: s.actions,
            localDecisions: s.localDecisions,
            claudeAsks: s.claudeAsks,
            lastDataReport: s.lastDataReport,
            downloadHistory: s.downloadHistory,
        };
    });
    res.json(out);
});

app.delete('/sessions', (req, res) => {
    sessions.clear();
    res.json({ ok: true });
});

app.delete('/sessions/:host', (req, res) => {
    sessions.delete(req.params.host);
    res.json({ ok: true });
});

// Aggiungi pattern al volo
app.post('/patterns', (req, res) => {
    const { host, steps } = req.body;
    if (!host || !steps) return res.status(400).json({ error: 'host + steps required' });
    KNOWN_API_PATTERNS[host] = steps;
    console.log(`[+] Pattern aggiunto: ${host} (${steps.length} steps)`);
    res.json({ ok: true, patterns: Object.keys(KNOWN_API_PATTERNS).length });
});

app.get('/patterns', (req, res) => {
    res.json(KNOWN_API_PATTERNS);
});

// ═══════════════════════════════════════════════════════════════════════
//  WEBSOCKET
// ═══════════════════════════════════════════════════════════════════════
wss.on('connection', (ws, req) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    console.log(`[+] Connessione da ${ip}`);

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw);

            if (msg.type === 'register') {
                if (msg.role === 'agent') {
                    agents.add(ws);
                    ws._role = 'agent';
                    console.log(`[agent] Registrato (${agents.size})`);
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

            // Agent chiede aiuto → smart routing
            if (ws._role === 'agent' && msg.type === 'need_help') {
                console.log(`[agent] need_help ${msg.context?.host || '?'} step ${msg.context?.step || '?'}`);
                handleNeedHelp(ws, msg);
                return;
            }

            // Bridge risponde → forward con anti-loop
            if (ws._role === 'bridge' && msg.type === 'action') {
                const actionType = msg.action?.type || '?';
                console.log(`[bridge→agent] ${actionType}`);

                if (activeAgent && activeAgent.readyState === 1) {
                    // Trova l'host attivo per anti-loop
                    let activeHost = null;
                    sessions.forEach((s, h) => {
                        if (s.claudeAsks > 0 && (!activeHost || s.startedAt > sessions.get(activeHost)?.startedAt))
                            activeHost = h;
                    });

                    if (activeHost && msg.action) {
                        const loopAction = checkAndRecordAction(activeHost, msg.action, 'claude');
                        if (loopAction) {
                            log(activeHost, `⚠️ Claude loop → override`);
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
                    ws.send(JSON.stringify({ type: 'error', message: 'Agent non connesso' }));
                }
                return;
            }

            if (msg.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
                return;
            }

        } catch (e) {
            console.error('[error]', e.message);
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

// Heartbeat
setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

// Pulizia sessioni vecchie (>2h)
setInterval(() => {
    const cutoff = Date.now() - 7200000;
    sessions.forEach((s, host) => {
        if (s.startedAt < cutoff) {
            console.log(`[cleanup] ${host} rimossa`);
            sessions.delete(host);
        }
    });
}, 300000);

// Start
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Scraper Bookmaker Smart Relay v2 on :${PORT}`);
    console.log(`Known API patterns: ${Object.keys(KNOWN_API_PATTERNS).join(', ')}`);
});
