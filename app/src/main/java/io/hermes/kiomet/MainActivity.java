package io.hermes.kiomet;

import android.app.Activity;
import android.os.Bundle;
import android.util.Log;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;

/**
 * Kiomet Browser — debug shell for kiomet.com protocol analysis.
 *
 * Strategy:
 *  Load kiomet.com directly, inject hook.js via onPageStarted
 *  BEFORE any page scripts execute. This guarantees WebSocket/fetch/
 *  WebAssembly constructors are patched before kiomet uses them.
 */
public class MainActivity extends Activity {

    private static final String TAG = "KBrowser";
    private static final String TARGET = "https://kiomet.com/";

    private WebView webView;
    private String hookJsContent;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        getWindow().setFlags(
            WindowManager.LayoutParams.FLAG_FULLSCREEN,
            WindowManager.LayoutParams.FLAG_FULLSCREEN);

        // Read hook.js from assets
        hookJsContent = readAsset("hook.js");

        webView = findViewById(R.id.webview);
        configureWebView();
        webView.loadUrl(TARGET);

        Log.i(TAG, "Kiomet shell started. Target: " + TARGET);
    }

    private void configureWebView() {
        WebSettings ws = webView.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setAllowFileAccessFromFileURLs(true);
        ws.setAllowUniversalAccessFromFileURLs(true);
        ws.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        ws.setUseWideViewPort(true);
        ws.setLoadWithOverviewMode(true);
        ws.setCacheMode(WebSettings.LOAD_NO_CACHE);

        // CDP debugging
        WebView.setWebContentsDebuggingEnabled(true);

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage cm) {
                Log.i(TAG, String.format("[%s:%d] %s",
                    cm.sourceId(), cm.lineNumber(), cm.message()));
                return super.onConsoleMessage(cm);
            }
        });

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url,
                                      android.graphics.Bitmap favicon) {
                Log.i(TAG, "Page started: " + url);
                // Inject hook.js BEFORE page scripts execute
                if (hookJsContent != null && url.contains("kiomet.com")) {
                    webView.evaluateJavascript(hookJsContent, null);
                    Log.i(TAG, "hook.js injected via evaluateJavascript");
                }
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                Log.i(TAG, "Page finished: " + url);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request,
                                        WebResourceError error) {
                Log.e(TAG, "Load error: " + error.getDescription());
            }
        });
    }

    private String readAsset(String filename) {
        try {
            InputStream is = getAssets().open(filename);
            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = is.read(buf)) != -1) {
                baos.write(buf, 0, n);
            }
            is.close();
            return baos.toString("UTF-8");
        } catch (Exception e) {
            Log.e(TAG, "Failed to read asset: " + filename, e);
            return null;
        }
    }
}