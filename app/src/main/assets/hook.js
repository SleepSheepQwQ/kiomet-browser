/*
 * hook.js — kiomet.com interception harness
 *
 * Uses KiometBridge.send() (Java @JavascriptInterface) to POST data
 * to the local bridge server. No CORS, no fetch, no WebSocket needed.
 */

(function () {
  if (window.__hook) return;
  window.__hook = { booted: false };

  const ts = () => Date.now();

  // Save originals BEFORE patching — send() must use these, not patched versions
  const origFetchX = window.fetch;

  function send(event, data) {
      try {
        const body = JSON.stringify({ event, ts: ts(), data: data || {} });
        // Try Java bridge first (no CORS, no network restrictions)
        if (window.KiometBridge) {
          window.KiometBridge.send(body);
        } else {
          // Use ORIGINAL fetch, not the patched one (would cause recursion)
          origFetchX("http://127.0.0.1:9997/log", {
            method: "POST",
            headers: { "Content-Type": "text/plain" },
            body: body,
            keepalive: true,
          }).catch(() => {});
        }
      } catch (e) { /* silently ignore */ }
    }

  // ─── heartbeat ─────────────────────────────────────────────────
  setInterval(() => send("heartbeat", {}), 10000);

  // ─── 1. WebSocket proxy (frame-level capture) ─────────────────
  const RealWebSocket = WebSocket;
  const wsMap = new Map();

  function wrapWebSocket(url, protocols) {
    const wsId = "ws_" + Math.random().toString(36).slice(2, 8);
    send("ws.create", { url, protocols, id: wsId });

    const ws = new RealWebSocket(url, protocols);
    wsMap.set(ws, { url, id: wsId });

    const origSend = ws.send.bind(ws);
    ws.send = function (data) {
      let body, len = 0;
      if (data instanceof ArrayBuffer) {
        body = Array.from(new Uint8Array(data));
        len = data.byteLength;
      } else if (data instanceof Blob) {
        body = "BLOB[" + data.size + "]";
        len = data.size;
      } else {
        body = String(data);
      }
      send("ws.out", { id: wsId, url, body, len });
      return origSend(data);
    };

    ws.addEventListener("message", (e) => {
      let body, len = 0;
      if (e.data instanceof ArrayBuffer) {
        body = Array.from(new Uint8Array(e.data));
        len = e.data.byteLength;
      } else if (e.data instanceof Blob) {
        body = "BLOB[" + e.data.size + "]";
        len = e.data.size;
      } else {
        body = String(e.data);
      }
      send("ws.in", { id: wsId, url, body, len });
    });

    ws.addEventListener("close", (e) => {
      send("ws.close", { id: wsId, url, code: e.code, reason: e.reason });
    });
    ws.addEventListener("error", (e) => {
      send("ws.error", { id: wsId, url, msg: String(e.message) });
    });

    return ws;
  }

  window.WebSocket = function (...args) {
    return wrapWebSocket(args[0], args[1]);
  };
  WebSocket.CONNECTING = RealWebSocket.CONNECTING;
  WebSocket.OPEN       = RealWebSocket.OPEN;
  WebSocket.CLOSING    = RealWebSocket.CLOSING;
  WebSocket.CLOSED     = RealWebSocket.CLOSED;

  // ─── 2. fetch + XHR interceptor ───────────────────────────────
  window.fetch = function (...args) {
    const u = args[0];
    const opts = args[1] || {};
    send("net.fetch", {
      method: (opts.method || "GET").toUpperCase(),
      url: u instanceof Request ? u.url : String(u),
    });
    return origFetchX.apply(this, args);
  };

  const OrigXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function () {
    const xhr = new OrigXHR();
    const origOpen = xhr.open.bind(xhr);
    xhr.open = function (...a) {
      send("net.xhr", { method: a[0], url: String(a[1]) });
      return origOpen(...a);
    };
    return xhr;
  };
  window.XMLHttpRequest.prototype = OrigXHR.prototype;

  // ─── 3. WebAssembly capture ──────────────────────────────────
  function captureWasm(wasm) {
    const exp = wasm.exports;
    const keys = Object.keys(exp).filter(
      k => typeof exp[k] === "function" || typeof exp[k] === "object"
    );
    send("wasm.load", { keys: keys.join(",") });

    if (exp.memory) {
      try {
        const mem = exp.memory.buffer;
        send("wasm.mem_info", { byteLength: mem.byteLength });
        const chunk = mem.slice(0, Math.min(mem.byteLength, 262144));
        send("wasm.mem_dump", {
          offset: 0, len: chunk.byteLength,
          data: Array.from(new Uint8Array(chunk)),
        });
      } catch (e) {
        send("wasm.err", { msg: "memory read failed: " + e });
      }
    }

    let pages = exp.memory ? exp.memory.buffer.byteLength : 0;
    setInterval(() => {
      if (exp.memory && exp.memory.buffer.byteLength !== pages) {
        pages = exp.memory.buffer.byteLength;
        send("wasm.mem_grow", { byteLength: pages });
      }
    }, 1000);
  }

  const origInst = WebAssembly.instantiate;
  const origInstStreaming = WebAssembly.instantiateStreaming;

  WebAssembly.instantiate = function (...args) {
    try {
      const p = origInst(...args);
      p.then(({ instance }) => { window.wasm = instance; captureWasm(instance); }).catch(() => {});
      return p;
    } catch (e) { return origInst(...args); }
  };
  WebAssembly.instantiateStreaming = function (...args) {
    try {
      const p = origInstStreaming(...args);
      p.then(({ instance }) => { window.wasm = instance; captureWasm(instance); }).catch(() => {});
      return p;
    } catch (e) { return origInstStreaming(...args); }
  };

  // ─── 4. console capture ──────────────────────────────────────
  ["log", "info", "warn", "error", "debug"].forEach((lvl) => {
    const orig = console[lvl];
    console[lvl] = function (...a) {
      send("console", { level: lvl, msg: a.map(String).join(" ") });
      orig.apply(console, a);
    };
  });

  // ─── 5. boot ─────────────────────────────────────────────────
  send("connected", { userAgent: navigator.userAgent });
  window.__hook.booted = true;

})();