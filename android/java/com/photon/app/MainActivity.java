package com.photon.app;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.CompoundButton;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/** The app's main screen: is Photon running, where to open it, and how to keep it running. */
public class MainActivity extends Activity {
    private static final int BG = 0xFF04060D;
    private static final int PANEL = 0xFF0C1224;
    private static final int LINE = 0xFF1B2440;
    private static final int TEXT = 0xFFE8ECF8;
    private static final int MUTED = 0xFF8D96B3;
    private static final int ACCENT = 0xFF4F8BFF;
    private static final int GOOD = 0xFF3DDC97;
    private static final int WARN = 0xFFFFB547;
    private static final int BAD = 0xFFFF6B6B;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean visible;
    private String version;          // Photon's version once it answers, otherwise null
    private long startPressedAt;

    private View dot;
    private TextView statusText, detailText, batteryText, notifyText;
    private Button openButton, startStopButton, batteryButton, notifyButton;
    private LinearLayout batteryRow, notifyRow;
    private Switch autostartSwitch;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        setContentView(buildUi());
        if (!Photon.isStopped(this)) {
            startPressedAt = System.currentTimeMillis();
            Photon.start(this);
        }
        if (saved == null && Build.VERSION.SDK_INT >= 33 && !canNotify()) {
            requestPermissions(new String[] { "android.permission.POST_NOTIFICATIONS" }, 1);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        visible = true;
        refresh();
        poll();
    }

    @Override
    protected void onPause() {
        super.onPause();
        visible = false;
        handler.removeCallbacksAndMessages(null);
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        refresh();
    }

    // ---- Status ---------------------------------------------------------------------------

    private void poll() {
        if (!visible) return;
        new Thread(new Runnable() {
            @Override
            public void run() {
                final String v = fetchVersion();
                handler.post(new Runnable() {
                    @Override
                    public void run() {
                        version = v;
                        refresh();
                        handler.postDelayed(new Runnable() { @Override public void run() { poll(); } }, 2000);
                    }
                });
            }
        }).start();
    }

    private static String fetchVersion() {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(Photon.LOCAL_URL + "api/version").openConnection();
            c.setConnectTimeout(1500);
            c.setReadTimeout(1500);
            if (c.getResponseCode() != 200) return null;
            InputStream in = c.getInputStream();
            byte[] b = new byte[512];
            int n = in.read(b);
            String s = n > 0 ? new String(b, 0, n, "UTF-8") : "";
            int i = s.indexOf("\"version\":\"");
            if (i < 0) return "";
            int j = s.indexOf('"', i + 11);
            return j > i ? s.substring(i + 11, j) : "";
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private void refresh() {
        boolean stopped = Photon.isStopped(this);
        boolean up = version != null;
        String home = Net.homeUrl(this);

        if (up) {
            setStatus(GOOD, "Photon " + version + " is running");
            detailText.setText(home != null
                    ? "Your lights follow what's playing. Tap Open Photon below to set up rooms and connections."
                    : "This phone isn't on Wi-Fi. Photon needs to be on the same network as your lights and TVs.");
        } else if (stopped) {
            setStatus(MUTED, "Photon is stopped");
            detailText.setText("Your lights won't follow what's playing until you start it again.");
        } else if (System.currentTimeMillis() - startPressedAt < 60000) {
            setStatus(WARN, "Starting Photon…");
            detailText.setText("The first start after installing or updating takes a little longer.");
        } else {
            setStatus(BAD, "Photon isn't answering");
            detailText.setText("It may be restarting after a problem. If this doesn't clear in a minute, tap Stop and then Start.");
        }
        openButton.setEnabled(up);
        openButton.setAlpha(up ? 1f : 0.45f);
        startStopButton.setText(stopped ? "Start Photon" : "Stop Photon");

        boolean unrestricted = ignoringBatteryLimits();
        batteryText.setText(unrestricted
                ? "Battery: unrestricted, so Android won't pause Photon."
                : "Battery: Android may pause Photon when the screen is off.");
        batteryText.setTextColor(unrestricted ? MUTED : WARN);
        batteryButton.setVisibility(unrestricted ? View.GONE : View.VISIBLE);

        boolean notify = canNotify();
        notifyRow.setVisibility(notify ? View.GONE : View.VISIBLE);
    }

    private void setStatus(int color, String text) {
        ((GradientDrawable) dot.getBackground()).setColor(color);
        statusText.setText(text);
    }

    private boolean ignoringBatteryLimits() {
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        return pm.isIgnoringBatteryOptimizations(getPackageName());
    }

    private boolean canNotify() {
        return Build.VERSION.SDK_INT < 33
                || checkSelfPermission("android.permission.POST_NOTIFICATIONS") == PackageManager.PERMISSION_GRANTED;
    }

    // ---- Layout ---------------------------------------------------------------------------

    private int dp(float v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
    }

    private GradientDrawable rounded(int fill, int stroke, float radius) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(fill);
        g.setCornerRadius(dp(radius));
        if (stroke != 0) g.setStroke(dp(1), stroke);
        return g;
    }

    private TextView text(String s, float sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        t.setLineSpacing(0, 1.15f);
        if (bold) t.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        return t;
    }

    private Button button(String label, boolean primary) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        b.setTextColor(primary ? Color.WHITE : TEXT);
        b.setBackground(rounded(primary ? ACCENT : PANEL, primary ? 0 : LINE, 14));
        b.setStateListAnimator(null);
        b.setPadding(dp(16), dp(14), dp(16), dp(14));
        return b;
    }

    private LinearLayout.LayoutParams fill(int top) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(top);
        return lp;
    }

    private LinearLayout card() {
        LinearLayout c = new LinearLayout(this);
        c.setOrientation(LinearLayout.VERTICAL);
        c.setBackground(rounded(PANEL, LINE, 18));
        c.setPadding(dp(18), dp(16), dp(18), dp(18));
        return c;
    }

    private View buildUi() {
        final ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(BG);
        scroll.setFillViewport(true);

        final LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setPadding(dp(20), dp(24), dp(20), dp(24));
        scroll.addView(col, new ScrollView.LayoutParams(ScrollView.LayoutParams.MATCH_PARENT, ScrollView.LayoutParams.WRAP_CONTENT));

        // Keep clear of the status and navigation bars on phones that draw edge to edge.
        scroll.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
            @Override
            public WindowInsets onApplyWindowInsets(View v, WindowInsets in) {
                col.setPadding(dp(20), dp(24) + in.getSystemWindowInsetTop(), dp(20), dp(24) + in.getSystemWindowInsetBottom());
                return in;
            }
        });

        // Header
        LinearLayout head = new LinearLayout(this);
        head.setOrientation(LinearLayout.HORIZONTAL);
        head.setGravity(Gravity.CENTER_VERTICAL);
        ImageView logo = new ImageView(this);
        logo.setImageResource(R.drawable.photon_logo);
        head.addView(logo, new LinearLayout.LayoutParams(dp(56), dp(56)));
        LinearLayout names = new LinearLayout(this);
        names.setOrientation(LinearLayout.VERTICAL);
        names.setPadding(dp(14), 0, 0, 0);
        names.addView(text("Photon", 26, TEXT, true));
        names.addView(text("Lights that follow what's playing", 14, MUTED, false));
        head.addView(names);
        col.addView(head);

        // Status
        LinearLayout status = card();
        LinearLayout statusLine = new LinearLayout(this);
        statusLine.setOrientation(LinearLayout.HORIZONTAL);
        statusLine.setGravity(Gravity.CENTER_VERTICAL);
        dot = new View(this);
        GradientDrawable d = new GradientDrawable();
        d.setShape(GradientDrawable.OVAL);
        d.setColor(WARN);
        dot.setBackground(d);
        statusLine.addView(dot, new LinearLayout.LayoutParams(dp(10), dp(10)));
        statusText = text("", 18, TEXT, true);
        statusText.setPadding(dp(10), 0, 0, 0);
        statusLine.addView(statusText);
        status.addView(statusLine);
        detailText = text("", 15, MUTED, false);
        status.addView(detailText, fill(8));
        col.addView(status, fill(24));

        openButton = button("Open Photon", true);
        openButton.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { startActivity(new Intent(MainActivity.this, WebActivity.class)); }
        });
        col.addView(openButton, fill(16));

        startStopButton = button("Stop Photon", false);
        startStopButton.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                if (Photon.isStopped(MainActivity.this)) {
                    startPressedAt = System.currentTimeMillis();
                    Photon.start(MainActivity.this);
                } else {
                    Photon.stop(MainActivity.this);
                    version = null;
                }
                refresh();
            }
        });
        col.addView(startStopButton, fill(10));

        // Keeping it running
        LinearLayout keep = card();
        keep.addView(text("Keep Photon running", 17, TEXT, true));
        keep.addView(text("Photon works best on a phone or tablet that stays at home, on Wi-Fi and plugged in. "
                + "It keeps running with the screen off and shows a notification while it does.", 14, MUTED, false), fill(6));

        batteryRow = new LinearLayout(this);
        batteryRow.setOrientation(LinearLayout.VERTICAL);
        batteryText = text("", 14, MUTED, false);
        batteryRow.addView(batteryText);
        batteryButton = button("Let Photon run in the background", false);
        batteryButton.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { askForBackground(); }
        });
        batteryRow.addView(batteryButton, fill(10));
        keep.addView(batteryRow, fill(14));

        notifyRow = new LinearLayout(this);
        notifyRow.setOrientation(LinearLayout.VERTICAL);
        notifyText = text("Notifications are off, so you won't see that Photon is running, or its Stop button, in the notification shade.", 14, MUTED, false);
        notifyRow.addView(notifyText);
        notifyButton = button("Turn on Photon's notification", false);
        notifyButton.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { openNotificationSettings(); }
        });
        notifyRow.addView(notifyButton, fill(10));
        keep.addView(notifyRow, fill(14));

        autostartSwitch = new Switch(this);
        autostartSwitch.setText("Start Photon when the phone turns on");
        autostartSwitch.setTextColor(TEXT);
        autostartSwitch.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        autostartSwitch.setChecked(Photon.autostart(this));
        autostartSwitch.setOnCheckedChangeListener(new CompoundButton.OnCheckedChangeListener() {
            @Override public void onCheckedChanged(CompoundButton b, boolean on) { Photon.setAutostart(MainActivity.this, on); }
        });
        keep.addView(autostartSwitch, fill(16));
        col.addView(keep, fill(24));

        TextView foot = text("Your rooms and settings stay on this phone and are kept when you update the app. "
                + "Uninstalling the app deletes them.", 13, MUTED, false);
        col.addView(foot, fill(20));

        return scroll;
    }

    private void askForBackground() {
        try {
            startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                    .setData(Uri.parse("package:" + getPackageName())));
        } catch (RuntimeException e) {
            startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
        }
    }

    private void openNotificationSettings() {
        if (Build.VERSION.SDK_INT >= 33 && !shouldShowRequestPermissionRationale("android.permission.POST_NOTIFICATIONS")) {
            // Either never asked, or turned down for good. Settings works for both.
            try {
                startActivity(new Intent("android.settings.APP_NOTIFICATION_SETTINGS")
                        .putExtra("android.provider.extra.APP_PACKAGE", getPackageName()));
                return;
            } catch (RuntimeException ignored) { }
        }
        if (Build.VERSION.SDK_INT >= 33) {
            requestPermissions(new String[] { "android.permission.POST_NOTIFICATIONS" }, 1);
        }
    }
}
