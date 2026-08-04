/*
 * hook.js v2 — comprehensive diagnostic injection for kiomet.com
 *
 * Uses ALL available methods to send data to the bridge server.
 * Reports all errors, captures all events, periodic diagnostics.
 */

(function () {
  if (window.__hook) return;
  window.__hook = { booted: false, errors: [], events: 0 };

  const BRIDGE = "http://127.0.0.1:9996/log";
  const ts = () => Date.now();

  // ─── Error tracking ──────────────────────────────────────────
  const errors = [];
  const MAX_ERRORS = 20;
  // Guard against recursive error logging — track active depth to break cycles
  let _logErrorDepth = 0;
  function logError(source, msg, detail) {
    if (_logErrorDepth > 0) return;       // already inside logError — bail
    _logErrorDepth++;
    try {
      const err = { ts: ts(), source, msg, detail: String(detail).slice(0, 200) };
      errors.push(err);
      if (errors.length > MAX_ERRORS) errors.shift();
      trySend({ event: "error", ts: ts(), data: err });
    } catch (e) {
      // Final safety net: silent, just remember it
      errors.push({ ts: ts(), source: "logError", msg: "logError failed", detail: String(e).slice(0, 100) });
    } finally {
      _logErrorDepth--;
    }
  }

  // ─── Multi-path send ────────────────────────────────────────
  let sentCount = 0;
  // Guard against error-handler recursion starving the event loop
  let _sendDepth = 0;
  function trySend(obj) {
    if (_sendDepth > 0) return;            // skip — we're already in a send cycle
    _sendDepth++;
    try {
      const body = JSON.stringify(obj);
      sentCount++;

      // Path 1: KiometBridge (Java bridge)
      try {
        if (typeof KiometBridge !== 'undefined') {
          KiometBridge.send(body);
        }
      } catch (e) {
        logError("send", "KiometBridge failed", e.message);
      }

      // Path 2: sendBeacon (most reliable for cross-origin)
      try {
        if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
          navigator.sendBeacon(BRIDGE, body);
        }
      } catch (e) {
        logError("send", "sendBeacon failed", e.message);
      }

      // Path 3: Image beacon (GET fallback)
      try {
        const img = new Image();
        img.src = BRIDGE + "?d=" + encodeURIComponent(body.slice(0, 1000));
      } catch (e) {
        logError("send", "Image beacon failed", e.message);
      }

      // Path 4: XMLHttpRequest (synchronous, but reliable)
      try {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", BRIDGE, true);
        xhr.setRequestHeader("Content-Type", "text/plain");
        xhr.send(body);
      } catch (e) {
        logError("send", "XHR failed", e.message);
      }
    } finally {
      _sendDepth--;
    }
  }

  // ─── Diagnostic report ──────────────────────────────────────
  function sendDiag() {
    trySend({
      event: "diag",
      ts: ts(),
      data: {
        sentCount: sentCount,
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

  // ─── 1. WebSocket proxy ─────────────────────────────────────
  try {
    const RealWebSocket = WebSocket;
    const wsMap = new Map();

    window.WebSocket = function (...args) {
      const url = args[0];
      const protocols = args[1];
      const wsId = "ws_" + Math.random().toString(36).slice(2, 8);

      trySend({ event: "ws.create", ts: ts(), data: { url, protocols, id: wsId } });

      const ws = new RealWebSocket(url, protocols);
      wsMap.set(ws, { url, id: wsId });

      const origSend = ws.send.bind(ws);
      ws.send = function (data) {
        trySend({
          event: "ws.out",
          ts: ts(),
          data: {
            id: wsId, url,
            type: data instanceof ArrayBuffer ? 'ArrayBuffer' : data instanceof Blob ? 'Blob' : 'string',
            len: data.byteLength || data.size || String(data).length
          }
        });
        return origSend(data);
      };

      ws.addEventListener("message", (e) => {
        trySend({
          event: "ws.in",
          ts: ts(),
          data: {
            id: wsId, url,
            type: e.data instanceof ArrayBuffer ? 'ArrayBuffer' : e.data instanceof Blob ? 'Blob' : 'string',
            len: e.data.byteLength || e.data.size || String(e.data).length
          }
        });
      });

      ws.addEventListener("close", (e) => {
        trySend({ event: "ws.close", ts: ts(), data: { id: wsId, url, code: e.code, reason: e.reason } });
      });

      ws.addEventListener("error", (e) => {
        trySend({ event: "ws.error", ts: ts(), data: { id: wsId, url, msg: String(e.message) } });
      });

      return ws;
    };
    window.WebSocket.CONNECTING = RealWebSocket.CONNECTING;
    window.WebSocket.OPEN = RealWebSocket.OPEN;
    window.WebSocket.CLOSING = RealWebSocket.CLOSING;
    window.WebSocket.CLOSED = RealWebSocket.CLOSED;
  } catch (e) {
    logError("ws", "WebSocket patch failed", e.message);
  }

  // ─── 2. fetch proxy ─────────────────────────────────────────
  try {
    const origFetch = window.fetch;
    window.fetch = function (...args) {
      const u = args[0];
      const opts = args[1] || {};
      trySend({
        event: "net.fetch",
        ts: ts(),
        data: {
          method: (opts.method || "GET").toUpperCase(),
          url: u instanceof Request ? u.url : String(u)
        }
      });
      return origFetch.apply(this, args);
    };
  } catch (e) {
    logError("fetch", "fetch patch failed", e.message);
  }

  // ─── 3. XHR proxy ───────────────────────────────────────────
  try {
    const OrigXHR = window.XMLHttpRequest;
    window.XMLHttpRequest = function () {
      const xhr = new OrigXHR();
      const origOpen = xhr.open.bind(xhr);
      xhr.open = function (...a) {
        trySend({ event: "net.xhr", ts: ts(), data: { method: a[0], url: String(a[1]) } });
        return origOpen(...a);
      };
      return xhr;
    };
    window.XMLHttpRequest.prototype = OrigXHR.prototype;
  } catch (e) {
    logError("xhr", "XHR patch failed", e.message);
  }

  // ─── 4. WebAssembly proxy ───────────────────────────────────
  try {
    const origInst = WebAssembly.instantiate;
    const origInstStream = WebAssembly.instantiateStreaming;

    WebAssembly.instantiate = function (...args) {
      try {
        const p = origInst(...args);
        p.then(({ instance }) => {
          window.wasm = instance;
          try {
            const exp = instance.exports;
            trySend({ event: "wasm.load", ts: ts(), data: { keys: Object.keys(exp).join(",") } });
            if (exp.memory) {
              trySend({ event: "wasm.mem_info", ts: ts(), data: { byteLength: exp.memory.buffer.byteLength } });
            }
          } catch (e) {
            logError("wasm", "capture failed", e.message);
          }
        }).catch(() => {});
        return p;
      } catch (e) { return origInst(...args); }
    };

    WebAssembly.instantiateStreaming = function (...args) {
      try {
        const p = origInstStream(...args);
        p.then(({ instance }) => {
          window.wasm = instance;
          try {
            const exp = instance.exports;
            trySend({ event: "wasm.load", ts: ts(), data: { keys: Object.keys(exp).join(",") } });
            if (exp.memory) {
              trySend({ event: "wasm.mem_info", ts: ts(), data: { byteLength: exp.memory.buffer.byteLength } });
            }
          } catch (e) {
            logError("wasm", "capture failed", e.message);
          }
        }).catch(() => {});
        return p;
      } catch (e) { return origInstStream(...args); }
    };
  } catch (e) {
    logError("wasm", "WASM patch failed", e.message);
  }

  // ─── 5. Console proxy ───────────────────────────────────────
  try {
    ["log", "info", "warn", "error", "debug"].forEach((lvl) => {
      const orig = console[lvl];
      console[lvl] = function (...a) {
        trySend({ event: "console", ts: ts(), data: { level: lvl, msg: a.map(String).join(" ") } });
        orig.apply(console, a);
      };
    });
  } catch (e) {
    logError("console", "console patch failed", e.message);
  }

  // ─── 6. Error handlers ──────────────────────────────────────
  try {
    window.addEventListener("error", (e) => {
      logError("window", "Uncaught error", e.message);
      trySend({ event: "error", ts: ts(), data: { msg: String(e.message), stack: String(e.error && e.error.stack) } });
    });
    window.addEventListener("unhandledrejection", (e) => {
      logError("window", "Unhandled rejection", e.reason);
      trySend({ event: "rejection", ts: ts(), data: { reason: String(e.reason) } });
    });
  } catch (e) {
    logError("init", "Error handler setup failed", e.message);
  }

  // ─── 7. Boot ────────────────────────────────────────────────
  trySend({ event: "connected", ts: ts(), data: { userAgent: navigator.userAgent, location: location.href } });
  window.__hook.booted = true;

  // Send diagnostic every 5 seconds
  setInterval(sendDiag, 5000);

  // Send heartbeat every 10 seconds
  setInterval(() => trySend({ event: "heartbeat", ts: ts(), data: { sentCount, errorCount: errors.length } }), 10000);

  console.log("[hook] v2 loaded. Bridge: " + BRIDGE);
})();