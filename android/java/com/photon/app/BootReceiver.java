package com.photon.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Starts Photon when the phone turns on, and again after the app is updated. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent intent) {
        if (Photon.isStopped(c)) return;
        String action = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(action) && !Photon.autostart(c)) return;
        if (Intent.ACTION_BOOT_COMPLETED.equals(action) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            Photon.start(c);
        }
    }
}
