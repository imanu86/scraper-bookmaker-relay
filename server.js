// ═══════════════════════════════════════════════════════════════════════
//  Scraper Bookmaker Relay v9 — Railway WebSocket server
//  Ponte tra Agent TM (bookmaker) ↔ Bridge TM (claude.ai) ↔ Controller (Managed Agent)
//
//  Novità v9: HTTP endpoints per remote fetch via TM browser
//    POST /fetch       {url, headers?}   → TM fetcha con IP italiano → ritorna HTML
//    POST /fetch-multi {urls: [...]}     → fetch paralleli
//    GET  /queue                         → mostra coda pendente
//
//  Deploy: Railway, set PORT env var
//  npm init -y && npm install ws express
// ═══════════════════════════════════════════════════════════════════════

const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '10mb' }));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 5 * 1024 * 1024 }); // 5MB

// ─── State ───
let agents = new Set();
let activeAgent = null;
let bridge = null;

// ─── Fetch Queue ───
const fetchQueue = new Map();   // id → { url, resolve, timer, result }
const FETCH_TIMEOUT = 30000;    // 30s

// ─── Catalog Storage (in-memory) ───
const catalogs = new Map();     // site → { data, ts, count }

// ─── Health endpoint ───
app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        service: 'scraper-bookmaker-relay v10',
        agent: agents.size + ' connected',
        bridge: bridge ? 'connected' : 'disconnected',
        fetchQueue: fetchQueue.size + ' pending',
        catalogs: catalogs.size + ' saved',
        uptime: Math.round(process.uptime()) + 's'
    });
});

// ─── GET /queue ───
app.get('/queue', (req, res) => {
    const items = [];
    fetchQueue.forEach((v, id) => items.push({ id, url: v.url, hasResult: !!v.result, ts: v.ts }));
    res.json({ queue: items, agents: agents.size });
});

// ─── POST /catalog/:site — agent salva un catalogo ───
app.post('/catalog/:site', (req, res) => {
    const site = req.params.site;
    const data = req.body;
    if (!data || (!Array.isArray(data) && !data.games)) {
        return res.status(400).json({ error: 'JSON array or {games:[...]} required' });
    }
    const games = Array.isArray(data) ? data : data.games;
    catalogs.set(site, { data: games, ts: Date.now(), count: games.length });
    console.log(`[catalog] ${site}: ${games.length} giochi salvati`);
    res.json({ ok: true, site, count: games.length });
});

// ─── GET /catalog/:site — scarica catalogo come JSON ───
app.get('/catalog/:site', (req, res) => {
    const entry = catalogs.get(req.params.site);
    if (!entry) return res.status(404).json({ error: 'Catalog not found' });
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.site}_catalog.json"`);
    res.json(entry.data);
});

// ─── GET /catalogs — lista tutti i cataloghi salvati ───
app.get('/catalogs', (req, res) => {
    const list = [];
    catalogs.forEach((v, site) => list.push({ site, count: v.count, ts: new Date(v.ts).toISOString() }));
    res.json({ catalogs: list, total: list.reduce((s, c) => s + c.count, 0) });
});

// ─── POST /fetch — singolo URL via TM browser ───
app.post('/fetch', (req, res) => {
    const { url, headers } = req.body;
    if (!url) return res.status(400).json({ error: 'url required' });

    let targetAgent = null;
    for (const a of agents) { if (a.readyState === 1) { targetAgent = a; break; } }
    if (!targetAgent) return res.status(503).json({ error: 'No TM agent connected' });

    const id = crypto.randomUUID();
    console.log(`[fetch] ${id} → ${url}`);

    targetAgent.send(JSON.stringify({ type: 'fetch_request', id, url, headers: headers || {} }));

    const timer = setTimeout(() => {
        if (fetchQueue.has(id)) {
            fetchQueue.delete(id);
            res.status(504).json({ error: 'Timeout', id, url });
        }
    }, FETCH_TIMEOUT);

    fetchQueue.set(id, {
        url, ts: Date.now(), timer,
        resolve: (result) => { clearTimeout(timer); fetchQueue.delete(id); res.json(result); }
    });
});

// ─── POST /fetch-multi — fetch multipli in parallelo ───
app.post('/fetch-multi', (req, res) => {
    const { urls } = req.body;
    if (!urls || !Array.isArray(urls)) return res.status(400).json({ error: 'urls array required' });

    let targetAgent = null;
    for (const a of agents) { if (a.readyState === 1) { targetAgent = a; break; } }
    if (!targetAgent) return res.status(503).json({ error: 'No TM agent connected' });

    const results = {};
    let remaining = urls.length;

    const timer = setTimeout(() => {
        fetchQueue.forEach((v, id) => { if (urls.includes(v.url)) fetchQueue.delete(id); });
        res.json({ results, complete: false, timedOut: remaining });
    }, FETCH_TIMEOUT);

    urls.forEach(url => {
        const id = crypto.randomUUID();
        console.log(`[fetch-multi] ${id} → ${url}`);
        targetAgent.send(JSON.stringify({ type: 'fetch_request', id, url, headers: {} }));
        fetchQueue.set(id, {
            url, ts: Date.now(),
            resolve: (result) => {
                results[url] = result;
                remaining--;
                fetchQueue.delete(id);
                if (remaining <= 0) { clearTimeout(timer); res.json({ results, complete: true }); }
            }
        });
    });
});

// ─── WebSocket ───
wss.on('connection', (ws, req) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    console.log(`[+] Connessione da ${ip}`);

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw);

            // Registrazione
            if (msg.type === 'register') {
                if (msg.role === 'agent') {
                    agents.add(ws);
                    ws._role = 'agent';
                    console.log(`[agent] Registrato (${agents.size})`);
                    ws.send(JSON.stringify({ type: 'registered', role: 'agent', bridge: bridge ? 'online' : 'offline' }));
                } else if (msg.role === 'bridge') {
                    bridge = ws;
                    ws._role = 'bridge';
                    console.log('[bridge] Registrato');
                    ws.send(JSON.stringify({ type: 'registered', role: 'bridge' }));
                }
                return;
            }

            // ─── Risposta fetch dal TM → resolve HTTP pending ───
            if (ws._role === 'agent' && msg.type === 'fetch_response') {
                const entry = fetchQueue.get(msg.id);
                if (entry) {
                    console.log(`[fetch] ${msg.id} ← ${msg.status} (${(msg.html || '').length}B)`);
                    entry.resolve({
                        id: msg.id, url: msg.url, status: msg.status,
                        html: msg.html, size: (msg.html || '').length,
                        finalUrl: msg.finalUrl || msg.url
                    });
                }
                return;
            }

            // Forward: agent → bridge
            if (ws._role === 'agent' && msg.type === 'need_help') {
                activeAgent = ws;
                if (bridge && bridge.readyState === 1) bridge.send(JSON.stringify(msg));
                else ws.send(JSON.stringify({ type: 'error', message: 'Bridge non connesso' }));
                return;
            }

            // Forward: bridge → agent
            if (ws._role === 'bridge' && msg.type === 'action') {
                if (activeAgent && activeAgent.readyState === 1) activeAgent.send(JSON.stringify(msg));
                return;
            }

            if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong', ts: Date.now() })); return; }

        } catch (e) { console.error('[error]', e.message); }
    });

    ws.on('close', () => {
        if (ws._role === 'agent') { agents.delete(ws); if (ws === activeAgent) activeAgent = null; }
        if (ws === bridge) bridge = null;
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

// ─── Start ───
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Scraper Bookmaker Relay v10 on :${PORT}`));
