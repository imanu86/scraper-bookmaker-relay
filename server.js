// ═══════════════════════════════════════════════════════════════════════
//  Scraper Bookmaker Relay v2 — Smart Relay
//  Rules engine + data validation + conversational bridge
//
//  Flusso conversazionale:
//  1. Agent manda need_help con isFirst=true → server decide o passa a Claude
//  2. Claude risponde → agent esegue → manda risultato con isFirst=false
//  3. Bridge manda a Claude solo il risultato (breve) → Claude risponde
//  4. Loop finché approve/done
//
//  Deploy: Railway, set PORT env var
// ═══════════════════════════════════════════════════════════════════════

const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 2 * 1024 * 1024 });

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
            host, startedAt: Date.now(), step: 0,
            actions: [], actionKeys: new Set(),
            catalogs: [], bestCount: 0, bestScore: 0,
            pagesVisited: [], apisCalled: [],
            domScraped: false, domScrapedCount: 0,
            scrolled: false, scrollCount: 0,
            downloaded: false, approved: false,
            claudeAsks: 0, localDecisions: 0,
            lastDataReport: null,
        });
    }
    return sessions.get(host);
}

function log(host, msg) { console.log(`[${host}] ${msg}`); }

// ═══════════════════════════════════════════════════════════════════════
//  KNOWN API PATTERNS — solo verificati
// ═══════════════════════════════════════════════════════════════════════
const KNOWN_API_PATTERNS = {
    'sisal.it': [
        { action: { type: 'navigate', value: '/casinogames/slot' }, reasoning: 'Sisal: pagina slot' },
        { action: { type: 'fetch_api', value: 'https://recommender.sisal.it/recommender/v2/casino/games?pageSize=1000&category=slot', method: 'GET' }, reasoning: 'Sisal: API recommender' },
    ],
    'snai.it': [
        { action: { type: 'navigate', value: '/casino/slot' }, reasoning: 'SNAI: pagina slot' },
        { action: { type: 'fetch_paginated', value: 'https://apipreview.snai.it/v2/casino/games', pageParam: 'pageNumber', pageSize: 48, maxPages: 60 }, reasoning: 'SNAI: API paginata' },
    ],
    'lottomatica.it': [
        { action: { type: 'navigate', value: '/casino/slot' }, reasoning: 'Lottomatica: pagina slot' },
        { action: { type: 'fetch_api', value: 'https://www.lottomatica.it/api/casino/GetGamesListLight', method: 'POST', body: '{"category":"slot","pageSize":1000}' }, reasoning: 'Lottomatica: API POST' },
    ],
};

// ═══════════════════════════════════════════════════════════════════════
//  RULES ENGINE
// ═══════════════════════════════════════════════════════════════════════
function tryDecideLocally(context) {
    const session = getSession(context.host);
    session.step = context.step;

    if (context.catalogs?.length > 0) {
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

    // Pattern noto
    const hostKey = Object.keys(KNOWN_API_PATTERNS).find(k => context.host.includes(k));
    if (hostKey && !session._patternDone) {
        const steps = KNOWN_API_PATTERNS[hostKey];
        const done = session.actions.filter(a => a.source === 'pattern').length;
        if (done < steps.length) {
            const next = steps[done];
            const key = next.action.type + '|' + (next.action.value || '').substring(0, 50);
            if (!session.actionKeys.has(key)) {
                log(context.host, `📋 Pattern "${hostKey}" ${done + 1}/${steps.length}`);
                return { ...next, _source: 'pattern' };
            }
        }
        session._patternDone = true;
    }

    // Dati buoni → download + approve
    if (dataReport && dataReport.score >= 60 && dataReport.count >= 50) {
        if (!session.downloaded) {
            session.downloaded = true;
            return { reasoning: `Dati buoni (Q:${dataReport.score}, ${dataReport.count} giochi) → download`, action: { type: 'download', filename: context.host + '_catalog.json' }, _source: 'rule' };
        }
        if (!session.approved) {
            session.approved = true;
            return { reasoning: 'Download fatto, dati buoni → approve', action: { type: 'approve' }, _source: 'rule' };
        }
    }

    // Dati scarsi dopo download → Claude deve decidere
    if (downloadHistory.length > 0 && dataReport && dataReport.score < 40) {
        return null; // forza Claude
    }

    // Catalogo grande senza quality check → download per analisi
    if (bestCount >= 100 && !session.downloaded && !dataReport) {
        session.downloaded = true;
        return { reasoning: `${bestCount} giochi → download per verifica qualità`, action: { type: 'download', filename: context.host + '_catalog.json' }, _source: 'rule' };
    }

    // Tante immagini DOM senza catalogo → scrape
    if (domImgs >= 20 && !hasCatalogs && session.domScrapedCount < 2) {
        session.domScraped = true; session.domScrapedCount++;
        return { reasoning: `${domImgs} immagini DOM → scrape`, action: { type: 'scrape_dom' }, _source: 'rule' };
    }

    // Dopo scrape parziale → scroll
    if (session.domScraped && bestCount >= 5 && bestCount < 100 && session.scrollCount < 2) {
        session.scrollCount++; session.scrolled = true;
        return { reasoning: `${bestCount} giochi, provo scroll`, action: { type: 'scroll', value: 'bottom' }, _source: 'rule' };
    }

    // Dopo scroll → re-scrape
    if (session.scrolled && session.domScrapedCount < session.scrollCount + 1) {
        session.domScrapedCount++;
        return { reasoning: 'Re-scrape dopo scroll', action: { type: 'scrape_dom' }, _source: 'rule' };
    }

    // API grossa
    if (apis.length > 0 && (!hasCatalogs || bestScore < 40)) {
        const bigApi = apis.find(a => a.s > 50000 && !session.apisCalled.includes(a.u) && !/google|analytics|gtm|facebook|optimove|iesnare|boomerang|onetrust/.test(a.u));
        if (bigApi) {
            session.apisCalled.push(bigApi.u);
            return { reasoning: `API ${Math.round(bigApi.s/1024)}KB → fetch`, action: { type: 'fetch_api', value: bigApi.u, method: bigApi.m || 'GET' }, _source: 'rule' };
        }
    }

    // Primo step → cerca link slot
    if (step <= 3 && !hasCatalogs && session.pagesVisited.length === 0) {
        const target = links.find(l => /slot/i.test(l.h+' '+l.t) && !/(sport|live|promo|bonus|help|faq|login|registr)/i.test(l.h)) ||
                       links.find(l => /casino/i.test(l.h+' '+l.t) && !/(sport|live|promo|bonus|help|faq|login|registr)/i.test(l.h) && !/live.?casino/i.test(l.h+' '+l.t));
        if (target) {
            session.pagesVisited.push(target.h);
            return { reasoning: `Navigo a "${target.t}"`, action: { type: 'navigate', value: target.h }, _source: 'rule' };
        }
    }

    // SPA → attendi API
    if (session.pagesVisited.length > 0 && !hasCatalogs && apis.length === 0 && step <= 5 && /angular|react|next|vue/i.test(context.framework||'') && !session._waitedApis) {
        session._waitedApis = true;
        return { reasoning: `SPA ${context.framework} → attendo API`, action: { type: 'wait_apis', delay: 5000 }, _source: 'rule' };
    }

    // Link "tutti"
    if (bestCount >= 15 && bestCount < 100) {
        const allLink = links.find(l => /tutt|all|complet|vedi.?tutt|mostra|show.?all|load.?more|more.?game/i.test(l.t) && !session.pagesVisited.includes(l.h));
        if (allLink) {
            session.pagesVisited.push(allLink.h);
            return { reasoning: `Link "${allLink.t}" per più giochi`, action: { type: 'navigate', value: allLink.h }, _source: 'rule' };
        }
    }

    // Ultimi step
    if (step >= maxSteps - 3) {
        if (bestCount > 0 && !session.downloaded) {
            session.downloaded = true;
            return { reasoning: `Ultimi step → download (${bestCount})`, action: { type: 'download', filename: context.host + '_catalog.json' }, _source: 'rule' };
        }
        if (!session.domScraped) { session.domScraped = true; session.domScrapedCount++; return { reasoning: 'Ultimo tentativo scrape', action: { type: 'scrape_dom' }, _source: 'rule' }; }
        return { reasoning: 'Limite step', action: { type: 'done' }, _source: 'rule' };
    }

    return null; // → Claude
}

// ═══════════════════════════════════════════════════════════════════════
//  ANTI-LOOP
// ═══════════════════════════════════════════════════════════════════════
function checkAndRecordAction(host, action, source) {
    const session = getSession(host);
    const key = action.type + '|' + (action.value || '').substring(0, 50);

    if (['scroll', 'scrape_dom'].includes(action.type)) {
        if (session.actions.filter(a => a.type === action.type).length >= 3)
            return getAntiLoopFallback(session);
    } else if (session.actionKeys.has(key)) {
        return getAntiLoopFallback(session);
    }

    session.actionKeys.add(key);
    session.actions.push({ step: session.step, type: action.type, value: action.value, source, ts: Date.now() });
    return null;
}

function getAntiLoopFallback(session) {
    if (session.bestCount > 0 && !session.downloaded) { session.downloaded = true; return { reasoning: 'Loop → download', action: { type: 'download' }, _source: 'antiloop' }; }
    if (session.bestCount > 0) return { reasoning: 'Loop → done', action: { type: 'done' }, _source: 'antiloop' };
    if (!session.domScraped) { session.domScraped = true; session.domScrapedCount++; return { reasoning: 'Loop → scrape', action: { type: 'scrape_dom' }, _source: 'antiloop' }; }
    return { reasoning: 'Loop → stop', action: { type: 'done' }, _source: 'antiloop' };
}

// ═══════════════════════════════════════════════════════════════════════
//  HANDLE NEED_HELP
// ═══════════════════════════════════════════════════════════════════════
function handleNeedHelp(agentWs, msg) {
    const ctx = msg.context;
    const session = getSession(ctx.host);

    // Prova decisione locale
    let decision = tryDecideLocally(ctx);

    if (decision) {
        const loopAction = checkAndRecordAction(ctx.host, decision.action, decision._source || 'rule');
        if (loopAction) decision = loopAction;

        session.localDecisions++;
        log(ctx.host, `🧠 Auto #${session.localDecisions}: ${decision.action.type}`);

        agentWs.send(JSON.stringify({ type: 'action', reasoning: `[AUTO] ${decision.reasoning}`, action: decision.action }));
        return;
    }

    // → Claude via bridge (passa isFirst e result)
    session.claudeAsks++;
    log(ctx.host, `🌉 Claude ask #${session.claudeAsks} (${msg.isFirst ? 'PRIMO' : 'follow-up'})`);

    const enrichedMsg = {
        ...msg,
        context: {
            ...ctx,
            sessionHistory: session.actions.slice(-10).map(a => `[${a.source}] ${a.type}→${(a.value||'').substring(0,40)}`),
            sessionStats: { local: session.localDecisions, claude: session.claudeAsks, bestCount: session.bestCount, bestScore: session.bestScore, pagesVisited: session.pagesVisited }
        }
    };

    if (bridge && bridge.readyState === 1) {
        activeAgent = agentWs;
        bridge.send(JSON.stringify(enrichedMsg));
    } else {
        log(ctx.host, '⚠️ Bridge offline → fallback');
        const fallback = getFallbackAction(session, ctx);
        const loopCheck = checkAndRecordAction(ctx.host, fallback.action, 'fallback');
        agentWs.send(JSON.stringify({ type: 'action', reasoning: `[FALLBACK] ${(loopCheck || fallback).reasoning}`, action: (loopCheck || fallback).action }));
    }
}

function getFallbackAction(session, ctx) {
    const links = ctx.links || [];
    const unvisited = links.find(l => /slot|casino|game/i.test(l.h+' '+l.t) && !session.pagesVisited.includes(l.h) && !/(sport|live|promo|bonus|help|faq|login)/i.test(l.h));
    if (unvisited) { session.pagesVisited.push(unvisited.h); return { reasoning: `Fallback → "${unvisited.t}"`, action: { type: 'navigate', value: unvisited.h } }; }
    if (!session.domScraped) { session.domScraped = true; session.domScrapedCount++; return { reasoning: 'Fallback → scrape', action: { type: 'scrape_dom' } }; }
    if (session.bestCount > 0 && !session.downloaded) { session.downloaded = true; return { reasoning: 'Fallback → download', action: { type: 'download' } }; }
    return { reasoning: 'Fallback → stop', action: { type: 'done' } };
}

// ═══════════════════════════════════════════════════════════════════════
//  HTTP ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════
app.use(express.json());

app.get('/', (req, res) => {
    const ss = {};
    sessions.forEach((s, h) => { ss[h] = { step: s.step, best: s.bestCount, Q: s.bestScore, local: s.localDecisions, claude: s.claudeAsks, done: s.approved }; });
    res.json({ status: 'ok', service: 'relay-v2', agents: agents.size, bridge: bridge ? 'on' : 'off', uptime: Math.round(process.uptime()) + 's', sessions: ss });
});

app.get('/sessions', (req, res) => {
    const out = {};
    sessions.forEach((s, h) => { out[h] = { ...s, actionKeys: [...s.actionKeys] }; });
    res.json(out);
});

app.delete('/sessions', (req, res) => { sessions.clear(); res.json({ ok: true }); });
app.delete('/sessions/:host', (req, res) => { sessions.delete(req.params.host); res.json({ ok: true }); });

app.get('/patterns', (req, res) => res.json(KNOWN_API_PATTERNS));
app.post('/patterns', (req, res) => {
    const { host, steps } = req.body;
    if (!host || !steps) return res.status(400).json({ error: 'host + steps' });
    KNOWN_API_PATTERNS[host] = steps;
    res.json({ ok: true, count: Object.keys(KNOWN_API_PATTERNS).length });
});

// ═══════════════════════════════════════════════════════════════════════
//  WEBSOCKET
// ═══════════════════════════════════════════════════════════════════════
wss.on('connection', (ws, req) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    console.log(`[+] ${ip}`);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw);

            if (msg.type === 'register') {
                if (msg.role === 'agent') {
                    agents.add(ws); ws._role = 'agent';
                    console.log(`[agent] (${agents.size})`);
                    ws.send(JSON.stringify({ type: 'registered', role: 'agent', bridge: bridge ? 'online' : 'offline', mode: 'v2-conversational' }));
                    if (bridge?.readyState === 1) bridge.send(JSON.stringify({ type: 'agent_status', status: 'connected' }));
                } else if (msg.role === 'bridge') {
                    bridge = ws; ws._role = 'bridge';
                    console.log('[bridge]');
                    ws.send(JSON.stringify({ type: 'registered', role: 'bridge', agent: agents.size > 0 ? 'online' : 'offline', mode: 'v2-conversational' }));
                    agents.forEach(a => { if (a.readyState === 1) a.send(JSON.stringify({ type: 'bridge_status', status: 'connected' })); });
                }
                return;
            }

            if (ws._role === 'agent' && msg.type === 'need_help') {
                console.log(`[agent] ${msg.context?.host || '?'} step ${msg.context?.step} ${msg.isFirst ? 'FIRST' : 'follow-up'}`);
                handleNeedHelp(ws, msg);
                return;
            }

            if (ws._role === 'bridge' && msg.type === 'action') {
                console.log(`[bridge→agent] ${msg.action?.type}`);
                if (activeAgent?.readyState === 1) {
                    // Anti-loop sulle risposte Claude
                    let activeHost = null;
                    sessions.forEach((s, h) => { if (s.claudeAsks > 0 && (!activeHost || s.startedAt > (sessions.get(activeHost)?.startedAt || 0))) activeHost = h; });
                    if (activeHost && msg.action) {
                        const loop = checkAndRecordAction(activeHost, msg.action, 'claude');
                        if (loop) { log(activeHost, '⚠️ Claude loop'); activeAgent.send(JSON.stringify({ type: 'action', reasoning: `[ANTI-LOOP] ${loop.reasoning}`, action: loop.action })); return; }
                    }
                    activeAgent.send(JSON.stringify(msg));
                } else {
                    ws.send(JSON.stringify({ type: 'error', message: 'Agent non connesso' }));
                }
                return;
            }

            if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong', ts: Date.now() })); return; }
        } catch (e) { console.error('[err]', e.message); }
    });

    ws.on('close', () => {
        console.log(`[-] ${ws._role || '?'}`);
        if (ws._role === 'agent') { agents.delete(ws); if (ws === activeAgent) activeAgent = null; if (bridge?.readyState === 1) bridge.send(JSON.stringify({ type: 'agent_status', status: agents.size + '' })); }
        if (ws === bridge) { bridge = null; agents.forEach(a => { if (a.readyState === 1) a.send(JSON.stringify({ type: 'bridge_status', status: 'disconnected' })); }); }
    });
});

setInterval(() => { wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); }); }, 30000);
setInterval(() => { const cut = Date.now() - 7200000; sessions.forEach((s, h) => { if (s.startedAt < cut) { sessions.delete(h); } }); }, 300000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Relay v2 on :${PORT} — patterns: ${Object.keys(KNOWN_API_PATTERNS).join(', ')}`); });
