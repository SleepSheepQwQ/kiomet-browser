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
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;

/**
 * Kiomet Browser — shouldInterceptRequest + addJavascriptInterface + WebSocket bridge.
 *
 * Captures Kiomet traffic and pipes data to a local bridge server.  A background
 * WebSocket to the bridge carries hook.js events (outbound) and remote commands
 * (inbound, from the bridge).
 */
public class MainActivity extends Activity {

    private static final String TAG = "KBrowser";
    private static final String TARGET = "https://kiomet.com/";
    private static final String BRIDGE = "http://127.0.0.1:9996/log";
    private static final String WS_URL = "ws://127.0.0.1:9996/?client=kiomet";
    private static final long WS_CONNECT_MS = 3000;

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

        // Register Java bridge BEFORE page load
        webView.addJavascriptInterface(new Bridge(), "KiometBridge");

        configureWebView();
        webView.loadUrl(TARGET);
        Log.i(TAG, "Kiomet shell started. Bridge: " + BRIDGE);

        // Start bidirectional WebSocket to the bridge
        startWebSocketBridge();
    }

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

    private WebResourceResponse injectHook(String url) throws Exception {
        if (hookJsContent == null) return null;

        byte[] html;
        if (cachedHtml != null) {
            html = cachedHtml;
        } else {
            java.net.URL targetUrl = new java.net.URL(url);
            java.net.HttpURLConnection conn =
                (java.net.HttpURLConnection) targetUrl.openConnection();
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

        String original = new String(html, StandardCharsets.UTF-8);
        String hookTag = "<script>" + hookJsContent + "</script>";

        String modified;
        if (original.contains("</head>")) {
            modified = original.replace("</head>", hookTag + "</head>");
        } else if (original.contains("</body>")) {
            modified = original.replace("</body>", hookTag + "</body>");
        } else {
            modified = hookTag + original;
        }

        byte[] result = modified.getBytes(StandardCharsets.UTF-8);
        Log.i(TAG, "Injected hook.js (" + result.length + " bytes)");
        return new WebResourceResponse(
            "text/html; charset=UTF-8", "UTF-8",
            new ByteArrayInputStream(result));
    }

    // ─── WebSocket bridge (plain TCP, no external deps) ──────────
    private void startWebSocketBridge() {
        new Thread(() -> {
            Log.i(TAG, "Opening WebSocket to " + WS_URL);
            while (!isFinishing()) {
                Socket socket = null;
                try {
                    socket = new Socket();
                    socket.connect(new InetSocketAddress("127.0.0.1", 9996),
                                   (int) WS_CONNECT_MS);
                    String handshake =
                        "GET /?client=kiomet HTTP/1.1\r\n" +
                        "Host: 127.0.0.1:9996\r\n" +
                        "Upgrade: websocket\r\n" +
                        "Connection: Upgrade\r\n" +
                        "Sec-WebSocket-Key: rish-hook-key\r\n" +
                        "Sec-WebSocket-Version: 13\r\n" +
                        "Sec-WebSocket-Protocol: hook-v1\r\n" +
                        "\r\n";
                    socket.getOutputStream().write(handshake.getBytes());
                    socket.getOutputStream().flush();

                    // Consume server's 101 response until \r\n\r\n
                    int b;
                    while ((b = socket.getInputStream().read()) != -1 && b != '\r') {}

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

                // Backoff
                try { Thread.sleep(2000); } catch (InterruptedException _) { break; }
            }
        }).start();
    }

    private void receiveLoop(Socket socket) throws Exception {
        byte[] buf = new byte[4096];
        int len;
        while ((len = socket.getInputStream().read(buf)) != -1) {
            // Wire framing: line starts with ':' followed by JSON
            String frame = new String(buf, 0, len, StandardCharsets.UTF_8).trim();
            if (frame.isEmpty()) continue;

            // Diagnostics
            Log.d(TAG, "WS-IN: " + frame);

            if (frame.length() < 2 || frame.charAt(0) != ':') continue;
            String json = frame.substring(1);

            try {
                // Minimal JSON parse — look for "cmd" key
                String cmd = extractJsonString(json, "cmd");
                String payload = extractJsonString(json, "payload");
                String requestId = extractJsonString(json, "requestId");

                if (cmd != null) {
                    Log.i(TAG, "CMD: " + cmd + "  payload=" + (payload != null ? payload : "null"));
                    webView.post(() -> {
                        webView.evaluateJavascript(
                            "window.__hook && window.__hook.handleCommand(" +
                            "'" + escapeJs(cmd) + "', " +
                            (payload != null ? "'" + escapeJs(payload) + "'" : "null") +
                            ", " +
                            (requestId != null ? "'" + escapeJs(requestId) + "'" : "null") +
                            ");",
                            null);
                    });
                }
            } catch (Exception e) {
                Log.d(TAG, "WS-IN not a command (non-cmd event): " + json.slice(0, 100));
            }
        }
    }

    // Very minimal JSON key-value extractor — safe enough for our wire format
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
        return s.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n");
    }

    /**
     * Java bridge — KiometBridge.send() / KiometBridge.command() callable from JS.
     */
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
    }
}
