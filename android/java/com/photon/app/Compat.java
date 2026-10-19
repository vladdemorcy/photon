package com.photon.app;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

import java.lang.reflect.InvocationTargetException;

/**
 * Calls that only exist on newer Android versions. The app is compiled against an older
 * platform library (see build-apk.sh), so these are looked up at run time instead.
 */
final class Compat {
    private static final String TAG = "Photon";

    /** ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE */
    static final int TYPE_CONNECTED_DEVICE = 0x10;

    private Compat() {}

    private static RuntimeException unwrap(Exception e) {
        Throwable t = e instanceof InvocationTargetException ? ((InvocationTargetException) e).getCause() : e;
        return t instanceof RuntimeException ? (RuntimeException) t : new RuntimeException(t);
    }

    static void startForegroundService(Context c, Intent i) {
        if (Build.VERSION.SDK_INT >= 26) {
            try {
                Context.class.getMethod("startForegroundService", Intent.class).invoke(c, i);
            } catch (Exception e) {
                Log.e(TAG, "Couldn't start Photon", unwrap(e));
            }
        } else {
            c.startService(i);
        }
    }

    static void createChannel(Context c, String id, CharSequence name) {
        if (Build.VERSION.SDK_INT < 26) return;
        try {
            Class<?> ch = Class.forName("android.app.NotificationChannel");
            Object channel = ch.getConstructor(String.class, CharSequence.class, int.class)
                    .newInstance(id, name, 2 /* NotificationManager.IMPORTANCE_LOW */);
            ch.getMethod("setShowBadge", boolean.class).invoke(channel, false);
            ch.getMethod("setDescription", String.class).invoke(channel,
                    "Shown while Photon is running, with its address on your network.");
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            NotificationManager.class.getMethod("createNotificationChannel", ch).invoke(nm, channel);
        } catch (Exception e) {
            Log.w(TAG, "Couldn't create the notification channel", unwrap(e));
        }
    }

    static Notification.Builder builder(Context c, String channel) {
        if (Build.VERSION.SDK_INT >= 26) {
            try {
                return (Notification.Builder) Notification.Builder.class
                        .getConstructor(Context.class, String.class).newInstance(c, channel);
            } catch (Exception e) {
                Log.w(TAG, "Falling back to an old-style notification", unwrap(e));
            }
        }
        return new Notification.Builder(c);
    }

    static void startForeground(Service s, int id, Notification n, int type) {
        if (Build.VERSION.SDK_INT >= 29) {
            try {
                Service.class.getMethod("startForeground", int.class, Notification.class, int.class)
                        .invoke(s, id, n, type);
                return;
            } catch (Exception e) {
                throw unwrap(e);
            }
        }
        s.startForeground(id, n);
    }
}
