// Scraper Bookmaker Relay v3 — Minimal
// Solo routing + anti-loop. Claude decide TUTTO.

const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 2 * 1024 * 1024 });

let agents = new Set(), activeAgent = null, bridge = null;
const sessions = new Map();

function getSession(host) {
    if (!sessions.has(host)) sessions.set(host, { host, ts: Date.now(), actions: [], keys: new Set(), asks: 0 });
    return sessions.get(host);
}

function checkLoop(host, action) {
    const s = getSession(host);
    const key = action.type + '|' + (action.value || '').substring(0, 50);
    if (['scroll','scrape_dom'].includes(action.type)) {
        if (s.actions.filter(a => a.type === action.type).length >= 4) return true;
    } else if (s.keys.has(key)) return true;
    s.keys.add(key);
    s.actions.push({ type: action.type, value: action.value, ts: Date.now() });
    return false;
}

app.use(express.json());
app.get('/', (req, res) => {
    const ss = {};
    sessions.forEach((s, h) => { ss[h] = { actions: s.actions.length, asks: s.asks }; });
    res.json({ status: 'ok', agents: agents.size, bridge: bridge ? 'on' : 'off', uptime: Math.round(process.uptime()) + 's', sessions: ss });
});
app.get('/sessions', (req, res) => { const o = {}; sessions.forEach((s,h) => { o[h] = s; }); res.json(o); });
app.delete('/sessions', (req, res) => { sessions.clear(); res.json({ok:1}); });

wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw);

            if (msg.type === 'register') {
                if (msg.role === 'agent') {
                    agents.add(ws); ws._role = 'agent';
                    ws.send(JSON.stringify({ type: 'registered', role: 'agent', bridge: bridge ? 'online' : 'offline' }));
                    if (bridge?.readyState === 1) bridge.send(JSON.stringify({ type: 'agent_status', status: 'connected' }));
                } else if (msg.role === 'bridge') {
                    bridge = ws; ws._role = 'bridge';
                    ws.send(JSON.stringify({ type: 'registered', role: 'bridge' }));
                    agents.forEach(a => { if (a.readyState === 1) a.send(JSON.stringify({ type: 'bridge_status', status: 'connected' })); });
                }
                return;
            }

            // Agent → Bridge (tutto va a Claude)
            if (ws._role === 'agent' && msg.type === 'need_help') {
                const host = msg.context?.host || '?';
                const s = getSession(host);
                s.asks++;

                // Arricchisci con storico
                msg.context.sessionHistory = s.actions.slice(-10).map(a => a.type + '→' + (a.value||'').substring(0,40));

                if (bridge?.readyState === 1) {
                    activeAgent = ws;
                    console.log(`[${host}] → Claude #${s.asks} (${msg.isFirst ? 'PRIMO' : 'f/u'})`);
                    bridge.send(JSON.stringify(msg));
                } else {
                    console.log(`[${host}] ⚠️ Bridge offline`);
                    ws.send(JSON.stringify({ type: 'error', message: 'Bridge non connesso — apri claude.ai con lo script bridge' }));
                }
                return;
            }

            // Bridge → Agent (con anti-loop)
            if (ws._role === 'bridge' && msg.type === 'action') {
                if (activeAgent?.readyState === 1 && msg.action) {
                    // Trova host attivo
                    let host = null;
                    sessions.forEach((s, h) => { if (!host || s.ts > sessions.get(host)?.ts) host = h; });

                    if (host && checkLoop(host, msg.action)) {
                        // Loop! Rimanda a Claude con messaggio di errore
                        console.log(`[${host}] ⚠️ Loop "${msg.action.type}" → rimando a Claude`);
                        if (bridge?.readyState === 1) {
                            bridge.send(JSON.stringify({
                                type: 'need_help', isFirst: false,
                                result: 'ERRORE LOOP: azione "' + msg.action.type + ': ' + (msg.action.value||'') + '" già eseguita. Non ripeterla. Azioni già fatte: ' + [...getSession(host).keys].join(', ') + '. Suggerisci qualcosa di DIVERSO.',
                                context: { step: 99, maxSteps: 99, host: host, intercepted: [], links: [] }
                            }));
                        }
                        return;
                    }
                    console.log(`[bridge→agent] ${msg.action.type}`);
                    activeAgent.send(JSON.stringify(msg));
                } else {
                    ws.send(JSON.stringify({ type: 'error', message: 'Agent non connesso' }));
                }
                return;
            }

            if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }
        } catch (e) { console.error('[err]', e.message); }
    });

    ws.on('close', () => {
        if (ws._role === 'agent') { agents.delete(ws); if (ws === activeAgent) activeAgent = null; }
        if (ws === bridge) { bridge = null; agents.forEach(a => { if (a.readyState === 1) a.send(JSON.stringify({ type: 'bridge_status', status: 'disconnected' })); }); }
    });
});

setInterval(() => { wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); }); }, 30000);
setInterval(() => { const cut = Date.now() - 7200000; sessions.forEach((s,h) => { if (s.ts < cut) sessions.delete(h); }); }, 300000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Relay v3 on :${PORT}`));
