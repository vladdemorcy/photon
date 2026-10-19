package com.photon.app;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

import java.io.File;
import java.io.IOException;

/** Settings and helpers shared by the app's screens, the service and the boot receiver. */
final class Photon {
    static final int PORT = 8787;
    static final String LOCAL_URL = "http://127.0.0.1:" + PORT + "/";

    private static final String PREFS = "photon";
    private static final String KEY_AUTOSTART = "autostart";
    // A file rather than a preference, because the service runs in its own process and the
    // notification's Stop button changes it from there.
    private static final String STOPPED_FILE = "stopped";

    private Photon() {}

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static boolean autostart(Context c) {
        return prefs(c).getBoolean(KEY_AUTOSTART, true);
    }

    static void setAutostart(Context c, boolean on) {
        prefs(c).edit().putBoolean(KEY_AUTOSTART, on).apply();
    }

    /** True when someone pressed Stop, so nothing should start Photon again on its own. */
    static boolean isStopped(Context c) {
        return new File(c.getFilesDir(), STOPPED_FILE).exists();
    }

    static void setStopped(Context c, boolean stopped) {
        File f = new File(c.getFilesDir(), STOPPED_FILE);
        if (stopped) {
            try { f.createNewFile(); } catch (IOException ignored) { }
        } else {
            f.delete();
        }
    }

    static void start(Context c) {
        setStopped(c, false);
        Compat.startForegroundService(c, new Intent(c, NodeService.class));
    }

    static void stop(Context c) {
        setStopped(c, true);
        try {
            c.startService(new Intent(c, NodeService.class).setAction(NodeService.ACTION_STOP));
        } catch (RuntimeException e) {
            // Not running, so there's nothing to stop.
        }
    }
}
