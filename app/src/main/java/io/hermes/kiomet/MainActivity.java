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
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Kiomet Browser — shouldInterceptRequest + addJavascriptInterface.
 * Injects hook.js into HTML, also provides KiometBridge.send().
 */
public class MainActivity extends Activity {

    private static final String TAG = "KBrowser";
    private static final String TARGET = "https://kiomet.com/";
    private static final String BRIDGE = "http://127.0.0.1:9996/log";

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
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                Log.i(TAG, "Page started: " + url);
                // Re-register bridge on each page load
                webView.addJavascriptInterface(new Bridge(), "KiometBridge");
                // Inject a test immediately
                view.evaluateJavascript(
                    "console.log('INJECTED');" +
                    "if(typeof KiometBridge!=='undefined'){KiometBridge.send('INJECTED_OK');}",
                    null
                );
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

    /**
     * Java bridge — KiometBridge.send() is callable from JavaScript.
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
}