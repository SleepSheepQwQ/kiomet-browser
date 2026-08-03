package io.hermes.kiomet;

import android.app.Activity;
import android.os.Bundle;
import android.util.Log;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * Kiomet Browser — debug shell.
 *
 * Injects hook.js into the kiomet.com main page HTML response via
 * shouldInterceptRequest. Guarantees the hook runs before any page script.
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

        webView = findViewById(R.id.webview);
        hookJsContent = readAsset("hook.js");
        configureWebView();
        webView.loadUrl(TARGET);
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
            public WebResourceResponse shouldInterceptRequest(
                    WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                // Only intercept the main page HTML
                if (url.equals(TARGET) || url.equals(TARGET.replace("/", ""))
                    || url.startsWith(TARGET + "?")) {
                    try {
                        return injectHook(request.getUrl().toString());
                    } catch (Exception e) {
                        Log.e(TAG, "intercept failed", e);
                    }
                }
                return super.shouldInterceptRequest(view, request);
            }

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

    private WebResourceResponse injectHook(String url) throws Exception {
        if (hookJsContent == null) return null;

        java.net.URL targetUrl = new java.net.URL(url);
        java.net.HttpURLConnection conn =
            (java.net.HttpURLConnection) targetUrl.openConnection();
        conn.setRequestProperty("User-Agent",
            "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36");
        conn.setInstanceFollowRedirects(true);
        conn.connect();

        int code = conn.getResponseCode();
        String contentType = conn.getContentType();
        if (contentType == null) contentType = "text/html; charset=UTF-8";

        // Read the original HTML
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        InputStream is = conn.getInputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = is.read(buf)) != -1) baos.write(buf, 0, n);
        is.close();
        conn.disconnect();

        String original = baos.toString("UTF-8");

        // Inject hook.js before </head> or before </body> or after <html>
        String hookTag = "<script>" + hookJsContent + "</script>";
        String modified;
        if (original.contains("</head>")) {
            modified = original.replace("</head>", hookTag + "</head>");
        } else if (original.contains("</body>")) {
            modified = original.replace("</body>", hookTag + "</body>");
        } else if (original.contains("<html")) {
            // Inject after opening <html> tag
            int idx = original.indexOf(">") + 1;
            modified = original.substring(0, idx) + hookTag + original.substring(idx);
        } else {
            modified = hookTag + original;
        }

        Log.i(TAG, "Injected hook.js into " + url + " (" + modified.length() + " bytes)");

        byte[] result = modified.getBytes(StandardCharsets.UTF_8);
        return new WebResourceResponse(
            contentType,
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