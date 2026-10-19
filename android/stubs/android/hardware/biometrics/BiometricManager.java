package android.hardware.biometrics;

// Compile-time stand-in for Android 10's BiometricManager (see BiometricPrompt.java).
public class BiometricManager {
    public int canAuthenticate() { throw new RuntimeException("Stub!"); }               // Android 10
    public int canAuthenticate(int authenticators) { throw new RuntimeException("Stub!"); } // Android 11
}
