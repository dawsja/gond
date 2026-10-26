# The JavaScript interface is reached by name from the web app.
-keepclassmembers class io.gond.android.GondBridge {
    @android.webkit.JavascriptInterface <methods>;
}
