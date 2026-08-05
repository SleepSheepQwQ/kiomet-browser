package io.hermes.kiomet;

import android.app.Activity;
import android.os.Bundle;
import android.util.Log;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;

/**
 * Kiomet Browser — WebView shell with hook.js injection + WebSocket bridge.
 *
 * Captures Kiomet traffic and pipes data to a local bridge server on :9996.
 * A background WebSocket connects to the bridge; the bridge can push commands
 * (eval / memory_dump / wasm_snapshot / memory_search / window_dump) which
 * are dispatched into hook.js via evaluateJavascript().
 */
public class MainActivity extends Activity {

    private static final String TAG = "KBrowser";
    private static final String TARGET = "https://kiomet.com/";
    private static final String BRIDGE = "http://127.0.0.1:9996/log";
    private static final int BRIDGE_PORT = 9996;
    private static final int WS_CONNECT_MS = 3000;

    private WebView webView;
    private String hookJsContent;
    private byte[] cachedHtml;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        getWindow().setFlags(
            WindowManager.LayoutParams.FLAG_FULLSCREEN,
            WindowManager.LayoutParams.FLAG_FULLSCREEN);

        webView = findViewById(R.id.webview);
        hookJsContent = readAsset("hook.js");

        webView.addJavascriptInterface(new Bridge(), "KiometBridge");
        configureWebView();
        webView.loadUrl(TARGET);
        Log.i(TAG, "Kiomet shell started. Bridge: " + BRIDGE);

        startWebSocketBridge();
    }

    // ─── WebView config ─────────────────────────────────────────
    private void configureWebView() {
        WebSettings ws = webView.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        ws.setUseWideViewPort(true);
        ws.setLoadWithOverviewMode(true);
        ws.setCacheMode(WebSettings.LOAD_NO_CACHE);
        WebView.setWebContentsDebuggingEnabled(true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(
                    WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (url.contains("kiomet.com")) {
                    try {
                        return injectHook(url);
                    } catch (Exception e) {
                        Log.e(TAG, "Intercept failed", e);
                    }
                }
                return null;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                Log.i(TAG, "Page finished: " + url);
            }
        });
    }

    // ─── Hook injection (intercepts kiomet.com HTML) ────────────
    private WebResourceResponse injectHook(String url) throws Exception {
        if (hookJsContent == null) return null;

        byte[] html;
        if (cachedHtml != null) {
            html = cachedHtml;
        } else {
            URL targetUrl = new URL(url);
            HttpURLConnection conn =
                (HttpURLConnection) targetUrl.openConnection();
            conn.setRequestProperty("User-Agent",
                "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36");
            conn.setInstanceFollowRedirects(true);
            conn.setConnectTimeout(5000);
            conn.setReadTimeout(5000);
            conn.connect();

            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            InputStream is = conn.getInputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = is.read(buf)) != -1) baos.write(buf, 0, n);
            is.close();
            conn.disconnect();
            html = baos.toByteArray();
            cachedHtml = html;
            Log.i(TAG, "Downloaded HTML: " + html.length + " bytes");
        }

        String original = new String(html, StandardCharsets.UTF_8);
        String hookTag = "<script>" + hookJsContent + "</script>";

        String modified;
        if (original.contains("</head>")) {
            modified = original.replace("</head>", hookTag + "</head>");
        } else if (original.contains("</body>")) {
            modified = original.replace("</body>", hookTag + "</body>");
        } else {
            modified = hookTag + original;
        }

        byte[] result = modified.getBytes(StandardCharsets.UTF_8);
        Log.i(TAG, "Injected hook.js (" + result.length + " bytes)");
        return new WebResourceResponse(
            "text/html; charset=UTF-8", "UTF-8",
            new ByteArrayInputStream(result));
    }

    // ─── WebSocket bridge (plain TCP, no external deps) ─────────
    private void startWebSocketBridge() {
        new Thread(() -> {
            Log.i(TAG, "Opening WebSocket to ws://127.0.0.1:" + BRIDGE_PORT);
            while (!isFinishing()) {
                Socket socket = null;
                try {
                    socket = new Socket();
                    socket.connect(new InetSocketAddress("127.0.0.1", BRIDGE_PORT),
                                   WS_CONNECT_MS);

                    String handshake =
                        "GET /?client=kiomet HTTP/1.1\r\n" +
                        "Host: 127.0.0.1:" + BRIDGE_PORT + "\r\n" +
                        "Upgrade: websocket\r\n" +
                        "Connection: Upgrade\r\n" +
                        "Sec-WebSocket-Key: rish-hook-key\r\n" +
                        "Sec-WebSocket-Version: 13\r\n" +
                        "Sec-WebSocket-Protocol: hook-v1\r\n" +
                        "\r\n";
                    socket.getOutputStream().write(handshake.getBytes(StandardCharsets.UTF_8));
                    socket.getOutputStream().flush();

                    // Drain server's 101 response until CRLF CRLF
                    int b;
                    while ((b = socket.getInputStream().read()) != -1 && b != '\r') {
                        if (b == '\n') {
                            int nxt = socket.getInputStream().read();
                            if (nxt != '\r') break;
                        }
                    }

                    Log.i(TAG, "WebSocket connected to bridge");
                    receiveLoop(socket);
                    socket.close();
                    Log.i(TAG, "WebSocket disconnected");
                } catch (java.net.ConnectException e) {
                    Log.w(TAG, "WebSocket connect refused (bridge not running)");
                } catch (Exception e) {
                    Log.e(TAG, "WebSocket error", e);
                } finally {
                    try { socket.close(); } catch (Exception ignored) {}
                }
                try { Thread.sleep(2000); } catch (InterruptedException e) { break; }
            }
        }).start();
    }

    // ─── Inbound command receiver ───────────────────────────────
    private void receiveLoop(Socket socket) throws Exception {
        byte[] buf = new byte[4096];
        int len;
        while ((len = socket.getInputStream().read(buf)) != -1) {
            String frame = new String(buf, 0, len, StandardCharsets.UTF_8).trim();
            if (frame.length() < 2 || frame.charAt(0) != ':') continue;

            String json = frame.substring(1);
            Log.d(TAG, "WS-IN: " + json.substring(0, Math.min(100, json.length())));

            String cmd = extractJsonString(json, "cmd");
            if (cmd != null) {
                String payload = extractJsonString(json, "payload");
                String requestId = extractJsonString(json, "requestId");
                Log.i(TAG, "CMD: " + cmd);

                webView.post(() -> {
                    String escapedCmd = escapeJs(cmd);
                    String escapedPayload = payload != null ? escapeJs(payload) : "null";
                    String escapedId = requestId != null ? escapeJs(requestId) : "null";
                    webView.evaluateJavascript(
                        "window.__hook && window.__hook.handleCommand(" +
                        "'" + escapedCmd + "', " + escapedPayload + ", " + escapedId +
                        ");", null);
                });
            }
        }
    }

    // Minimal JSON key-value extractor (safe for our wire format)
    private String extractJsonString(String json, String key) {
        String pat = "\"" + key + "\"";
        int i = json.indexOf(pat);
        if (i < 0) return null;
        int colon = json.indexOf(':', i + pat.length());
        if (colon < 0) return null;
        int start = json.indexOf('"', colon + 1);
        if (start < 0) return null;
        int end = json.indexOf('"', start + 1);
        if (end < 0) return null;
        return json.substring(start + 1, end);
    }

    private String escapeJs(String s) {
        return s.replace("\\", "\\\\").replace("'", "\\'")
                .replace("\n", "\\n").replace("\r", "\\r");
    }

    // ─── Asset loader ───────────────────────────────────────────
    private String readAsset(String filename) {
        try {
            InputStream is = getAssets().open(filename);
            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = is.read(buf)) != -1) baos.write(buf, 0, n);
            is.close();
            return baos.toString("UTF-8");
        } catch (Exception e) {
            Log.e(TAG, "Failed to read asset: " + filename, e);
            return null;
        }
    }

    // ─── Java bridge (KiometBridge.send / .command) ─────────────
    private class Bridge {
        @JavascriptInterface
        public void send(final String json) {
            new Thread(() -> {
                try {
                    URL url = new URL(BRIDGE);
                    HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                    conn.setRequestMethod("POST");
                    conn.setRequestProperty("Content-Type", "text/plain");
                    conn.setDoOutput(true);
                    conn.setConnectTimeout(2000);
                    conn.setReadTimeout(2000);
                    OutputStream os = conn.getOutputStream();
                    os.write(json.getBytes("UTF-8"));
                    os.close();
                    conn.getResponseCode();
                    conn.disconnect();
                } catch (Exception ignored) {}
            }).start();
        }

        @JavascriptInterface
        public void command(final String json) {
            new Thread(() -> {
                try {
                    URL url = new URL(BRIDGE);
                    HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                    conn.setRequestMethod("POST");
                    conn.setRequestProperty("Content-Type", "application/json");
                    conn.setDoOutput(true);
                    conn.setConnectTimeout(2000);
                    conn.setReadTimeout(2000);
                    OutputStream os = conn.getOutputStream();
                    os.write(json.getBytes("UTF-8"));
                    os.close();
                    conn.getResponseCode();
                    conn.disconnect();
                } catch (Exception ignored) {}
            }).start();
        }
    }
}
