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

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

/** Photon's own web page, shown inside the app. */
public class WebActivity extends Activity {
    private static final int PICK_FILE = 7;
    private static final int SAVE_FILE = 8;
    private String pendingSave;
    private int pendingSaveReq;

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
                // The padding already keeps the page clear of the bars. Used up here, so the web
                // page doesn't also get them as safe-area space and leave the room twice.
                return in.consumeSystemWindowInsets();
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

    private void onPhotonPage(final Runnable r) {
        runOnUiThread(new Runnable() {
            @Override public void run() {
                String url = web.getUrl();
                if (url != null && isPhoton(url)) r.run();
            }
        });
    }

    private Biometric.Result reply(final int req) {
        return new Biometric.Result() {
            @Override public void done(JSONObject r) {
                try { r.put("req", req); } catch (JSONException ignored) { }
                web.evaluateJavascript("window.__photonBiometric&&window.__photonBiometric(" + r.toString() + ")", null);
            }
        };
    }

    private final class Bridge {
        @JavascriptInterface
        public void openExternal(final String url) {
            runOnUiThread(new Runnable() {
                @Override public void run() { WebActivity.this.openExternal(url); }
            });
        }

        // ---- Fingerprint or face sign-in (see Biometric.java) ----------------------------
        // Results go back to the page through window.__photonBiometric. Each call first checks,
        // on the main thread, that the page asking is Photon's own.

        /**
         * Saves text the page made (the settings download) to a file the person picks, since a
         * web view can't download files by itself. Android's own "save to" screen asks where.
         */
        @JavascriptInterface
        public void saveFile(final int req, final String name, final String text) {
            onPhotonPage(new Runnable() {
                @Override public void run() {
                    pendingSave = text;
                    pendingSaveReq = req;
                    Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT)
                            .addCategory(Intent.CATEGORY_OPENABLE)
                            .setType("application/json")
                            .putExtra(Intent.EXTRA_TITLE, name);
                    try {
                        startActivityForResult(i, SAVE_FILE);
                    } catch (ActivityNotFoundException e) {
                        pendingSave = null;
                        replyJs(req, "{\"ok\":false,\"error\":\"This phone has no app for saving files.\"}");
                    }
                }
            });
        }

        @JavascriptInterface
        public String biometricStatus() {
            return Biometric.status(WebActivity.this).toString();
        }

        @JavascriptInterface
        public void biometricEnable(final int req, final String id, final String token) {
            onPhotonPage(new Runnable() {
                @Override public void run() { Biometric.enable(WebActivity.this, id, token, reply(req)); }
            });
        }

        @JavascriptInterface
        public void biometricUnlock(final int req) {
            onPhotonPage(new Runnable() {
                @Override public void run() { Biometric.unlock(WebActivity.this, reply(req)); }
            });
        }

        @JavascriptInterface
        public void biometricDisable(final int req) {
            onPhotonPage(new Runnable() {
                @Override public void run() { Biometric.disable(WebActivity.this); reply(req).done(new JSONObject()); }
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

    private void replyJs(int req, String json) {
        web.evaluateJavascript("window.__photonSaved&&window.__photonSaved(" + req + "," + json + ")", null);
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        if (request == SAVE_FILE) {
            String text = pendingSave;
            pendingSave = null;
            if (result != RESULT_OK || data == null || data.getData() == null || text == null) {
                replyJs(pendingSaveReq, "{\"ok\":false,\"canceled\":true}");
                return;
            }
            try (java.io.OutputStream out = getContentResolver().openOutputStream(data.getData())) {
                out.write(text.getBytes(StandardCharsets.UTF_8));
                replyJs(pendingSaveReq, "{\"ok\":true}");
            } catch (Exception e) {
                replyJs(pendingSaveReq, "{\"ok\":false,\"error\":\"The file couldn't be saved.\"}");
            }
            return;
        }
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
