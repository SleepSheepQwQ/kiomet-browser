#!/usr/bin/env node
/**
 * Diagnostic bridge server — HTTP + WebSocket bridge.
 *
 * Receives data from hook.js via HTTP POST and WebSocket,
 * and sends commands back to the WebView over WebSocket.
 *
 * Usage: node diag-bridge.js [--port 9996]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────
const port = (() => {
  const idx = process.argv.indexOf('--port');
  return (idx !== -1 && process.argv[idx + 1]) ? parseInt(process.argv[idx + 1], 10) : 9996;
})();

const LOG_DIR = __dirname;
const logStream = fs.createWriteStream(
    path.join(LOG_DIR, `diag_${Date.now()}.jsonl`),
    { flags: 'a' }
);

// ─── State ────────────────────────────────────────────────────
let requestCount = 0;
let lastRequestTime = 0;

// In-memory connection map: pkg-uid-string -> { ws, path }
// A client identifies itself by URL query ?client=kiomet
const clients = new Map();

// ─── Simple WebSocket handshake (no external deps) ────────────
function isUpgrade(req) {
  const u = (req.headers.upgrade || '').toLowerCase();
  const c = (req.headers['connection'] || '').toLowerCase();
  return u === 'websocket' && c.includes('upgrade');
}

function upgradeToWebSocket(req, socket) {
  const header = `HTTP/1.1 101 Switching Protocols\r\n` +
    `Upgrade: websocket\r\n` +
    `Connection: Upgrade\r\n` +
    `Access-Control-Allow-Origin: *\r\n` +
    `\r\n`;
  socket.write(header);

  // Parse URL query ?client=<name>
  const url = new URL(req.url, `http://${req.headers.host}`);
  const clientKey = url.searchParams.get('client') || url.pathname.slice(1);

  clients.set(clientKey, {
    ws: socket,
    path: req.url,
    send: (obj) => {
      if (socket.readyState !== 'open') return false;
      try {
        socket.write(':' + JSON.stringify(obj) + '\n');
        return true;
      } catch (e) {
        return false;
      }
    }
  });

  socket.on('data', (chunk) => {
    // Minimal line-based framing: data is :<json>\n
    const lines = chunk.toString('utf8').split('\n');
    for (const line of lines) {
      if (line.length < 2 || line[0] !== ':') continue;
      try {
        const data = JSON.parse(line.slice(1));
        logEntry({ method: 'WS_IN', client: clientKey, event: data.event || 'unknown', data, body: line.slice(1) });
      } catch (e) {}
    }
  });

  socket.on('error', () => clients.delete(clientKey));
  socket.on('close', () => clients.delete(clientKey));
}

// ─── Logging ──────────────────────────────────────────────────
function logEntry(entry) {
  entry.requestNum = ++requestCount;
  const now = Date.now();
  entry.timeSinceLast = lastRequestTime ? (now - lastRequestTime) + 'ms' : 'first';
  lastRequestTime = now;
  entry.ts = new Date().toISOString();
  logStream.write(JSON.stringify(entry) + '\n');
}

// ─── HTTP Server ──────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (isUpgrade(req)) {
    upgradeToWebSocket(req, req.socket);
    return;
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    const entry = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: body,
      bodyLen: body.length
    };

    if (body) {
      try {
        const data = JSON.parse(body);
        entry.event = data.event;
        entry.dataPreview = data.data ? JSON.stringify(data.data).slice(0, 200) : '';
      } catch (e) {}
    }

    logEntry(entry);

    console.log(`\n[${new Date().toISOString()}] REQ #${entry.requestNum} (${entry.method} ${entry.url})`);
    console.log(`  Body: ${body.slice(0, 500)}${body.length > 500 ? '...' : ''}`);
    if (entry.event) console.log(`  Event: ${entry.event}`);
    if (entry.dataPreview) console.log(`  Data: ${entry.dataPreview}`);

    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'text/plain'
    });
    res.end('OK');
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log('='.repeat(60));
  console.log('KIOMET BRIDGE SERVER (HTTP + WebSocket)');
  console.log('='.repeat(60));
  console.log(`Listening: http://0.0.0.0:${port}`);
  console.log(`  HTTP POST /log   ← hook.js events (inbound only)`);
  console.log(`  WS   /?client=X  ← hook.js + command channel (bidirectional)`);
  console.log(`  Send command:   node -e "..." or attach WS with same client key`);
  console.log(`Log file: ${logStream.path}`);
  console.log('='.repeat(60));
});

// ─── CLI: allow sending commands via stdin (for scripting) ────
if (process.stdin.isTTY) {
  process.on('SIGINT', () => {
    console.log('\nBridge stopped.');
    server.close();
    process.exit(0);
  });
}
