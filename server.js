// ═══════════════════════════════════════════════════════════════════════
//  Scraper Bookmaker Relay — Railway WebSocket server
//  Ponte tra Agent TM (bookmaker) ↔ Bridge TM (claude.ai)
//
//  Deploy: Railway, set PORT env var
//  npm init -y && npm install ws express
// ═══════════════════════════════════════════════════════════════════════

const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 1024 * 1024 }); // 1MB

// ─── State ───
let agent = null;   // WS del TM agent (su bookmaker)
let bridge = null;  // WS del TM bridge (su claude.ai)

// ─── Health endpoint ───
app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        service: 'scraper-bookmaker-relay',
        agent: agent ? 'connected' : 'disconnected',
        bridge: bridge ? 'connected' : 'disconnected',
        uptime: Math.round(process.uptime()) + 's'
    });
});

// ─── WebSocket ───
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
                    agent = ws;
                    ws._role = 'agent';
                    console.log('[agent] Registrato');
                    ws.send(JSON.stringify({ type: 'registered', role: 'agent', bridge: bridge ? 'online' : 'offline' }));
                    // Notifica bridge
                    if (bridge && bridge.readyState === 1) {
                        bridge.send(JSON.stringify({ type: 'agent_status', status: 'connected' }));
                    }
                } else if (msg.role === 'bridge') {
                    bridge = ws;
                    ws._role = 'bridge';
                    console.log('[bridge] Registrato');
                    ws.send(JSON.stringify({ type: 'registered', role: 'bridge', agent: agent ? 'online' : 'offline' }));
                    // Notifica agent
                    if (agent && agent.readyState === 1) {
                        agent.send(JSON.stringify({ type: 'bridge_status', status: 'connected' }));
                    }
                }
                return;
            }

            // Forward: agent → bridge
            if (ws._role === 'agent' && msg.type === 'need_help') {
                console.log(`[agent→bridge] need_help (${JSON.stringify(msg).length}B)`);
                if (bridge && bridge.readyState === 1) {
                    bridge.send(JSON.stringify(msg));
                } else {
                    ws.send(JSON.stringify({ type: 'error', message: 'Bridge non connesso — apri claude.ai con il bridge script' }));
                }
                return;
            }

            // Forward: bridge → agent
            if (ws._role === 'bridge' && msg.type === 'action') {
                console.log(`[bridge→agent] action: ${msg.action?.type || '?'}`);
                if (agent && agent.readyState === 1) {
                    agent.send(JSON.stringify(msg));
                } else {
                    ws.send(JSON.stringify({ type: 'error', message: 'Agent non connesso' }));
                }
                return;
            }

            // Ping/pong applicativo
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
        if (ws === agent) {
            agent = null;
            if (bridge && bridge.readyState === 1)
                bridge.send(JSON.stringify({ type: 'agent_status', status: 'disconnected' }));
        }
        if (ws === bridge) {
            bridge = null;
            if (agent && agent.readyState === 1)
                agent.send(JSON.stringify({ type: 'bridge_status', status: 'disconnected' }));
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
server.listen(PORT, () => {
    console.log(`Scraper Bookmaker Relay running on :${PORT}`);
});
