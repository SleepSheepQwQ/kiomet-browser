#!/usr/bin/env node
/**
 * Diagnostic bridge server — receives and logs ALL data from hook.js
 * with detailed error reporting.
 *
 * Usage: node diag-bridge.js [--port 9996]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const LOG_DIR = __dirname;
const logStream = fs.createWriteStream(
    path.join(LOG_DIR, `diag_${Date.now()}.jsonl`),
    { flags: 'a' }
);

const port = (() => {
  const idx = process.argv.indexOf('--port');
  return (idx !== -1 && process.argv[idx + 1]) ? parseInt(process.argv[idx + 1], 10) : 9996;
})();
let requestCount = 0;
let lastRequestTime = 0;

const server = http.createServer((req, res) => {
    requestCount++;
    const now = Date.now();
    const timeSinceLast = lastRequestTime ? (now - lastRequestTime) + 'ms' : 'first';
    lastRequestTime = now;

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
        const entry = {
            ts: new Date().toISOString(),
            method: req.method,
            url: req.url,
            headers: req.headers,
            body: body,
            bodyLen: body.length,
            requestNum: requestCount,
            timeSinceLast: timeSinceLast
        };

        // Log to file
        logStream.write(JSON.stringify(entry) + '\n');

        // Log to console
        console.log(`\n[${entry.ts}] REQ #${requestCount} (${timeSinceLast})`);
        console.log(`  Method: ${req.method} ${req.url}`);
        console.log(`  Body: ${body.slice(0, 500)}${body.length > 500 ? '...' : ''}`);

        // Try to parse as JSON
        try {
            const data = JSON.parse(body);
            console.log(`  Event: ${data.event}`);
            if (data.data) {
                const dataStr = JSON.stringify(data.data).slice(0, 200);
                console.log(`  Data: ${dataStr}`);
            }
        } catch (e) {
            console.log(`  Raw body (not JSON): ${body.slice(0, 200)}`);
        }

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
    console.log('DIAGNOSTIC BRIDGE SERVER');
    console.log('='.repeat(60));
    console.log(`Listening: http://0.0.0.0:9996`);
    console.log(`Log file: ${logStream.path}`);
    console.log('='.repeat(60));
    console.log('Waiting for data...\n');
});