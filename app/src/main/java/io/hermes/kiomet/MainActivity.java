package io.hermes.kiomet;

import android.app.Activity;
import android.os.Bundle;
import android.util.Log;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Kiomet Browser — debug shell for kiomet.com protocol analysis.
 *
 * Uses addJavascriptInterface to expose a Java bridge to JavaScript.
 * The hook.js calls KiometBridge.send() to POST data to the local server.
 * No CORS issues, no network interception, game loads normally.
 */
public class MainActivity extends Activity {

    private static final String TAG = "KBrowser";
    private static final String TARGET = "https://kiomet.com/";
    private static final String BRIDGE = "http://127.0.0.1:9998/log";

    private WebView webView;
    private Bridge bridge;
    private String hookJsContent;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        getWindow().setFlags(
            WindowManager.LayoutParams.FLAG_FULLSCREEN,
            WindowManager.LayoutParams.FLAG_FULLSCREEN);

        webView = findViewById(R.id.webview);
        bridge = new Bridge();
        hookJsContent = readAsset("hook.js");

        // Register bridge BEFORE page load (persists across navigations)
        webView.addJavascriptInterface(bridge, "KiometBridge");
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

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage cm) {
                Log.i(TAG, String.format("[%s] %s", cm.messageLevel().name(), cm.message()));
                return super.onConsoleMessage(cm);
            }
        });

        webView.setWebViewClient(new WebViewClient() {
            private boolean injected = false;

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                Log.i(TAG, "Page started: " + url);
                // Re-register bridge on each page load
                webView.addJavascriptInterface(bridge, "KiometBridge");
                injected = false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                Log.i(TAG, "Page finished: " + url);
                if (!injected && url.contains("kiomet.com")) {
                    injected = true;

                    // Step 1: Test KiometBridge availability
                    view.evaluateJavascript(
                        "try{console.log('KB_TEST: KiometBridge=' + (typeof KiometBridge));" +
                        "if(typeof KiometBridge!=='undefined'){KiometBridge.send('KB_TEST:bridge_ok');}" +
                        "}catch(e){console.log('KB_TEST error:' + e.message)}",
                        null
                    );
                    Log.i(TAG, "KiometBridge test injected");

                    // Step 2: Inject the full hook.js
                    if (hookJsContent != null) {
                        view.evaluateJavascript(hookJsContent, null);
                        Log.i(TAG, "hook.js injected via evaluateJavascript (" + hookJsContent.length() + " bytes)");
                    }
                }
            }
        });
    }

    /**
     * Java bridge exposed to JavaScript as KiometBridge.send(json).
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