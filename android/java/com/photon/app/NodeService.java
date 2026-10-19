package com.photon.app;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.wifi.WifiManager;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.Process;
import android.system.Os;
import android.util.Log;

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Runs Photon. Lives in its own process (":node") because Node can only be started once per
 * process and can't be shut down from outside, so stopping Photon means ending this process.
 */
public class NodeService extends Service {
    static final String ACTION_STOP = "com.photon.app.action.STOP";
    private static final String TAG = "Photon";
    private static final String CHANNEL = "photon";
    private static final int NOTE_ID = 1;

    static {
        System.loadLibrary("c++_shared");
        System.loadLibrary("node");
        System.loadLibrary("photon-node");
    }

    /** Implemented in jni/photon-node.c. Returns only if Node exits by itself. */
    private static native int startNode(String[] args, String logPath);

    private static volatile boolean running;

    private final Handler main = new Handler(Looper.getMainLooper());
    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private WifiManager.MulticastLock multicastLock;
    private ConnectivityManager.NetworkCallback networkCallback;
    private String status = "Starting Photon…";

    @Override
    public void onCreate() {
        super.onCreate();
        Compat.createChannel(this, CHANNEL, "Photon running");
        showNotification();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            Photon.setStopped(this, true);
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }
        if (intent == null && Photon.isStopped(this)) {
            // Android restarted the service, but someone had pressed Stop.
            stopSelf();
            return START_NOT_STICKY;
        }
        showNotification();
        if (!running) {
            running = true;
            holdLocks();
            watchNetwork();
            startPhoton();
        }
        // If Photon crashes, Android starts the service again.
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        releaseLocks();
        if (networkCallback != null) {
            try { connectivity().unregisterNetworkCallback(networkCallback); } catch (RuntimeException ignored) { }
        }
        if (running) {
            // Node has no way to stop from outside its own thread, so end the whole process.
            Process.killProcess(Process.myPid());
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ---- Photon -------------------------------------------------------------------------

    private void startPhoton() {
        final File files = getFilesDir();
        final File data = new File(files, "data");
        final File netFile = new File(files, "net.json");
        data.mkdirs();
        Net.write(this, netFile);
        final File log = new File(data, "console.log");
        if (log.length() > 2 * 1024 * 1024) log.delete();

        Thread t = new Thread(null, new Runnable() {
            @Override
            public void run() {
                try {
                    File root = unpack(files);
                    setenv("CONFIG_PATH", new File(data, "config.json").getPath());
                    setenv("PORT", String.valueOf(Photon.PORT));
                    setenv("PHOTON_SERVICE", "android");
                    setenv("PHOTON_ANDROID_NET", netFile.getPath());
                    setenv("HOME", files.getPath());
                    setenv("TMPDIR", getCacheDir().getPath());
                    Log.i(TAG, "Starting Photon from " + root);
                    int code = startNode(new String[] { "node", new File(root, "android-main.js").getPath() }, log.getPath());
                    Log.w(TAG, "Photon exited with code " + code);
                } catch (Throwable e) {
                    Log.e(TAG, "Photon couldn't start", e);
                    status = "Photon couldn't start: " + e.getMessage();
                    main.post(new Runnable() { @Override public void run() { showNotification(); } });
                    try { Thread.sleep(10000); } catch (InterruptedException ignored) { }
                }
                // Let Android start the service again, unless someone pressed Stop.
                Process.killProcess(Process.myPid());
            }
        }, "photon", 16 * 1024 * 1024);
        t.start();
    }

    private static void setenv(String name, String value) throws Exception {
        Os.setenv(name, value, true);
    }

    /** Copies Photon's files out of the app the first time, and again after each update. */
    private File unpack(File files) throws IOException {
        File root = new File(files, "photon");
        File stamp = new File(root, ".installed");
        String build = buildId();
        if (stamp.exists() && build.equals(readSmall(stamp))) return root;

        deleteTree(root);
        File tmp = new File(files, "photon.unpacking");
        deleteTree(tmp);
        tmp.mkdirs();
        String base = tmp.getCanonicalPath() + File.separator;
        byte[] buf = new byte[64 * 1024];
        try (ZipInputStream zin = new ZipInputStream(getAssets().open("photon.zip"))) {
            ZipEntry e;
            while ((e = zin.getNextEntry()) != null) {
                File out = new File(tmp, e.getName());
                if (!out.getCanonicalPath().startsWith(base)) throw new IOException("Bad path in photon.zip: " + e.getName());
                if (e.isDirectory()) { out.mkdirs(); continue; }
                out.getParentFile().mkdirs();
                try (OutputStream os = new BufferedOutputStream(new FileOutputStream(out))) {
                    int n;
                    while ((n = zin.read(buf)) > 0) os.write(buf, 0, n);
                }
            }
        }
        try (OutputStream os = new FileOutputStream(new File(tmp, ".installed"))) {
            os.write(build.getBytes("UTF-8"));
        }
        if (!tmp.renameTo(root)) throw new IOException("Couldn't move Photon's files into place");
        return root;
    }

    private String buildId() {
        try {
            PackageInfo p = getPackageManager().getPackageInfo(getPackageName(), 0);
            return p.versionName + "/" + p.lastUpdateTime;
        } catch (Exception e) {
            return "unknown";
        }
    }

    private static String readSmall(File f) {
        try (InputStream in = new java.io.FileInputStream(f)) {
            byte[] b = new byte[256];
            int n = in.read(b);
            return n > 0 ? new String(b, 0, n, "UTF-8") : "";
        } catch (IOException e) {
            return "";
        }
    }

    private static void deleteTree(File f) {
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        f.delete();
    }

    // ---- Keeping it running ---------------------------------------------------------------

    private void holdLocks() {
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Photon:running");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire();
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "Photon");
            wifiLock.setReferenceCounted(false);
            wifiLock.acquire();
            // Without this, Android drops the multicast replies lights and TVs use to say hello.
            multicastLock = wm.createMulticastLock("Photon");
            multicastLock.setReferenceCounted(false);
            multicastLock.acquire();
        } catch (RuntimeException e) {
            Log.w(TAG, "Couldn't take a lock", e);
        }
    }

    private void releaseLocks() {
        try { if (wakeLock != null) wakeLock.release(); } catch (RuntimeException ignored) { }
        try { if (wifiLock != null) wifiLock.release(); } catch (RuntimeException ignored) { }
        try { if (multicastLock != null) multicastLock.release(); } catch (RuntimeException ignored) { }
    }

    private ConnectivityManager connectivity() {
        return (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
    }

    private void watchNetwork() {
        final File netFile = new File(getFilesDir(), "net.json");
        networkCallback = new ConnectivityManager.NetworkCallback() {
            private void changed() {
                Net.write(NodeService.this, netFile);
                main.post(new Runnable() { @Override public void run() { showNotification(); } });
            }
            @Override public void onAvailable(Network n) { changed(); }
            @Override public void onLost(Network n) { changed(); }
            @Override public void onLinkPropertiesChanged(Network n, LinkProperties lp) { changed(); }
        };
        try {
            NetworkRequest req = new NetworkRequest.Builder()
                    .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    .build();
            connectivity().registerNetworkCallback(req, networkCallback);
        } catch (RuntimeException e) {
            networkCallback = null;
        }
    }

    // ---- Notification ---------------------------------------------------------------------

    private void showNotification() {
        String url = Net.homeUrl(this);
        String title = running && url != null ? "Photon is running" : status;
        String text = url != null
                ? "Open " + url + " on any device at home."
                : "Waiting for Wi-Fi. Photon needs to be on your home network.";
        if (!status.startsWith("Starting") && !status.startsWith("Photon is")) text = status;

        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        PendingIntent open = PendingIntent.getActivity(this, 0,
                new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), flags);
        PendingIntent stop = PendingIntent.getService(this, 1,
                new Intent(this, NodeService.class).setAction(ACTION_STOP), flags);

        Notification.Builder b = Compat.builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_photon)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setContentIntent(open)
                .setOngoing(true)
                .setShowWhen(false)
                .setColor(0xFF4F8BFF)
                .setCategory(Notification.CATEGORY_SERVICE)
                .addAction(new Notification.Action.Builder(0, "Stop Photon", stop).build());
        if (android.os.Build.VERSION.SDK_INT < 26) b.setPriority(Notification.PRIORITY_LOW);
        try {
            Compat.startForeground(this, NOTE_ID, b.build(), Compat.TYPE_CONNECTED_DEVICE);
        } catch (RuntimeException e) {
            Log.e(TAG, "Android wouldn't let Photon run in the foreground", e);
        }
    }
}
