package android.hardware.biometrics;

// Compile-time stand-in for Android 9's BiometricPrompt. The app is compiled against the
// Android 6 library, which doesn't have it; on the phone the real class is used. Only the
// parts Photon calls are here, and this file is never packed into the APK.
public class BiometricPrompt {
    public void authenticate(CryptoObject crypto, android.os.CancellationSignal cancel,
                             java.util.concurrent.Executor executor, AuthenticationCallback callback) { throw new RuntimeException("Stub!"); }

    public static class Builder {
        public Builder(android.content.Context context) { throw new RuntimeException("Stub!"); }
        public Builder setTitle(CharSequence title) { throw new RuntimeException("Stub!"); }
        public Builder setSubtitle(CharSequence subtitle) { throw new RuntimeException("Stub!"); }
        public Builder setDescription(CharSequence description) { throw new RuntimeException("Stub!"); }
        public Builder setNegativeButton(CharSequence text, java.util.concurrent.Executor executor,
                                         android.content.DialogInterface.OnClickListener listener) { throw new RuntimeException("Stub!"); }
        public Builder setConfirmationRequired(boolean required) { throw new RuntimeException("Stub!"); } // Android 10
        public BiometricPrompt build() { throw new RuntimeException("Stub!"); }
    }

    public static final class CryptoObject {
        public CryptoObject(javax.crypto.Cipher cipher) { throw new RuntimeException("Stub!"); }
        public javax.crypto.Cipher getCipher() { throw new RuntimeException("Stub!"); }
    }

    public static class AuthenticationResult {
        public CryptoObject getCryptoObject() { throw new RuntimeException("Stub!"); }
    }

    public abstract static class AuthenticationCallback {
        public AuthenticationCallback() { throw new RuntimeException("Stub!"); }
        public void onAuthenticationError(int errorCode, CharSequence errString) { }
        public void onAuthenticationHelp(int helpCode, CharSequence helpString) { }
        public void onAuthenticationSucceeded(AuthenticationResult result) { }
        public void onAuthenticationFailed() { }
    }
}
