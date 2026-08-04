package io.hermes.kiomet;

import android.app.Activity;
import android.os.Bundle;
import android.util.Log;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
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
 * Kiomet Browser — debug shell.
 *
 * Strategy:
 *   Intercept the main page HTML via shouldInterceptRequest.
 *   Download the original HTML, inject hook.js before </head>,
 *   return the modified HTML. This is the ONLY way to ensure
 *   hook.js runs BEFORE the page's own scripts.
 */
public class MainActivity extends Activity {

    private static final String TAG = "KBrowser";
    private static final String TARGET = "https://kiomet.com/";
    private static final String BRIDGE_HOST = "http://127.0.0.1:9998";

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
        configureWebView();
        webView.loadUrl(TARGET);
        Log.i(TAG, "Kiomet shell started. Bridge: " + BRIDGE_HOST);
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

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(android.webkit.ConsoleMessage cm) {
                Log.i(TAG, String.format("[%s] %s", cm.messageLevel().name(), cm.message()));
                return super.onConsoleMessage(cm);
            }
        });

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(
                    WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                // Only intercept the main page
                if (url.equals(TARGET) || url.equals("https://kiomet.com")
                    || url.startsWith("https://kiomet.com/")) {
                    try {
                        return injectHook(url);
                    } catch (Exception e) {
                        Log.e(TAG, "Intercept failed for " + url, e);
                    }
                }
                return null;
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                Log.i(TAG, "Page started: " + url);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                Log.i(TAG, "Page finished: " + url);
            }
        });
    }

    private WebResourceResponse injectHook(String url) throws Exception {
        if (hookJsContent == null) return null;

        // Download original HTML (cached for subsequent loads)
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

        // Inject hook.js before </head>
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
        Log.i(TAG, "Injected hook.js into HTML (" + result.length + " bytes)");

        return new WebResourceResponse(
            "text/html; charset=UTF-8",
            "UTF-8",
            new ByteArrayInputStream(result));
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