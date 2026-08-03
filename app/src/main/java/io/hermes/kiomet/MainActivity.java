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
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Kiomet Browser — debug shell for kiomet.com protocol analysis.
 *
 * Uses addJavascriptInterface to expose a Java bridge to JavaScript.
 * The hook.js calls KiometBridge.send() to POST data to the local server.
 * This avoids all CORS issues and is much more reliable than fetch/WebSocket.
 */
public class MainActivity extends Activity {

    private static final String TAG = "KBrowser";
    private static final String TARGET = "https://kiomet.com/";
    private static final String BRIDGE_HOST = "http://127.0.0.1:9998";

    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        getWindow().setFlags(
            WindowManager.LayoutParams.FLAG_FULLSCREEN,
            WindowManager.LayoutParams.FLAG_FULLSCREEN);

        webView = findViewById(R.id.webview);
        configureWebView();

        // Add Java bridge BEFORE page loads
        webView.addJavascriptInterface(new Bridge(), "KiometBridge");

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
            public boolean onConsoleMessage(ConsoleMessage cm) {
                Log.i(TAG, String.format("[%s] %s",
                    cm.messageLevel().name(), cm.message()));
                return super.onConsoleMessage(cm);
            }
        });

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url,
                                      android.graphics.Bitmap favicon) {
                Log.i(TAG, "Page started: " + url);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                Log.i(TAG, "Page finished: " + url);
                // Inject hook.js AFTER page loads (via Java bridge, not fetch)
                String hook = readAsset("hook.js");
                if (hook != null) {
                    view.evaluateJavascript(hook, null);
                    Log.i(TAG, "hook.js injected");
                }
            }
        });
    }

    /**
     * Java bridge exposed to JavaScript as KiometBridge.send(json).
     * Forwards data to the local HTTP server via POST.
     */
    private class Bridge {
        @JavascriptInterface
        public void send(final String json) {
            new Thread(new Runnable() {
                @Override
                public void run() {
                    try {
                        URL url = new URL(BRIDGE_HOST + "/log");
                        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                        conn.setRequestMethod("POST");
                        conn.setRequestProperty("Content-Type", "text/plain");
                        conn.setDoOutput(true);
                        conn.setConnectTimeout(2000);
                        conn.setReadTimeout(2000);
                        OutputStream os = conn.getOutputStream();
                        os.write(json.getBytes("UTF-8"));
                        os.close();
                        int code = conn.getResponseCode();
                        conn.disconnect();
                    } catch (Exception e) {
                        // silently ignore (bridge server might not be running)
                    }
                }
            }).start();
        }
    }

    private String readAsset(String filename) {
        try {
            java.io.InputStream is = getAssets().open(filename);
            java.io.ByteArrayOutputStream baos = new java.io.ByteArrayOutputStream();
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