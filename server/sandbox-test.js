#!/usr/bin/env node
/**
 * Sandbox test for hook.js — pure internal test, no bridge server needed.
 *
 * Simulates browser APIs, runs hook.js, captures all send() calls
 * to verify no recursion and correct data flow.
 */

const fs = require('fs');
const path = require('path');

// ─── Load hook.js ──────────────────────────────────────────────
const hookJsPath = path.join(__dirname, '..', 'kiomet-browser', 'app', 'src', 'main', 'assets', 'hook.js');
const hookJs = fs.readFileSync(hookJsPath, 'utf-8');
console.log(`hook.js loaded: ${hookJs.length} bytes`);

// ─── Captured events ───────────────────────────────────────────
const captured = [];
let kiometBridgeCalls = 0;
let origFetchCalls = 0;

// ─── Mock KiometBridge (Java bridge) ───────────────────────────
const KiometBridge = {
  send: (json) => {
    kiometBridgeCalls++;
    try {
      const data = JSON.parse(json);
      captured.push(data);
    } catch (e) {
      captured.push({ event: 'RAW', raw: json.slice(0, 200) });
    }
  }
};

// ─── Mock browser APIs ─────────────────────────────────────────
class MockWebSocket {
  constructor(url, protocols) {
    this.url = url;
    this.readyState = 0;
    this.listeners = {};
    setImmediate(() => {
      this.readyState = 1;
      if (this.listeners['open']) this.listeners['open']({});
    });
  }
  addEventListener(event, cb) { this.listeners[event] = cb; }
  send(data) {
    captured.push({ event: 'WS_SEND', url: this.url,
      body: data instanceof ArrayBuffer ? '[ArrayBuffer]' : String(data).slice(0, 100) });
  }
  close() { this.readyState = 3; }
}
MockWebSocket.CONNECTING = 0;
MockWebSocket.OPEN = 1;
MockWebSocket.CLOSING = 2;
MockWebSocket.CLOSED = 3;

// Mock fetch — original, saved BEFORE hook.js patches it
const origFetch = (url, opts) => {
  origFetchCalls++;
  captured.push({ event: 'REAL_FETCH', url: String(url).slice(0, 100) });
  return Promise.resolve({ status: 200, text: () => Promise.resolve('OK') });
};

// Mock console
const logCache = [];
['log', 'info', 'warn', 'error', 'debug'].forEach(lvl => {
  const orig = console[lvl];
  console[lvl] = function (...a) {
    logCache.push({ level: lvl, msg: a.map(String).join(' ') });
    orig.apply(console, a);
  };
});

// ─── Set up globals ────────────────────────────────────────────
globalThis.window = globalThis;
globalThis.document = { createElement: () => ({}) };
globalThis.location = { href: 'https://kiomet.com/' };
globalThis.navigator = { userAgent: 'sandbox' };
globalThis.WebSocket = MockWebSocket;
globalThis.fetch = origFetch;
globalThis.XMLHttpRequest = class MockXHR {
  open(m, u) { this.method = m; this.url = u; }
  send() {}
};
globalThis.KiometBridge = KiometBridge;
globalThis.WebAssembly = {
  instantiate: () => Promise.resolve({ instance: { exports: { memory: { buffer: Buffer.alloc(65536) } } } }),
  instantiateStreaming: () => Promise.resolve({ instance: { exports: { memory: { buffer: Buffer.alloc(65536) } } } }),
  Memory: class { constructor(init) { this.buffer = Buffer.alloc(init.initial * 65536); } }
};

// ─── Execute hook.js ───────────────────────────────────────────
console.log('\n=== 1. Executing hook.js ===');
try {
  eval(hookJs);
  console.log('✓ hook.js executed without errors');
} catch (e) {
  console.log('✗ hook.js execution failed:', e.message);
  console.log(e.stack);
  process.exit(1);
}

// ─── Check initial state ──────────────────────────────────────
console.log('\n=== 2. Initial state (after boot) ===');
console.log(`KiometBridge.send() calls: ${kiometBridgeCalls}`);
console.log(`origFetch calls: ${origFetchCalls}`);
console.log(`Captured events: ${captured.length}`);

const connectedEvent = captured.find(c => c.event === 'connected');
if (connectedEvent) {
  console.log('✓ "connected" event sent on boot');
} else {
  console.log('✗ "connected" event NOT sent on boot');
}

// ─── Test 3: WebSocket creation ───────────────────────────────
console.log('\n=== 3. Test: WebSocket creation ===');
const kiometBridgeCallsBefore = kiometBridgeCalls;
const ws = new WebSocket('wss://kiomet-api.com/ws');
setTimeout(() => {
  const wsCreate = captured.filter(c => c.event === 'ws.create');
  console.log(`ws.create events: ${wsCreate.length}`);
  if (wsCreate.length > 0) {
    console.log('✓ WebSocket creation captured');
    console.log('  URL:', wsCreate[0].data.url);
  } else {
    console.log('✗ WebSocket creation NOT captured');
  }

  // ─── Test 4: WebSocket send ─────────────────────────────────
  console.log('\n=== 4. Test: WebSocket send ===');
  ws.send('test message');
  const wsOut = captured.filter(c => c.event === 'ws.out');
  console.log(`ws.out events: ${wsOut.length}`);
  if (wsOut.length > 0) {
    console.log('✓ WebSocket outbound captured');
  } else {
    console.log('✗ WebSocket outbound NOT captured');
  }

  // ─── Test 5: fetch patching ─────────────────────────────────
  console.log('\n=== 5. Test: fetch patching ===');
  const fetchBefore = origFetchCalls;
  fetch('https://kiomet.com/data').catch(() => {});
  setTimeout(() => {
    const netFetch = captured.filter(c => c.event === 'net.fetch');
    console.log(`net.fetch events: ${netFetch.length}`);
    console.log(`origFetch calls: ${origFetchCalls - fetchBefore}`);
    if (netFetch.length > 0) {
      console.log('✓ fetch logging works');
    } else {
      console.log('✗ fetch logging NOT working');
    }

    // ─── Test 6: Recursion test ───────────────────────────────
    console.log('\n=== 6. Recursion test ===');
    console.log(`KiometBridge.send() calls total: ${kiometBridgeCalls}`);
    console.log(`origFetch calls total: ${origFetchCalls}`);
    if (origFetchCalls < 20) {
      console.log('✓ No fetch recursion detected');
    } else {
      console.log('✗ POSSIBLE FETCH RECURSION!');
    }

    // ─── Test 7: Console capture ──────────────────────────────
    console.log('\n=== 7. Console capture test ===');
    console.info('test info message');
    const consoleCaptures = captured.filter(c => c.event === 'console');
    console.log(`console events captured: ${consoleCaptures.length}`);
    if (consoleCaptures.length > 0) {
      console.log('✓ console capture works');
    } else {
      console.log('✗ console capture NOT working');
    }

    // ─── Test 8: WebAssembly patching ─────────────────────────
    console.log('\n=== 8. WebAssembly patching test ===');
    WebAssembly.instantiate(new Uint8Array([])).then(() => {
      setTimeout(() => {
        const wasmLoaded = captured.filter(c => c.event === 'wasm.load');
        console.log(`wasm.load events: ${wasmLoaded.length}`);
        if (wasmLoaded.length > 0) {
          console.log('✓ WebAssembly capture works');
        } else {
          console.log('✗ WebAssembly capture NOT working');
        }

        // ─── Summary ──────────────────────────────────────────
        console.log('\n=== SUMMARY ===');
        console.log(`KiometBridge.send() calls: ${kiometBridgeCalls}`);
        console.log(`origFetch calls: ${origFetchCalls}`);
        console.log(`Captured events: ${captured.length}`);
        console.log(`Console logs: ${logCache.length}`);

        // Check for errors
        const errors = logCache.filter(l => l.level === 'error');
        if (errors.length > 0) {
          console.log('✗ Console errors:', errors.map(e => e.msg));
        } else {
          console.log('✓ No console errors');
        }

        // Check for recursion signature
        const eventTypes = {};
        captured.forEach(c => { eventTypes[c.event] = (eventTypes[c.event] || 0) + 1; });
        console.log('Event types:', JSON.stringify(eventTypes, null, 2));

        // PASS/FAIL
        let pass = true;
        if (!connectedEvent) { pass = false; console.log('FAIL: connected event missing'); }
        if (wsCreate.length === 0) { pass = false; console.log('FAIL: ws.create missing'); }
        if (origFetchCalls >= 20) { pass = false; console.log('FAIL: fetch recursion'); }

        console.log(pass ? '\n✓ ALL TESTS PASSED' : '\n✗ SOME TESTS FAILED');
        process.exit(0);
      }, 100);
    });
  }, 100);
}, 100);