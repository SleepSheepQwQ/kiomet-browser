package io.hermes.kiomet;

import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.appcompat.app.AppCompatActivity;

/**
 * Kiomet Browser — debug shell for kiomet.com protocol analysis.
 *
 * Strategy:
 *   1. Load a transparent local HTML page first.
 *   2. That page contains the hook.js (captured before any kiomet code).
 *   3. hook.js then navigates to kiomet.com, carrying all patches with it.
 */
public class MainActivity extends AppCompatActivity {

    private static final String TAG = "KBrowser";
    private static final String TARGET_URL = "https://kiomet.com/";

    private WebView webView;
    private final Handler handler = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        getWindow().setFlags(
            WindowManager.LayoutParams.FLAG_FULLSCREEN,
            WindowManager.LayoutParams.FLAG_FULLSCREEN);

        webView = findViewById(R.id.webview);
        configureWebView();
        webView.loadUrl("file:///android_asset/start.html");

        Log.i(TAG, "Kiomet shell started. Target: " + TARGET_URL);
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

        // Enable Chrome DevTools protocol for remote debugging
        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

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
}
