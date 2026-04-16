// ═══════════════════════════════════════════════════════════════════════
//  Scraper Bookmaker Relay v12 — Railway WebSocket server
//
//  Canali coesistenti, indipendenti:
//   1) SCRAPER  — agent (TM bookmaker) ↔ bridge (TM claude.ai)        [v11, intatto]
//   2) FETCH    — HTTP /fetch /fetch-multi via TM browser              [v11, intatto]
//   3) CATALOG  — HTTP /catalog/:site                                  [v11, intatto]
//   4) TRADE    — adp_producer (TM ADP) ↔ tv_consumer (TM TradingView) [v11, intatto]
//   5) CGC-BATCH — agent APK (CGC Assistant) ↔ cgc (CGC Windows)      [NUOVO v12]
//
//  Il routing CGC-BATCH è per `key` (team key condivisa). Un APK con
//  role=agent + key+serial chiede il batch login; i CGC Windows della
//  stessa team ricevono il batch_request e rispondono con
//  batch_started / batch_completed (filtrati per target=serial così
//  solo l'APK che ha richiesto riceve il feedback).
//
//  Differenziazione ruolo `agent`:
//   - Senza `key` → TM bookmaker legacy (entra in `agents` flat, /fetch, need_help)
//   - Con `key`+`serial` → CGC Assistant APK (entra in `apkByKey`, batch channel)
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

// ─── State: SCRAPER (legacy v11) ───
let agents = new Set();
let activeAgent = null;
let bridge = null;

// ─── Fetch Queue (v11) ───
const fetchQueue = new Map();   // id → { url, resolve, timer, result }
const FETCH_TIMEOUT = 30000;    // 30s

// ─── Catalog Storage in-memory (v11) ───
const catalogs = new Map();     // site → { data, ts, count }

// ─── State: TRADE (v11) ───
// userKey → { producer: ws|null, consumers: Set<ws> }
const tradeChannels = new Map();
function getOrCreateChannel(key) {
    let ch = tradeChannels.get(key);
    if (!ch) { ch = { producer: null, consumers: new Set() }; tradeChannels.set(key, ch); }
    return ch;
}
function pruneChannel(key) {
    const ch = tradeChannels.get(key);
    if (ch && !ch.producer && ch.consumers.size === 0) tradeChannels.delete(key);
}

// ─── State: CGC-BATCH (v12) ───
// teamKey → Set<ws>  per ciascun lato (APK e CGC Windows)
const apkByKey = new Map();
const cgcByKey = new Map();
const shortKey = (k) => (k && k.length >= 8) ? k.slice(0, 8) : (k || '?');

// ─── Health endpoint ───
app.get('/', (req, res) => {
    const tradeDetail = [];
    tradeChannels.forEach((ch, key) => tradeDetail.push({
        userKey: key,
        producer: ch.producer ? 'online' : 'offline',
        consumers: ch.consumers.size
    }));
    const cgcBatchDetail = [];
    const allKeys = new Set([...apkByKey.keys(), ...cgcByKey.keys()]);
    allKeys.forEach(k => cgcBatchDetail.push({
        teamKey: shortKey(k),
        apk: (apkByKey.get(k) || new Set()).size,
        cgc: (cgcByKey.get(k) || new Set()).size
    }));
    res.json({
        status: 'ok',
        service: 'scraper-bookmaker-relay v12',
        agent: agents.size + ' connected',
        bridge: bridge ? 'connected' : 'disconnected',
        fetchQueue: fetchQueue.size + ' pending',
        catalogs: catalogs.size + ' saved',
        trade: { channels: tradeChannels.size, detail: tradeDetail },
        cgcBatch: { teams: allKeys.size, detail: cgcBatchDetail },
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

            // ═══════════════════════════════════════════════════════════
            //  REGISTRAZIONE
            // ═══════════════════════════════════════════════════════════
            if (msg.type === 'register') {

                // ── SCRAPER/CGC-BATCH: agent ──
                // v12: se `key` è presente → CGC Assistant APK (batch channel)
                //     altrimenti → TM bookmaker legacy (flat `agents` per /fetch)
                if (msg.role === 'agent') {
                    if (msg.key) {
                        ws._role = 'agent';
                        ws._teamKey = msg.key;
                        ws._serial = msg.serial || null;
                        if (!apkByKey.has(msg.key)) apkByKey.set(msg.key, new Set());
                        apkByKey.get(msg.key).add(ws);
                        console.log(`[apk] Registrato team=${shortKey(msg.key)} serial=${ws._serial}`);
                        ws.send(JSON.stringify({ type: 'registered', role: 'agent', team: shortKey(msg.key) }));
                        return;
                    }
                    agents.add(ws);
                    ws._role = 'agent';
                    console.log(`[agent] Registrato (${agents.size})`);
                    ws.send(JSON.stringify({ type: 'registered', role: 'agent', bridge: bridge ? 'online' : 'offline' }));
                    return;
                }

                // ── SCRAPER: bridge ──
                if (msg.role === 'bridge') {
                    bridge = ws;
                    ws._role = 'bridge';
                    console.log('[bridge] Registrato');
                    ws.send(JSON.stringify({ type: 'registered', role: 'bridge' }));
                    return;
                }

                // ── CGC-BATCH: cgc (CGC Windows) ──
                if (msg.role === 'cgc') {
                    if (!msg.key) {
                        ws.send(JSON.stringify({ type: 'error', message: 'team key required for cgc' }));
                        return;
                    }
                    ws._role = 'cgc';
                    ws._teamKey = msg.key;
                    if (!cgcByKey.has(msg.key)) cgcByKey.set(msg.key, new Set());
                    cgcByKey.get(msg.key).add(ws);
                    console.log(`[cgc] Registrato team=${shortKey(msg.key)}`);
                    ws.send(JSON.stringify({ type: 'registered', role: 'cgc', team: shortKey(msg.key) }));
                    return;
                }

                // ── TRADE: adp_producer ──
                if (msg.role === 'adp_producer') {
                    const key = (msg.userKey || '').trim() || 'default';
                    ws._role = 'adp_producer';
                    ws._userKey = key;
                    const ch = getOrCreateChannel(key);
                    if (ch.producer && ch.producer !== ws && ch.producer.readyState === 1) {
                        try { ch.producer.send(JSON.stringify({ type: 'evicted', reason: 'replaced by newer producer' })); } catch {}
                        try { ch.producer.close(); } catch {}
                    }
                    ch.producer = ws;
                    console.log(`[adp_producer] registrato (userKey=${key}, consumers=${ch.consumers.size})`);
                    ws.send(JSON.stringify({
                        type: 'registered', role: 'adp_producer', userKey: key,
                        consumers: ch.consumers.size
                    }));
                    ch.consumers.forEach(c => {
                        if (c.readyState === 1) c.send(JSON.stringify({ type: 'peer_status', peer: 'producer', status: 'online' }));
                    });
                    return;
                }

                // ── TRADE: tv_consumer ──
                if (msg.role === 'tv_consumer') {
                    const key = (msg.userKey || '').trim() || 'default';
                    ws._role = 'tv_consumer';
                    ws._userKey = key;
                    const ch = getOrCreateChannel(key);
                    ch.consumers.add(ws);
                    console.log(`[tv_consumer] registrato (userKey=${key}, totali=${ch.consumers.size})`);
                    ws.send(JSON.stringify({
                        type: 'registered', role: 'tv_consumer', userKey: key,
                        producer: ch.producer ? 'online' : 'offline'
                    }));
                    if (ch.producer && ch.producer.readyState === 1) {
                        ch.producer.send(JSON.stringify({ type: 'peer_status', peer: 'consumer', status: 'online', total: ch.consumers.size }));
                    }
                    return;
                }

                console.warn(`[register] ruolo sconosciuto: ${msg.role}`);
                return;
            }

            // ═══════════════════════════════════════════════════════════
            //  CGC-BATCH (v12)
            // ═══════════════════════════════════════════════════════════

            // APK → CGC Windows della stessa team
            if (ws._role === 'agent' && ws._teamKey && msg.type === 'batch_request') {
                const peers = cgcByKey.get(ws._teamKey);
                const fwd = JSON.stringify(msg);
                let n = 0;
                if (peers) peers.forEach(c => { if (c.readyState === 1) { c.send(fwd); n++; } });
                console.log(`[batch_request] team=${shortKey(ws._teamKey)} serial=${msg.serial} → ${n} cgc`);
                if (n === 0) ws.send(JSON.stringify({ type: 'error', message: 'Nessun CGC Windows connesso per la tua squadra' }));
                return;
            }

            // CGC Windows → APK della stessa team (filtrato per target=serial)
            if (ws._role === 'cgc' && (msg.type === 'batch_started' || msg.type === 'batch_completed')) {
                const peers = apkByKey.get(ws._teamKey);
                const fwd = JSON.stringify(msg);
                let n = 0;
                if (peers) peers.forEach(a => {
                    if (a.readyState !== 1) return;
                    if (msg.target && a._serial && a._serial !== msg.target) return;
                    a.send(fwd);
                    n++;
                });
                console.log(`[${msg.type}] team=${shortKey(ws._teamKey)} target=${msg.target} → ${n} apk`);
                return;
            }

            // ═══════════════════════════════════════════════════════════
            //  SCRAPER / FETCH (v11) — invariato, solo per agent SENZA key
            // ═══════════════════════════════════════════════════════════

            // Risposta fetch dal TM → resolve HTTP pending
            if (ws._role === 'agent' && !ws._teamKey && msg.type === 'fetch_response') {
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
            if (ws._role === 'agent' && !ws._teamKey && msg.type === 'need_help') {
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

            // ═══════════════════════════════════════════════════════════
            //  TRADE — producer → consumers
            // ═══════════════════════════════════════════════════════════
            if (ws._role === 'adp_producer') {
                const ch = tradeChannels.get(ws._userKey);
                if (ch && (msg.type === 'trade' || msg.type === 'schema_sample' || msg.type === 'producer_log')) {
                    let delivered = 0;
                    ch.consumers.forEach(c => {
                        if (c.readyState === 1) { c.send(JSON.stringify(msg)); delivered++; }
                    });
                    if (msg.type === 'trade') {
                        console.log(`[trade] ${msg.event || '?'} ticket=${msg.trade?.ticket || '?'} → ${delivered} consumer(s)`);
                    }
                    return;
                }
            }

            // ═══════════════════════════════════════════════════════════
            //  TRADE — consumer → producer
            // ═══════════════════════════════════════════════════════════
            if (ws._role === 'tv_consumer') {
                const ch = tradeChannels.get(ws._userKey);
                if (ch && (msg.type === 'trade_ack' || msg.type === 'dom_snapshot' || msg.type === 'consumer_log')) {
                    if (ch.producer && ch.producer.readyState === 1) {
                        ch.producer.send(JSON.stringify(msg));
                    }
                    if (msg.type === 'dom_snapshot') {
                        console.log(`[dom_snapshot] userKey=${ws._userKey} (${JSON.stringify(msg).length}B)`);
                    }
                    return;
                }
            }

            // ═══════════════════════════════════════════════════════════
            //  Ping/pong applicativo generico
            // ═══════════════════════════════════════════════════════════
            if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong', ts: Date.now() })); return; }

        } catch (e) { console.error('[error]', e.message); }
    });

    ws.on('close', () => {
        console.log(`[-] ${ws._role || '?'} disconnesso`);

        // SCRAPER cleanup (v11) — solo agent SENZA teamKey
        if (ws._role === 'agent' && !ws._teamKey) {
            agents.delete(ws);
            if (ws === activeAgent) activeAgent = null;
        }
        if (ws === bridge) bridge = null;

        // CGC-BATCH cleanup (v12)
        if (ws._role === 'agent' && ws._teamKey) {
            const set = apkByKey.get(ws._teamKey);
            if (set) { set.delete(ws); if (set.size === 0) apkByKey.delete(ws._teamKey); }
            console.log(`[apk] disconnect team=${shortKey(ws._teamKey)} serial=${ws._serial}`);
        }
        if (ws._role === 'cgc' && ws._teamKey) {
            const set = cgcByKey.get(ws._teamKey);
            if (set) { set.delete(ws); if (set.size === 0) cgcByKey.delete(ws._teamKey); }
            console.log(`[cgc] disconnect team=${shortKey(ws._teamKey)}`);
        }

        // TRADE cleanup (v11)
        if (ws._role === 'adp_producer' || ws._role === 'tv_consumer') {
            const key = ws._userKey;
            const ch = tradeChannels.get(key);
            if (ch) {
                if (ws._role === 'adp_producer' && ch.producer === ws) {
                    ch.producer = null;
                    ch.consumers.forEach(c => {
                        if (c.readyState === 1) c.send(JSON.stringify({ type: 'peer_status', peer: 'producer', status: 'offline' }));
                    });
                } else if (ws._role === 'tv_consumer') {
                    ch.consumers.delete(ws);
                    if (ch.producer && ch.producer.readyState === 1) {
                        ch.producer.send(JSON.stringify({ type: 'peer_status', peer: 'consumer', status: 'offline', total: ch.consumers.size }));
                    }
                }
                pruneChannel(key);
            }
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

// ─── Start ───
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Scraper Bookmaker Relay v12 on :${PORT}`));
