package io.gond.android

import android.Manifest
import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.util.Base64
import android.view.View
import android.view.inputmethod.EditorInfo
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.addCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.content.ContextCompat
import androidx.core.graphics.Insets
import androidx.core.graphics.toColorInt
import androidx.core.net.toUri
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.widget.doAfterTextChanged
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.lifecycle.lifecycleScope
import io.gond.android.databinding.ActivityMainBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.security.SecureRandom
import org.json.JSONObject
import kotlin.math.max

class MainActivity : AppCompatActivity() {
    private lateinit var binding: ActivityMainBinding
    private val web get() = binding.web

    var server: String? = null
        private set
    private var connecting = false
    private var pendingFiles: ValueCallback<Array<Uri>>? = null
    private var lastInsets: WindowInsetsCompat? = null
    private var ownPage = false
    private var pendingMic: PermissionRequest? = null

    private val pickFiles = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        pendingFiles?.onReceiveValue(chosenFiles(result.resultCode, result.data))
        pendingFiles = null
    }
    // parseResult reads only the intent's data, so a pick of several (in its ClipData) would come back as one.
    private fun chosenFiles(resultCode: Int, data: Intent?): Array<Uri>? {
        if (resultCode != RESULT_OK || data == null) return null
        val clip = data.clipData
        if (clip != null && clip.itemCount > 0) return Array(clip.itemCount) { clip.getItemAt(it).uri }
        return data.data?.let { arrayOf(it) }
    }
    private val micPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val request = pendingMic ?: return@registerForActivityResult
        pendingMic = null
        if (granted) request.grant(request.resources) else request.deny()
    }
    private val notificationsPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        // The web app's notifications card reads the state again on this event.
        web.evaluateJavascript("window.dispatchEvent(new Event('gond:notifications'))", null)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        applyInsets()
        setupWebView()
        setupConnect()

        onBackPressedDispatcher.addCallback(this) {
            when {
                binding.connect.visibility == View.VISIBLE && server != null && !connecting -> showServer(null)
                web.visibility == View.VISIBLE && web.canGoBack() -> web.goBack()
                else -> {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                    isEnabled = true
                }
            }
        }

        shown = java.lang.ref.WeakReference(this)
        Push.refresh(this) { pushChanged() }

        server = Prefs.server(this)
        if (finishSignIn(intent)) return
        val target = intent?.getStringExtra(Notifications.EXTRA_URL)
        if (server != null) showServer(target ?: "/app") else showConnect(null, null)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (finishSignIn(intent)) return
        val url = intent.getStringExtra(Notifications.EXTRA_URL) ?: return
        if (server != null) showServer(url)
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
        web.evaluateJavascript("window.dispatchEvent(new Event('gond:app-shown'))", null)
    }

    // WebView writes new cookies to disk lazily, and a swipe from the recent apps kills the
    // process before it does, so the sign-in's session cookie would be lost with it.
    override fun onPause() {
        CookieManager.getInstance().flush()
        // The WebView keeps its page "visible" in the background, and Android may then kill the app
        // without a pagehide, so the page is told here and stops counting as reading its conversation.
        web.evaluateJavascript("window.dispatchEvent(new Event('gond:app-hidden'))", null)
        super.onPause()
    }

    override fun onDestroy() {
        if (shown?.get() === this) {
            shown = null
            // The page that held the call goes with the activity.
            CallService.set(this, "", "")
        }
        web.destroy()
        super.onDestroy()
    }

    private fun applyInsets() {
        ViewCompat.setOnApplyWindowInsetsListener(binding.root) { _, insets ->
            lastInsets = insets
            layoutFor(insets)
            WindowInsetsCompat.CONSUMED
        }
    }

    // Your Gond's pages draw under the status and navigation bars, the way a
    // native app does, and pad for them themselves with the sizes pushInsets
    // hands over (the web app's --safe-* variables). The Connect screen and
    // anyone else's page (a provider's sign-in) can't, so they stay between
    // the bars.
    private fun layoutFor(insets: WindowInsetsCompat) {
        val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
        val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
        val under = web.visibility == View.VISIBLE && ownPage
        if (under) binding.root.setPadding(0, 0, 0, ime.bottom)
        else binding.root.setPadding(bars.left, bars.top, bars.right, max(bars.bottom, ime.bottom))
        binding.progress.translationY = if (under) bars.top.toFloat() else 0f
        if (under) pushInsets(bars, typing = ime.bottom > 0)
    }

    private fun relayout() {
        lastInsets?.let(::layoutFor)
    }

    private fun pushInsets(bars: Insets, typing: Boolean) {
        val density = resources.displayMetrics.density
        fun css(value: Int) = "${value / density}px"
        val values = mapOf(
            "--shell-inset-top" to css(bars.top),
            "--shell-inset-bottom" to css(if (typing) 0 else bars.bottom),
            "--shell-inset-left" to css(bars.left),
            "--shell-inset-right" to css(bars.right),
        )
        val script = values.entries.joinToString("") { (name, value) -> "s.setProperty('$name','$value');" }
        web.evaluateJavascript("(function(s){$script})(document.documentElement.style)", null)
    }

    fun applyTheme(background: String?, dark: Boolean) {
        val color = try {
            background?.trim()?.toColorInt()
        } catch (_: IllegalArgumentException) {
            null
        }
        if (color != null) binding.root.setBackgroundColor(color)
        val controller = WindowCompat.getInsetsController(window, binding.root)
        controller.isAppearanceLightStatusBars = !dark
        controller.isAppearanceLightNavigationBars = !dark
    }

    private fun resetTheme() {
        binding.root.setBackgroundColor(ContextCompat.getColor(this, R.color.background))
        val night = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        val controller = WindowCompat.getInsetsController(window, binding.root)
        controller.isAppearanceLightStatusBars = !night
        controller.isAppearanceLightNavigationBars = !night
    }

    private fun setupConnect() {
        binding.address.doAfterTextChanged { binding.field.error = null }
        binding.address.setOnEditorActionListener { _, action, _ ->
            if (action == EditorInfo.IME_ACTION_GO) {
                connect(binding.address.text?.toString())
                true
            } else {
                false
            }
        }
        binding.submit.setOnClickListener { connect(binding.address.text?.toString()) }
        binding.back.setOnClickListener { showServer(null) }
    }

    fun showConnect(prefill: String?, error: String?) {
        resetTheme()
        web.visibility = View.GONE
        binding.progress.visibility = View.GONE
        binding.connect.visibility = View.VISIBLE
        relayout()
        if (prefill != null) binding.address.setText(prefill)
        binding.field.error = error
        binding.back.visibility = if (server != null && web.url != null) View.VISIBLE else View.GONE
        binding.back.text = getString(R.string.connect_back, server ?: "")
        binding.address.requestFocus()
        binding.address.setSelection(binding.address.text?.length ?: 0)
    }

    private fun setBusy(busy: Boolean) {
        connecting = busy
        binding.submit.isEnabled = !busy
        binding.submit.text = getString(if (busy) R.string.connect_busy else R.string.connect_button)
        binding.address.isEnabled = !busy
    }

    private fun connect(input: String?) {
        if (connecting) return
        val origins = try {
            ServerUrl.candidates(input)
        } catch (failure: ServerUrl.Invalid) {
            binding.field.error = getString(
                when (failure.reason) {
                    ServerUrl.Reason.EMPTY -> R.string.connect_error_empty
                    ServerUrl.Reason.INVALID -> R.string.connect_error_invalid
                    ServerUrl.Reason.SCHEME -> R.string.connect_error_scheme
                    ServerUrl.Reason.CREDENTIALS -> R.string.connect_error_credentials
                },
            )
            return
        }
        setBusy(true)
        binding.field.error = null
        lifecycleScope.launch {
            val found = try {
                origins.firstOrNull { origin -> isGond(origin) }
            } catch (_: Exception) {
                null
            }
            setBusy(false)
            if (found == null) {
                binding.field.error = getString(R.string.connect_no_answer)
                return@launch
            }
            if (found != server) {
                // A different Gond: its own sign-in, not the last one's.
                CookieManager.getInstance().removeAllCookies(null)
                web.clearHistory()
            }
            server = found
            Prefs.setServer(this@MainActivity, found)
            showServer("/login")
        }
    }

    private suspend fun isGond(origin: String): Boolean = withContext(Dispatchers.IO) {
        try {
            val connection = URL("$origin/api/health").openConnection() as HttpURLConnection
            connection.connectTimeout = PROBE_TIMEOUT_MS
            connection.readTimeout = PROBE_TIMEOUT_MS
            connection.instanceFollowRedirects = true
            connection.setRequestProperty("Accept", "application/json")
            connection.useCaches = false
            try {
                if (connection.responseCode !in 200..299) return@withContext false
                val body = connection.inputStream.bufferedReader().use { it.readText() }
                JSONObject(body).optBoolean("ok", false)
            } finally {
                connection.disconnect()
            }
        } catch (_: Exception) {
            false
        }
    }

    fun showServer(path: String?) {
        val origin = server ?: return
        binding.connect.visibility = View.GONE
        web.visibility = View.VISIBLE
        relayout()
        if (path != null) web.loadUrl(Uri.parse(origin).buildUpon().encodedPath(null).build().toString().trimEnd('/') + path)
    }

    /**
     * The provider's sign-in runs in the phone's browser: a WebView can't use
     * passkeys, and many providers refuse to sign in inside one. The browser
     * gets only a hash of a verifier kept here; the API sends back a one-time
     * code that is good only with it (see apps/api/src/mobile-sign-in.ts).
     */
    fun startSignIn(next: String?) {
        val origin = server ?: return
        val verifier = Base64.encodeToString(ByteArray(32).also { SecureRandom().nextBytes(it) }, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
        val challenge = Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray()), Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
        Prefs.setPendingSignIn(this, verifier, next?.takeIf { it.startsWith("/") && !it.startsWith("//") } ?: "/app")
        openOutside("$origin/api/mobile-sign-in/start?challenge=$challenge&app=android")
    }

    private fun finishSignIn(intent: Intent?): Boolean {
        val data = intent?.data ?: return false
        if (data.scheme != "gond" || data.host != "sign-in") return false
        if (server == null) {
            showConnect(null, null)
            return true
        }
        val pending = Prefs.takePendingSignIn(this)
        val code = data.getQueryParameter("code")
        if (pending == null || code == null) {
            showServer("/login?error=oidc")
            return true
        }
        val (verifier, next) = pending
        showServer(
            "/api/mobile-sign-in/redeem?" + Uri.Builder()
                .appendQueryParameter("code", code)
                .appendQueryParameter("verifier", verifier)
                .appendQueryParameter("next", next)
                .build().encodedQuery,
        )
        return true
    }

    /** Runs `action` only when the page asking belongs to the server; the bridge calls it off the UI thread. */
    fun fromTrustedPage(action: MainActivity.() -> Unit) {
        runOnUiThread {
            if (ServerUrl.sameOrigin(web.url, server)) action()
        }
    }

    fun askForNotifications() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (Notifications.state(this) == "prompt") {
                notificationsPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
                return
            }
        }
        // Turned off in the system, or an older Android: the app's notification settings.
        startActivity(Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, packageName))
    }

    fun openOutside(url: String) {
        val uri = url.toUri()
        try {
            if (uri.scheme == "http" || uri.scheme == "https") CustomTabsIntent.Builder().build().launchUrl(this, uri)
            else startActivity(Intent(Intent.ACTION_VIEW, uri))
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(this, R.string.no_app_for_link, Toast.LENGTH_SHORT).show()
        }
    }

    private fun setupWebView() {
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
            // target=_blank and window.open reach onCreateWindow below.
            setSupportMultipleWindows(true)
            javaScriptCanOpenWindowsAutomatically = false
            useWideViewPort = true
            loadWithOverviewMode = true
            setSupportZoom(false)
            builtInZoomControls = false
            userAgentString = "$userAgentString Gond/${BuildConfig.VERSION_NAME} (Android)"
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false)
        web.addJavascriptInterface(GondBridge(this), "gondMobile")
        web.setBackgroundColor(Color.TRANSPARENT)

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                val origin = server
                val scheme = url.scheme?.lowercase()
                if (scheme != "http" && scheme != "https") {
                    openOutside(url.toString())
                    return true
                }
                // The localhost end of an MCP sign-in (see MCP_LOOPBACK_CALLBACK in
                // packages/shared): finished on the server's own callback, as the desktop does.
                if (isLoopbackCallback(url) && origin != null) {
                    view.loadUrl("$origin/api/mcp-servers/oauth/callback?${url.encodedQuery.orEmpty()}")
                    return true
                }
                // Everything else loads here: your Gond's pages, and a sign-in the page
                // started (Composio, an MCP server's OAuth) so it can come back with the
                // session. Links that open a new window go to the browser (onCreateWindow).
                return false
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                binding.progress.visibility = View.VISIBLE
                ownPage = server?.let { ServerUrl.sameOrigin(url ?: "", it) } == true
                relayout()
            }

            override fun onPageCommitVisible(view: WebView, url: String?) {
                relayout()
            }

            override fun onPageFinished(view: WebView, url: String?) {
                binding.progress.visibility = View.GONE
                relayout()
                CookieManager.getInstance().flush()
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                val origin = server ?: return
                if (request.isForMainFrame && ServerUrl.sameOrigin(request.url.toString(), origin)) {
                    showConnect(origin, getString(R.string.connect_unreachable, origin, error.description))
                }
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, newProgress: Int) {
                binding.progress.setProgressCompat(newProgress, true)
            }

            /** The URL is caught from the first navigation of a throwaway WebView. */
            override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: android.os.Message): Boolean {
                val popup = WebView(view.context)
                popup.webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(popupView: WebView, request: WebResourceRequest): Boolean {
                        val url = request.url.toString()
                        if (ServerUrl.sameOrigin(url, server)) web.loadUrl(url) else if (url != "about:blank") openOutside(url)
                        popupView.destroy()
                        return true
                    }
                }
                (resultMsg.obj as WebView.WebViewTransport).webView = popup
                resultMsg.sendToTarget()
                return true
            }

            /** The microphone, for the composer's voice button, and only for the person's own Gond. */
            override fun onPermissionRequest(request: PermissionRequest) {
                val micOnly = request.resources.toList() == listOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE)
                if (!micOnly || !ServerUrl.sameOrigin(request.origin.toString(), server)) return request.deny()
                if (ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) return request.grant(request.resources)
                pendingMic?.deny()
                pendingMic = request
                micPermission.launch(Manifest.permission.RECORD_AUDIO)
            }

            override fun onPermissionRequestCanceled(request: PermissionRequest) {
                if (pendingMic == request) pendingMic = null
            }

            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                pendingFiles?.onReceiveValue(null)
                pendingFiles = callback
                return try {
                    val intent = params.createIntent().addCategory(Intent.CATEGORY_OPENABLE)
                    if (params.mode == FileChooserParams.MODE_OPEN_MULTIPLE) intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                    pickFiles.launch(intent)
                    true
                } catch (_: ActivityNotFoundException) {
                    pendingFiles = null
                    false
                }
            }
        }

        // Attachments: the phone's download manager, with the session so the API answers.
        web.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            if (!ServerUrl.sameOrigin(url, server)) {
                openOutside(url)
                return@setDownloadListener
            }
            val name = URLUtil.guessFileName(url, contentDisposition, mimeType)
            val request = DownloadManager.Request(url.toUri()).apply {
                setMimeType(mimeType)
                CookieManager.getInstance().getCookie(url)?.let { addRequestHeader("Cookie", it) }
                addRequestHeader("User-Agent", userAgent)
                setTitle(name)
                setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
            }
            getSystemService(DownloadManager::class.java)?.enqueue(request)
            Toast.makeText(this, getString(R.string.download_started, name), Toast.LENGTH_SHORT).show()
        }
    }

    private fun isLoopbackCallback(url: Uri): Boolean {
        val host = url.host?.lowercase()
        return (host == "localhost" || host == "127.0.0.1" || host == "[::1]") && url.port == LOOPBACK_PORT && url.path == "/callback" && url.getQueryParameter("state") != null
    }

    companion object {
        private const val PROBE_TIMEOUT_MS = 8_000
        private var shown: java.lang.ref.WeakReference<MainActivity>? = null

        /** The push token changed: the web app signs this phone up with it. */
        fun pushChanged() {
            shown?.get()?.let { activity -> activity.runOnUiThread { activity.web.evaluateJavascript("window.dispatchEvent(new Event('gond:push'))", null) } }
        }

        /** End from the call's notice: the page hangs up. False when there's no page to tell. */
        fun endCall(): Boolean {
            val activity = shown?.get() ?: return false
            activity.runOnUiThread { activity.web.evaluateJavascript("window.dispatchEvent(new Event('gond:call-end'))", null) }
            return true
        }

        /** Kept in step with MCP_LOOPBACK_PORT in packages/shared. */
        private const val LOOPBACK_PORT = 47651
    }
}
