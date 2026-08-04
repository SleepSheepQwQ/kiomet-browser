/*
 * hook.js v3 — Kiomet protocol capture harness
 *
 * Purpose: intercept Kiomet's WebSocket / fetch / WASM traffic inside a
 * WebView shell and stream raw binary (hex) frames + metadata to a local
 * bridge server for offline bitcode analysis.
 *
 * Bidirectional: bridge pushes commands back via KiometBridge; hook.js
 * executes them and reports results.
 */

(function () {
  if (window.__hook) return;
  window.__hook = { booted: false, errors: [], events: 0, cmdSubscribers: [] };

  const BRIDGE = "http://127.0.0.1:9996/log";
  const ts = () => Date.now();

  // ─── Helpers ──────────────────────────────────────────────────
  function ab2hex(buf) {
    try {
      const b = new Uint8Array(buf);
      const hex = new Array(b.length);
      for (let i = 0; i < b.length; i++) {
        hex[i] = (b[i] < 0x10 ? '0' : '') + b[i].toString(16);
      }
      return hex.join('');
    } catch { return ''; }
  }

  // ─── Error tracking ──────────────────────────────────────────
  const errors = [];
  const MAX_ERRORS = 20;
  let _logErrorDepth = 0;
  function logError(source, msg, detail) {
    if (_logErrorDepth > 0) return;
    _logErrorDepth++;
    try {
      const err = { ts: ts(), source, msg, detail: String(detail).slice(0, 200) };
      errors.push(err);
      if (errors.length > MAX_ERRORS) errors.shift();
      trySend({ event: "error", ts: ts(), data: err });
    } catch (e) {
      errors.push({ ts: ts(), source: "logError", msg: "logError failed",
                    detail: String(e).slice(0, 100) });
    } finally { _logErrorDepth--; }
  }

  // ─── Multi-path send ────────────────────────────────────────
  let sentCount = 0;
  let _sendDepth = 0;
  function trySend(obj) {
    if (_sendDepth > 0) return;
    _sendDepth++;
    try {
      const body = JSON.stringify(obj);
      sentCount++;
      try {
        if (typeof KiometBridge !== 'undefined') KiometBridge.send(body);
      } catch (e) { logError("send", "KiometBridge failed", e.message); }
      try {
        if (typeof navigator !== 'undefined' && navigator.sendBeacon)
          navigator.sendBeacon(BRIDGE, body);
      } catch (e) { logError("send", "sendBeacon failed", e.message); }
      try {
        const img = new Image();
        img.src = BRIDGE + "?d=" + encodeURIComponent(body.slice(0, 1000));
      } catch (e) { logError("send", "Image beacon failed", e.message); }
      try {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", BRIDGE, true);
        xhr.setRequestHeader("Content-Type", "text/plain");
        xhr.send(body);
      } catch (e) { logError("send", "XHR failed", e.message); }
    } finally { _sendDepth--; }
  }

  // ─── Diagnostic report ──────────────────────────────────────
  function sendDiag() {
    trySend({
      event: "diag", ts: ts(), data: {
        sentCount,
        errorCount: errors.length,
        windowKeys: Object.keys(window).filter(k => !k.startsWith('_')).slice(0, 50),
        hasKiometBridge: typeof KiometBridge !== 'undefined',
        hasSendBeacon: typeof navigator !== 'undefined' && typeof navigator.sendBeacon !== 'undefined',
        location: window.location ? window.location.href : 'unknown',
        userAgent: navigator ? navigator.userAgent : 'unknown',
        errors: errors.slice(-10)
      }
    });
  }

  // ─── 1. WebSocket proxy (CAPTURES RAW BINARY AS HEX) ─────────
  try {
    const RealWebSocket = WebSocket;
    const wsMap = new Map();

    window.WebSocket = function (...args) {
      const url = args[0];
      const protocols = args[1];
      const wsId = "ws_" + Math.random().toString(36).slice(2, 8);

      trySend({ event: "ws.create", ts: ts(), data: { url, protocols, id: wsId } });

      const ws = new RealWebSocket(url, protocols);
      wsMap.set(ws, { url, id: wsId, status: 'connecting' });

      const origSend = ws.send.bind(ws);
      ws.send = function (data) {
        const type = data instanceof ArrayBuffer ? 'ArrayBuffer'
                  : data instanceof Blob        ? 'Blob' : 'string';
        trySend({
          event: "ws.out", ts: ts(),
          data: {
            id: wsId, url, type,
            // Raw payload — the whole point of this tool
            hex: (data instanceof ArrayBuffer) ? ab2hex(data)
                : (data instanceof Blob)      ? ''
                : btoa(String(data)),
            len: data.byteLength || data.size || String(data).length
          }
        });
        return origSend(data);
      };

      ws.addEventListener("message", (e) => {
        const type = e.data instanceof ArrayBuffer ? 'ArrayBuffer'
                  : e.data instanceof Blob        ? 'Blob' : 'string';
        trySend({
          event: "ws.in", ts: ts(),
          data: {
            id: wsId, url, type,
            hex: (e.data instanceof ArrayBuffer) ? ab2hex(e.data)
                : (e.data instanceof Blob)      ? ''
                : btoa(String(e.data)),
            len: e.data.byteLength || e.data.size || String(e.data).length
          }
        });
      });

      ws.addEventListener("close", (e) => {
        wsMap.get(ws) && wsMap.get(ws).status &&
          (wsMap.get(ws).status = 'closed');
        trySend({ event: "ws.close", ts: ts(),
                  data: { id: wsId, url, code: e.code, reason: e.reason } });
      });

      ws.addEventListener("error", (e) => {
        wsMap.get(ws) && (wsMap.get(ws).status = 'error');
        trySend({ event: "ws.error", ts: ts(),
                  data: { id: wsId, url, msg: String(e.message) } });
      });

      return ws;
    };
    window.WebSocket.CONNECTING = RealWebSocket.CONNECTING;
    window.WebSocket.OPEN = RealWebSocket.OPEN;
    window.WebSocket.CLOSING = RealWebSocket.CLOSING;
    window.WebSocket.CLOSED = RealWebSocket.CLOSED;
  } catch (e) { logError("ws", "WebSocket patch failed", e.message); }

  // ─── 2. fetch proxy ─────────────────────────────────────────
  try {
    const origFetch = window.fetch;
    window.fetch = function (...args) {
      const u = args[0];
      const opts = args[1] || {};
      trySend({
        event: "net.fetch", ts: ts(),
        data: {
          method: (opts.method || "GET").toUpperCase(),
          url: u instanceof Request ? u.url : String(u),
          body: opts.body ? (opts.body instanceof ArrayBuffer ? ab2hex(opts.body)
                 : opts.body instanceof Blob ? ''
                 : String(opts.body).slice(0, 500)) : undefined
        }
      });
      return origFetch.apply(this, args);
    };
  } catch (e) { logError("fetch", "fetch patch failed", e.message); }

  // ─── 3. XHR proxy ───────────────────────────────────────────
  try {
    const OrigXHR = window.XMLHttpRequest;
    window.XMLHttpRequest = function () {
      const xhr = new OrigXHR();
      const origOpen = xhr.open.bind(xhr);
      const origSend = xhr.send.bind(xhr);
      xhr.open = function (...a) {
        trySend({ event: "net.xhr", ts: ts(), data: { method: a[0], url: String(a[1]) } });
        return origOpen(...a);
      };
      xhr.send = function (data) {
        trySend({
          event: "net.xhr_body", ts: ts(),
          data: {
            method: xhr.method, url: xhr.url,
            hex: (data instanceof ArrayBuffer) ? ab2hex(data)
                : (data instanceof Blob) ? ''
                : (data == null ? '' : String(data).slice(0, 500)),
            len: data && (data.byteLength || data.size || String(data).length) || 0
          }
        });
        return origSend(data);
      };
      return xhr;
    };
    window.XMLHttpRequest.prototype = OrigXHR.prototype;
  } catch (e) { logError("xhr", "XHR patch failed", e.message); }

  // ─── 4. WebAssembly proxy ───────────────────────────────────
  try {
    const origInst = WebAssembly.instantiate;
    const origInstStream = WebAssembly.instantiateStreaming;

    function onWasmLoad(instance, source) {
      window.wasm = instance;
      try {
        const exp = instance.exports;
        trySend({ event: "wasm.load", ts: ts(),
                  data: { keys: Object.keys(exp).join(","), source } });
        if (exp.memory) {
          trySend({ event: "wasm.mem_info", ts: ts(),
                    data: { byteLength: exp.memory.buffer.byteLength } });
        }
      } catch (e) { logError("wasm", "capture failed", e.message); }
    }

    WebAssembly.instantiate = function (...args) {
      try {
        const p = origInst(...args);
        p.then(({ instance }) => onWasmLoad(instance, 'instantiate'));
        return p;
      } catch (e) { return origInst(...args); }
    };

    WebAssembly.instantiateStreaming = function (...args) {
      try {
        const p = origInstStream(...args);
        p.then(({ instance }) => onWasmLoad(instance, 'instantiateStreaming'));
        return p;
      } catch (e) { return origInstStream(...args); }
    };
  } catch (e) { logError("wasm", "WASM patch failed", e.message); }

  // ─── 5. Console proxy ───────────────────────────────────────
  try {
    ["log", "info", "warn", "error", "debug"].forEach(lvl => {
      const orig = console[lvl];
      console[lvl] = function (...a) {
        trySend({ event: "console", ts: ts(),
                  data: { level: lvl, msg: a.map(String).join(" ") } });
        orig.apply(console, a);
      };
    });
  } catch (e) { logError("console", "console patch failed", e.message); }

  // ─── 6. Error handlers ──────────────────────────────────────
  try {
    window.addEventListener("error", (e) => {
      logError("window", "Uncaught error", e.message);
      trySend({ event: "error", ts: ts(),
                data: { msg: String(e.message),
                        stack: String(e.error && e.error.stack) } });
    });
    window.addEventListener("unhandledrejection", (e) => {
      logError("window", "Unhandled rejection", e.reason);
      trySend({ event: "rejection", ts: ts(),
                data: { reason: String(e.reason) } });
    });
  } catch (e) { logError("init", "Error handler setup failed", e.message); }

  // ─── 7. Command channel — receives via KiometBridge ─────────
  // The Java bridge layer opens a WebSocket to the bridge server.
  // When the server sends a command, it arrives as KiometBridge.command().
  // We store the handler here and report results back via trySend.
  window.__hook.handleCommand = function (cmd, payload, requestId) {
    const result = { event: "cmd_result", ts: ts(), data: {
      cmd, requestId: requestId || null, ok: true
    }};

    try {
      switch (cmd) {
        case 'eval': {
          const code = (payload || {}).code || '';
          try {
            const rv = eval(code);
            result.data.returnValue = typeof rv === 'object'
              ? JSON.stringify(rv).slice(0, 5000) : String(rv);
          } catch (e) {
            result.data.returnValue = null;
            result.data.error = String(e.message);
          }
          break;
        }
        case 'memory_dump': {
          const offset = (payload || {}).offset || 0;
          const len = (payload || {}).len || 256;
          const mem = (window.wasm && window.wasm.exports &&
                       window.wasm.exports.memory) ?
            window.wasm.exports.memory.buffer : null;
          if (mem) {
            const buf = mem.slice(offset, offset + len);
            result.data.hex = ab2hex(buf);
            result.data.offset = offset;
            result.data.len = buf.byteLength;
          } else {
            result.data.ok = false;
            result.data.error = "no WASM memory";
          }
          break;
        }
        case 'wasm_snapshot': {
          if (window.wasm && window.wasm.exports) {
            result.data.exports = Object.keys(window.wasm.exports)
              .map(k => ({ name: k, type: typeof window.wasm.exports[k] }));
            if (window.wasm.exports.memory) {
              result.data.memory = {
                byteLength: window.wasm.exports.memory.buffer.byteLength,
                bufferSize: window.wasm.exports.memory.buffer.byteLength
              };
            }
          } else {
            result.data.exports = [];
            result.data.error = "no WASM instance";
          }
          break;
        }
        case 'memory_search': {
          const pattern = (payload || {}).pattern || '';
          const mem = (window.wasm && window.wasm.exports &&
                       window.wasm.exports.memory) ?
            window.wasm.exports.memory.buffer : null;
          if (mem && pattern) {
            const targetBytes = pattern.match(/../g).map(h => parseInt(h, 16));
            const bytes = new Uint8Array(mem);
            const matches = [];
            for (let i = 0; i <= bytes.length - targetBytes.length; i++) {
              if (targetBytes.every((b, j) => bytes[i + j] === b)) {
                matches.push(i);
                if (matches.length >= 50) break;
              }
            }
            result.data.matches = matches;
            result.data.pattern = pattern;
            result.data.scannedBytes = bytes.length;
          } else {
            result.data.ok = false;
            result.data.error = "no WASM memory or no pattern";
          }
          break;
        }
        case 'window_dump': {
          result.data.keys = Object.keys(window)
            .filter(k => !k.startsWith('_') && typeof window[k] !== 'undefined')
            .slice(0, 200);
          break;
        }
        default:
          result.data.ok = false;
          result.data.error = "unknown command: " + cmd;
      }
    } catch (e) {
      result.data.ok = false;
      result.data.error = String(e.message);
    }

    trySend(result);
    return result;
  };

  // ─── 8. Boot ────────────────────────────────────────────────
  trySend({ event: "connected", ts: ts(), data: {
    userAgent: navigator.userAgent,
    location: location.href,
    hookVersion: "v3"
  }});
  window.__hook.booted = true;

  setInterval(sendDiag, 5000);
  setInterval(() => trySend({
    event: "heartbeat", ts: ts(),
    data: { sentCount, errorCount: errors.length }
  }), 10000);

  console.log("[hook] v3 loaded. Bridge: " + BRIDGE +
              " | captures raw hex for bitcode analysis");
})();
