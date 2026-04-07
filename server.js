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
let agents = new Set();  // tutti gli agent connessi
let activeAgent = null;  // l'agent che ha chiesto aiuto (riceve la risposta)
let bridge = null;

// ─── Health endpoint ───
app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        service: 'scraper-bookmaker-relay',
        agent: agents.size + ' connected' + (activeAgent ? ' (1 active)' : ''),
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
                    agents.add(ws);
                    ws._role = 'agent';
                    console.log(`[agent] Registrato (${agents.size} totali)`);
                    ws.send(JSON.stringify({ type: 'registered', role: 'agent', bridge: bridge ? 'online' : 'offline' }));
                    if (bridge && bridge.readyState === 1) {
                        bridge.send(JSON.stringify({ type: 'agent_status', status: 'connected' }));
                    }
                } else if (msg.role === 'bridge') {
                    bridge = ws;
                    ws._role = 'bridge';
                    console.log('[bridge] Registrato');
                    ws.send(JSON.stringify({ type: 'registered', role: 'bridge', agent: agents.size > 0 ? 'online' : 'offline' }));
                    agents.forEach(a => {
                        if (a.readyState === 1) a.send(JSON.stringify({ type: 'bridge_status', status: 'connected' }));
                    });
                }
                return;
            }

            // Forward: agent → bridge (salva chi ha chiesto)
            if (ws._role === 'agent' && msg.type === 'need_help') {
                activeAgent = ws;  // QUESTO agent riceverà la risposta
                console.log(`[agent→bridge] need_help (${JSON.stringify(msg).length}B)`);
                if (bridge && bridge.readyState === 1) {
                    bridge.send(JSON.stringify(msg));
                } else {
                    ws.send(JSON.stringify({ type: 'error', message: 'Bridge non connesso — apri claude.ai con il bridge script' }));
                }
                return;
            }

            // Forward: bridge → agent ATTIVO (quello che ha chiesto)
            if (ws._role === 'bridge' && msg.type === 'action') {
                console.log(`[bridge→agent] action: ${msg.action?.type || '?'}`);
                if (activeAgent && activeAgent.readyState === 1) {
                    activeAgent.send(JSON.stringify(msg));
                    console.log('[bridge→agent] Inviato all\'agent attivo');
                } else {
                    ws.send(JSON.stringify({ type: 'error', message: 'Agent attivo non connesso' }));
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

// ─── Start ───
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Scraper Bookmaker Relay running on :${PORT}`);
});
