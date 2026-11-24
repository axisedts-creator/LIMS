# R8 / ProGuard rules for release binary hardening (REQ-SEC-112)

# Strip Android debug/verbose logging in release binaries
-assumenosideeffects class android.util.Log {
    public static boolean isLoggable(java.lang.String, int);
    public static int v(...);
    public static int d(...);
}

# Strip source file attributes and line numbers to prevent symbol recovery
-renamesourcefileattribute SourceFile
-keepattributes !SourceFile,!LineNumberTable
