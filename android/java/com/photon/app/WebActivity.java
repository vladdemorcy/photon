package com.photon.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

/** Photon's own web page, shown inside the app. */
public class WebActivity extends Activity {
    private static final int PICK_FILE = 7;

    // Photon opens Plex sign-in in a new window. A phone has no windows, so window.open hands
    // the address to the phone's browser instead. Photon notices the sign-in by itself.
    private static final String WINDOW_OPEN =
            "(function(){if(window.__photonAndroid)return;window.__photonAndroid=1;"
            + "function go(u){try{u=String(new URL(u,location.href))}catch(e){u=String(u)}"
            + "if(u&&u!=='about:blank')PhotonAndroid.openExternal(u)}"
            + "window.open=function(u){var w={closed:false,close:function(){w.closed=true},focus:function(){},location:{}};"
            + "Object.defineProperty(w.location,'href',{set:go,get:function(){return'about:blank'}});"
            + "w.location.assign=go;w.location.replace=go;if(u)go(u);return w};})();";

    private static final String STARTING_PAGE =
            "<html><head><meta name='viewport' content='width=device-width'>"
            + "<meta http-equiv='refresh' content='2;url=" + Photon.LOCAL_URL + "'></head>"
            + "<body style='background:#04060d;color:#8d96b3;font-family:sans-serif;display:flex;"
            + "align-items:center;justify-content:center;height:90vh;text-align:center'>"
            + "<div><div style='color:#e8ecf8;font-size:20px;margin-bottom:8px'>Waiting for Photon…</div>"
            + "It's starting up. This page will open by itself.</div></body></html>";

    private WebView web;
    private ValueCallback<Uri[]> pendingFiles;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        final FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFF04060D);
        web = new WebView(this);
        web.setBackgroundColor(0xFF04060D);
        root.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        root.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
            @Override
            public WindowInsets onApplyWindowInsets(View v, WindowInsets in) {
                v.setPadding(in.getSystemWindowInsetLeft(), in.getSystemWindowInsetTop(),
                        in.getSystemWindowInsetRight(), in.getSystemWindowInsetBottom());
                return in;
            }
        });
        setContentView(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(true);

        web.addJavascriptInterface(new Bridge(), "PhotonAndroid");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                if (isPhoton(url) || url.startsWith("data:") || url.startsWith("about:")) return false;
                openExternal(url);
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
                view.evaluateJavascript(WINDOW_OPEN, null);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                view.evaluateJavascript(WINDOW_OPEN, null);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) {
                    view.loadDataWithBaseURL(null, STARTING_PAGE, "text/html", "UTF-8", null);
                }
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pendingFiles != null) pendingFiles.onReceiveValue(null);
                pendingFiles = callback;
                try {
                    startActivityForResult(params.createIntent(), PICK_FILE);
                } catch (ActivityNotFoundException e) {
                    pendingFiles = null;
                    return false;
                }
                return true;
            }
        });
        web.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String agent, String disposition, String mime, long length) {
                openExternal(url);
            }
        });

        if (saved != null) web.restoreState(saved);
        else web.loadUrl(Photon.LOCAL_URL);
    }

    private static boolean isPhoton(String url) {
        Uri u = Uri.parse(url);
        String host = u.getHost();
        return host != null && (host.equals("127.0.0.1") || host.equals("localhost"));
    }

    private void openExternal(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "No app on this phone can open " + url, Toast.LENGTH_LONG).show();
        }
    }

    private final class Bridge {
        @JavascriptInterface
        public void openExternal(final String url) {
            runOnUiThread(new Runnable() {
                @Override public void run() { WebActivity.this.openExternal(url); }
            });
        }

        /**
         * Photon's one-time setup code, while it has no password yet. Photon writes it to its
         * private settings folder, which only this app can read, so the person holding the
         * phone is the one who chooses the password. Other devices need the code typed in.
         */
        @JavascriptInterface
        public String setupCode() {
            File data = new File(getFilesDir(), "data");
            if (new File(data, "auth.json").exists()) return "";
            File f = new File(data, "setup-code");
            byte[] buf = new byte[64];
            int n;
            try (FileInputStream in = new FileInputStream(f)) {
                n = in.read(buf);
            } catch (IOException e) {
                return "";
            }
            if (n <= 0) return "";
            String code = new String(buf, 0, n, StandardCharsets.US_ASCII).trim();
            return code.matches("[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}") ? code : "";
        }
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        if (request == PICK_FILE && pendingFiles != null) {
            pendingFiles.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
            pendingFiles = null;
            return;
        }
        super.onActivityResult(request, result, data);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }
}
