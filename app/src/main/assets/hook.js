/*
 * hook.js — kiomet.com full-coverage interception harness
 *
 * Injected BEFORE kiomet.com executes (via start.html), so every
 * constructor (WebSocket, fetch, XHR) and every WebAssembly init path
 * is already patched by the time kiomet runs.
 *
 * Data pipeline: captured events → WebSocket → Termux server :9999
 *
 * Protocol:
 *   ws://localhost:9999          (bridge handshake)
 *   Messages: JSON objects
 *     { event: "ws.out",  ts, url, body: <hex or array> }
 *     { event: "ws.in",   ts, url, body }
 *     { event: "net.fetch", ts, method, url }
 *     { event: "wasm.load", ts, exports: [...] }
 *     { event: "wasm.dump", ts, data: <hex> }
 *     { event: "console",   ts, level, msg }
 *     { event: "globals",   ts, keys: [...] }
 *     { event: "error",     ts, msg, stack }
 *     { event: "ready",     ts, memory: <hex> }
 *
 * Commands back from server:
 *   { cmd: "memory_dump" }          → respond { event: "memory", data }
 *   { cmd: "wasm_snapshot" }        → respond { event: "wasm", exports }
 *   { cmd: "eval", code: "..." }    → respond { event: "eval_result", value }
 */

(function () {
  if (window.__hook) return;
  window.__hook = { booted: false };

  const HOST = "localhost";
  const PORT = 9999;
  const TARGET = "https://kiomet.com/";

  // ─── helpers ───────────────────────────────────────────────────
  const ts = () => Date.now();
  const bufToHex = (buf) => {
    const u = new Uint8Array(buf);
    let h = "";
    for (let i = 0; i < u.length; i++) {
      h += u[i].toString(16).padStart(2, "0");
    }
    return h;
  };
  const bufToArray = (buf) => Array.from(new Uint8Array(buf));

  // ─── bridge ────────────────────────────────────────────────────
  let bridge = null;
  const send = (obj) => {
    if (bridge && bridge.readyState === WebSocket.OPEN) {
      try { bridge.send(JSON.stringify(obj)); } catch (e) {}
    }
  };

  function connectBridge() {
    try {
      bridge = new WebSocket("ws://" + HOST + ":" + PORT);
      bridge.onopen = () => {
        send({ event: "connected", ts: ts(), userAgent: navigator.userAgent });
        window.__hook.booted = true;
      };
      bridge.onclose = () => {
        // reconnect in 5s
        setTimeout(connectBridge, 5000);
      };
      bridge.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.cmd === "memory_dump") {
            const buf = window.wasm && window.wasm.exports &&
                        window.wasm.exports.memory &&
                        window.wasm.exports.memory.buffer;
            send({
              event: "memory",
              ts: ts(),
              data: buf ? bufToArray(buf) : null,
            });
          } else if (msg.cmd === "wasm_snapshot") {
            if (window.wasm && window.wasm.exports) {
              send({
                event: "wasm",
                ts: ts(),
                exports: Object.keys(window.wasm.exports).join(","),
              });
            }
          } else if (msg.cmd === "eval") {
            try {
              const val = eval(msg.code);
              send({ event: "eval_result", ts: ts(), code: msg.code, value: String(val) });
            } catch (err) {
              send({ event: "eval_result", ts: ts(), code: msg.code, error: String(err) });
            }
          } else if (msg.cmd === "memory_search") {
            // search WASM memory for a hex pattern
            const buf = window.wasm && window.wasm.exports &&
                        window.wasm.exports.memory &&
                        window.wasm.exports.memory.buffer;
            if (buf) {
              const u = new Uint8Array(buf);
              const pattern = msg.pattern.split("").map((c, i) =>
                parseInt(msg.pattern.slice(i * 2, i * 2 + 2), 16));
              const results = [];
              for (let i = 0; i <= u.length - pattern.length; i++) {
                let match = true;
                for (let j = 0; j < pattern.length; j++) {
                  if (u[i + j] !== pattern[j]) { match = false; break; }
                }
                if (match) results.push(i);
                if (results.length >= 50) break;
              }
              send({ event: "memory_search", ts: ts(), pattern: msg.pattern, results });
            }
          }
        } catch (e) {}
      };
    } catch (e) {
      // silently fail if bridge not reachable
    }
  }

  // ─── 1. WebSocket proxy (frame-level capture) ─────────────────
  const RealWebSocket = WebSocket;
  const wsMap = new Map(); // ws -> { url, id }

  function wrapWebSocket(url, protocols) {
    const wsId = "ws_" + Math.random().toString(36).slice(2, 8);

    send({ event: "ws.create", ts: ts(), url, protocols });

    const ws = new RealWebSocket(url, protocols);
    wsMap.set(ws, { url, id: wsId });

    const origSend = ws.send.bind(ws);
    ws.send = function (data) {
      const item = {
        event: "ws.out",
        ts: ts(),
        id: wsId,
        url: url,
      };
      if (data instanceof ArrayBuffer) {
        item.body = bufToHex(data);
        item.len = data.byteLength;
      } else if (data instanceof Blob) {
        item.body = "BLOB[" + data.size + "]";
        item.len = data.size;
      } else {
        item.body = String(data);
      }
      send(item);
      return origSend(data);
    };

    ws.addEventListener("message", (e) => {
      const item = {
        event: "ws.in",
        ts: ts(),
        id: wsId,
        url: url,
      };
      if (e.data instanceof ArrayBuffer) {
        item.body = bufToHex(e.data);
        item.len = e.data.byteLength;
      } else if (e.data instanceof Blob) {
        item.body = "BLOB[" + e.data.size + "]";
        item.len = e.data.size;
      } else {
        item.body = String(e.data);
      }
      send(item);
    });

    ws.addEventListener("close", (e) => {
      send({ event: "ws.close", ts: ts(), id: wsId, code: e.code, reason: e.reason });
    });

    ws.addEventListener("error", (e) => {
      send({ event: "ws.error", ts: ts(), id: wsId, msg: String(e.message) });
    });

    return ws;
  }

  // Replace WebSocket globally BEFORE anything else
  window.WebSocket = function (...args) {
    return wrapWebSocket(args[0], args[1]);
  };
  // copy constants
  WebSocket.CONNECTING = RealWebSocket.CONNECTING;
  WebSocket.OPEN       = RealWebSocket.OPEN;
  WebSocket.CLOSING    = RealWebSocket.CLOSING;
  WebSocket.CLOSED     = RealWebSocket.CLOSED;

  // ─── 2. fetch interceptor ────────────────────────────────────
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const u = args[0];
    const opts = args[1] || {};
    send({
      event: "net.fetch",
      ts: ts(),
      method: (opts.method || "GET").toUpperCase(),
      url: u instanceof Request ? u.url : String(u),
      headers: opts.headers ? Object.keys(opts.headers).join(",") : "",
    });
    const p = origFetch.apply(this, args);
    if (p && p.then) {
      p.then((resp) => {
        // capture response headers
        send({
          event: "net.fetch_resp",
          ts: ts(),
          url: u instanceof Request ? u.url : String(u),
          status: resp.status,
          headers: Object.fromEntries(resp.headers.entries()),
        });
      }).catch(() => {});
    }
    return p;
  };

  // ─── 3. XHR interceptor ──────────────────────────────────────
  const OrigXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function () {
    const xhr = new OrigXHR();
    const origOpen = xhr.open.bind(xhr);
    xhr.open = function (...a) {
      send({ event: "net.xhr", ts: ts(), method: a[0], url: String(a[1]) });
      return origOpen(...a);
    };
    return xhr;
  };
  window.XMLHttpRequest.prototype = OrigXHR.prototype;

  // ─── 4. WebAssembly capture ──────────────────────────────────
  function captureWasm(wasm) {
    const exp = wasm.exports;
    const keys = Object.keys(exp).filter(k => typeof exp[k] === "function" || typeof exp[k] === "object");
    send({ event: "wasm.load", ts: ts(), keys: keys.join(",") });

    if (exp.memory) {
      try {
        const mem = exp.memory.buffer;
        send({
          event: "wasm.mem_info",
          ts: ts(),
          byteLength: mem.byteLength,
        });
        // dump first 256 KB to start
        const chunk = mem.slice(0, Math.min(mem.byteLength, 262144));
        send({
          event: "wasm.mem_dump",
          ts: ts(),
          offset: 0,
          len: chunk.byteLength,
          data: bufToHex(chunk),
        });
      } catch (e) {
        send({ event: "wasm.err", ts: ts(), msg: "memory read failed: " + e });
      }
    }

    // watch memory growth
    let pages = exp.memory ? exp.memory.buffer.byteLength : 0;
    new MutationObserver(() => { /* fallback watcher via interval */ });
    setInterval(() => {
      if (exp.memory && exp.memory.buffer.byteLength !== pages) {
        pages = exp.memory.buffer.byteLength;
        send({ event: "wasm.mem_grow", ts: ts(), byteLength: pages });
      }
    }, 1000);
  }

  // patch WebAssembly.instantiate
  const origInstantiate = WebAssembly.instantiate;
  WebAssembly.instantiate = function (...args) {
    const p = origInstantiate.apply(this, args);
    p.then(({ instance, module }) => {
      window.wasm = instance;
      captureWasm(instance);
    }).catch(() => {});
    return p;
  };

  const origInstantiateStreaming = WebAssembly.instantiateStreaming;
  WebAssembly.instantiateStreaming = function (...args) {
    const p = origInstantiateStreaming.apply(this, args);
    p.then(({ instance, module }) => {
      window.wasm = instance;
      captureWasm(instance);
    }).catch(() => {});
    return p;
  };

  // ─── 5. console capture ──────────────────────────────────────
  ["log", "info", "warn", "error", "debug"].forEach((lvl) => {
    const orig = console[lvl];
    console[lvl] = function (...a) {
      send({ event: "console", ts: ts(), level: lvl, msg: a.map(String).join(" ") });
      orig.apply(console, a);
    };
  });

  // ─── 6. global variable watcher ──────────────────────────────
  const known = new Set(Object.keys(window));
  setInterval(() => {
    const newKeys = Object.keys(window).filter(k => !known.has(k));
    if (newKeys.length > 0) {
      send({ event: "globals", ts: ts(), keys: newKeys });
      newKeys.forEach(k => known.add(k));
    }
  }, 2000);

  // ─── 7. error / rejection capture ────────────────────────────
  window.addEventListener("error", (e) => {
    send({ event: "error", ts: ts(), msg: String(e.message), stack: String(e.error && e.error.stack) });
  });
  window.addEventListener("unhandledrejection", (e) => {
    send({ event: "rejection", ts: ts(), reason: String(e.reason) });
  });

  // ─── 8. boot ─────────────────────────────────────────────────
  console.log("[hook] loaded. Connecting to bridge...");
  connectBridge();
})();
