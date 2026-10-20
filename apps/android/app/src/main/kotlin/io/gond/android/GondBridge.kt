package io.gond.android

import android.webkit.JavascriptInterface

/*
 * Anything that changes what the app shows or does is handed to the
 * activity, which acts only when the page that asked belongs to the server
 * it is connected to.
 */
class GondBridge(private val activity: MainActivity) {
    @JavascriptInterface
    fun platform(): String = "android"

    @JavascriptInterface
    fun version(): String = BuildConfig.VERSION_NAME

    @JavascriptInterface
    fun changeServer() = activity.fromTrustedPage { showConnect(server, null) }

    @JavascriptInterface
    fun notify(title: String?, body: String?, url: String?, tag: String?) = activity.fromTrustedPage {
        Notifications.show(this, title.orEmpty().ifBlank { getString(R.string.app_name) }, body.orEmpty(), url ?: "/app", tag ?: url ?: "gond")
    }

    @JavascriptInterface
    fun notificationsState(): String = Notifications.state(activity)

    @JavascriptInterface
    fun requestNotifications() = activity.fromTrustedPage { askForNotifications() }

    @JavascriptInterface
    fun signIn(next: String?) = activity.fromTrustedPage { startSignIn(next) }

    @JavascriptInterface
    fun openExternal(url: String?) = activity.fromTrustedPage { if (url != null) openOutside(url) }

    @JavascriptInterface
    fun setTheme(background: String?, dark: Boolean) = activity.fromTrustedPage { applyTheme(background, dark) }
}
