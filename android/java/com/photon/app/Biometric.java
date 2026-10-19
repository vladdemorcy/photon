package com.photon.app;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.DialogInterface;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.hardware.biometrics.BiometricManager;
import android.hardware.biometrics.BiometricPrompt;
import android.os.Build;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.Looper;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.concurrent.Executor;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Signing in to Photon with the phone's fingerprint or face.
 *
 * Photon gives this phone a device key. The app encrypts it with an AES key that lives in
 * Android's keystore (in the phone's secure hardware where it has some) and that the keystore
 * only lets the app use right after a strong fingerprint or face match. The fingerprint itself
 * never leaves Android. Adding a new fingerprint or face on the phone makes the keystore throw
 * the key away, so whoever adds one can't use it to sign in; Photon then asks for the password.
 *
 * Needs Android 9 or newer (BiometricPrompt). Compiled against stand-ins in android/stubs.
 */
final class Biometric {
    private static final String TAG = "Photon";
    private static final String KEY_ALIAS = "photon-sign-in";
    private static final String PREFS = "biometric";
    private static final String TRANSFORM = "AES/GCM/NoPadding";

    // BiometricManager and BiometricPrompt numbers (fixed by Android).
    private static final int BIOMETRIC_SUCCESS = 0;
    private static final int ERROR_NONE_ENROLLED = 11;
    private static final int BIOMETRIC_STRONG = 0x0F;
    private static final int ERROR_CANCELED = 5;
    private static final int ERROR_USER_CANCELED = 10;
    private static final int ERROR_NEGATIVE_BUTTON = 13;

    interface Result { void done(JSONObject r); }

    private Biometric() {}

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** "unsupported", "no-lock", "none-enrolled", "available" or "on", plus the device key's id. */
    static JSONObject status(Context c) {
        JSONObject o = new JSONObject();
        try {
            String st = readiness(c);
            boolean saved = prefs(c).contains("data");
            o.put("status", "available".equals(st) && saved ? "on" : st);
            o.put("id", saved ? prefs(c).getString("id", "") : "");
            o.put("model", Build.MODEL);
        } catch (JSONException ignored) { }
        return o;
    }

    private static String readiness(Context c) {
        if (Build.VERSION.SDK_INT < 28) return "unsupported";
        KeyguardManager km = (KeyguardManager) c.getSystemService(Context.KEYGUARD_SERVICE);
        if (km == null || !km.isDeviceSecure()) return "no-lock";
        if (Build.VERSION.SDK_INT >= 29) {
            BiometricManager bm = c.getSystemService(BiometricManager.class);
            if (bm == null) return "unsupported";
            int r = Build.VERSION.SDK_INT >= 30 ? bm.canAuthenticate(BIOMETRIC_STRONG) : bm.canAuthenticate();
            if (r == BIOMETRIC_SUCCESS) return "available";
            return r == ERROR_NONE_ENROLLED ? "none-enrolled" : "unsupported";
        }
        // Android 9 has no way to ask; a fingerprint reader is the usual strong biometric.
        return c.getPackageManager().hasSystemFeature(PackageManager.FEATURE_FINGERPRINT) ? "available" : "unsupported";
    }

    /** Locks the device key behind the fingerprint or face. */
    static void enable(final Activity a, final String id, final String token, final Result cb) {
        if (!"available".equals(readiness(a))) { cb.done(fail("Fingerprint or face sign-in isn't available on this phone right now.")); return; }
        final Cipher cipher;
        try {
            SecretKey key = newKey();
            cipher = Cipher.getInstance(TRANSFORM);
            cipher.init(Cipher.ENCRYPT_MODE, key);
        } catch (Exception e) {
            Log.w(TAG, "Couldn't make the sign-in key", e);
            cb.done(fail("The phone couldn't make a key for fingerprint or face sign-in. Check that a fingerprint or face is set up in its settings."));
            return;
        }
        prompt(a, cipher, "Turn on fingerprint or face sign-in", new Result() {
            @Override public void done(JSONObject r) {
                if (!r.optBoolean("ok")) { deleteKey(); cb.done(r); return; }
                try {
                    byte[] data = cipher.doFinal(token.getBytes(StandardCharsets.UTF_8));
                    prefs(a).edit()
                            .putString("id", id)
                            .putString("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
                            .putString("data", Base64.encodeToString(data, Base64.NO_WRAP))
                            .apply();
                    cb.done(ok());
                } catch (Exception e) {
                    Log.w(TAG, "Couldn't lock the sign-in key", e);
                    deleteKey();
                    cb.done(fail("The phone couldn't save the key for fingerprint or face sign-in."));
                }
            }
        });
    }

    /** Asks for the fingerprint or face and hands back the device key. */
    static void unlock(final Activity a, final Result cb) {
        final SharedPreferences p = prefs(a);
        if (!p.contains("data") || Build.VERSION.SDK_INT < 28) { cb.done(fail("Fingerprint or face sign-in isn't turned on.")); return; }
        final Cipher cipher;
        try {
            KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
            ks.load(null);
            SecretKey key = (SecretKey) ks.getKey(KEY_ALIAS, null);
            if (key == null) throw new KeyPermanentlyInvalidatedException();
            cipher = Cipher.getInstance(TRANSFORM);
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, Base64.decode(p.getString("iv", ""), Base64.NO_WRAP)));
        } catch (KeyPermanentlyInvalidatedException e) {
            disable(a);
            cb.done(gone());
            return;
        } catch (Exception e) {
            Log.w(TAG, "Couldn't open the sign-in key", e);
            if (e.getCause() instanceof KeyPermanentlyInvalidatedException) { disable(a); cb.done(gone()); return; }
            cb.done(fail("Fingerprint or face sign-in didn't work. Use your password."));
            return;
        }
        prompt(a, cipher, "Sign in to Photon", new Result() {
            @Override public void done(JSONObject r) {
                if (!r.optBoolean("ok")) { cb.done(r); return; }
                try {
                    byte[] token = cipher.doFinal(Base64.decode(p.getString("data", ""), Base64.NO_WRAP));
                    JSONObject o = ok();
                    o.put("id", p.getString("id", ""));
                    o.put("token", new String(token, StandardCharsets.UTF_8));
                    cb.done(o);
                } catch (Exception e) {
                    Log.w(TAG, "Couldn't unlock the sign-in key", e);
                    cb.done(fail("Fingerprint or face sign-in didn't work. Use your password."));
                }
            }
        });
    }

    static void disable(Context c) {
        prefs(c).edit().clear().apply();
        deleteKey();
    }

    // ---- helpers -------------------------------------------------------------------------

    private static SecretKey newKey() throws Exception {
        deleteKey();
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        // Every use needs a fresh strong fingerprint or face match (no time window), and the
        // key is dropped when fingerprints or faces are added (the default for such keys).
        kg.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setUserAuthenticationRequired(true)
                .build());
        return kg.generateKey();
    }

    private static void deleteKey() {
        try {
            KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
            ks.load(null);
            ks.deleteEntry(KEY_ALIAS);
        } catch (Exception ignored) { }
    }

    private static void prompt(Activity a, Cipher cipher, String title, final Result cb) {
        final Handler main = new Handler(Looper.getMainLooper());
        Executor executor = new Executor() {
            @Override public void execute(Runnable r) { main.post(r); }
        };
        final boolean[] answered = {false};
        BiometricPrompt.Builder b = new BiometricPrompt.Builder(a)
                .setTitle(title)
                .setSubtitle("Use your fingerprint or face")
                .setNegativeButton("Use password", executor, new DialogInterface.OnClickListener() {
                    @Override public void onClick(DialogInterface d, int which) { once(answered, cb, canceled()); }
                });
        if (Build.VERSION.SDK_INT >= 29) b.setConfirmationRequired(false);
        try {
            b.build().authenticate(new BiometricPrompt.CryptoObject(cipher), new CancellationSignal(), executor,
                    new BiometricPrompt.AuthenticationCallback() {
                        @Override public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                            once(answered, cb, ok());
                        }
                        @Override public void onAuthenticationError(int code, CharSequence msg) {
                            boolean cancel = code == ERROR_CANCELED || code == ERROR_USER_CANCELED || code == ERROR_NEGATIVE_BUTTON;
                            once(answered, cb, cancel ? canceled() : fail(String.valueOf(msg)));
                        }
                    });
        } catch (RuntimeException e) {
            Log.w(TAG, "Couldn't show the fingerprint prompt", e);
            once(answered, cb, fail("The phone couldn't show the fingerprint or face prompt."));
        }
    }

    private static void once(boolean[] answered, Result cb, JSONObject r) {
        if (answered[0]) return;
        answered[0] = true;
        cb.done(r);
    }

    private static JSONObject ok() {
        JSONObject o = new JSONObject();
        try { o.put("ok", true); } catch (JSONException ignored) { }
        return o;
    }

    private static JSONObject fail(String msg) {
        JSONObject o = new JSONObject();
        try { o.put("ok", false); o.put("error", msg); } catch (JSONException ignored) { }
        return o;
    }

    private static JSONObject canceled() {
        JSONObject o = fail("");
        try { o.put("canceled", true); } catch (JSONException ignored) { }
        return o;
    }

    private static JSONObject gone() {
        return fail("A fingerprint or face was added or removed on this phone, so Photon needs your password once. Then turn fingerprint or face sign-in on again under Connections > Password and sign-in.");
    }
}
