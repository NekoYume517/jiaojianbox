package com.jiaojianbox.app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.webkit.*
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.background
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.util.Locale

/** M3 authentication, the shared web workspace, and scoped system connectors. */
class MobileShellActivity : ComponentActivity() {
    private val store by lazy { AppStore(this) }
    private var session by mutableStateOf<Session?>(null)
    private var loaded by mutableStateOf(false)
    private var connectors by mutableStateOf(false)
    private var sharedUris by mutableStateOf<List<Uri>>(emptyList())
    private var calendars by mutableStateOf<List<CalendarReminders.CalendarInfo>>(emptyList())
    private var calendarId by mutableStateOf(-1L)
    private var autoCalendar by mutableStateOf(false)
    private var message by mutableStateOf("")
    private var progress by mutableStateOf<MobileProgress?>(null)
    private var loading by mutableStateOf(true)
    private var web: WebView? = null
    private var bridge: WebMessagePort? = null
    private var webDark by mutableStateOf<Boolean?>(null)
    private var canvasColor by mutableStateOf<Int?>(null)
    private var panelColor by mutableStateOf<Int?>(null)
    private data class WebDialog(val title: String, val text: String, val result: JsResult, val initial: String? = null)
    private var webDialog by mutableStateOf<WebDialog?>(null)
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private data class Export(val id: String, val route: String, val name: String)
    private var exporting: Export? = null
    private var calendarBusy = false
    private var lastCalendarSync = 0L
    private val chooseFile = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)); fileCallback = null
    }
    private val importFiles = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { if (it.isNotEmpty()) sharedUris = it }
    private val saveFile = registerForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { uri ->
        val request = exporting; exporting = null
        val current = session
        if (request != null && current != null) {
            if (uri == null) complete(request.id, false)
            else lifecycleScope.launch {
                runCatching { transfer(current).download(request.route, uri, request.name) }
                    .onSuccess { complete(request.id, true); message = "文件已保存" }
                    .onFailure { complete(request.id, null, it.message); message = "保存失败：${it.message}" }
            }
        }
    }
    private val calendarPermission = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        if (result.values.all { it }) loadCalendars() else message = "日历权限未开启，文件与网页功能仍可正常使用。"
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); AppContext.init(this); incoming(intent)
        androidx.core.view.WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = android.graphics.Color.TRANSPARENT
        window.navigationBarColor = android.graphics.Color.TRANSPARENT
        if (android.os.Build.VERSION.SDK_INT >= 29) window.isNavigationBarContrastEnforced = false
        if (android.os.Build.VERSION.SDK_INT >= 28) window.navigationBarDividerColor = android.graphics.Color.TRANSPARENT
        lifecycleScope.launch { session = store.session.first(); loaded = true; loadCalendars() }
        setContent {
            val dark = webDark ?: androidx.compose.foundation.isSystemInDarkTheme()
            SideEffect {
                androidx.core.view.WindowInsetsControllerCompat(window, window.decorView).apply {
                    isAppearanceLightStatusBars = !dark; isAppearanceLightNavigationBars = !dark
                }
            }
            MaterialTheme(colorScheme = if (dark) JjbTheme.dark() else JjbTheme.light()) {
                Surface(Modifier.fillMaxSize(), color = canvasColor?.let { androidx.compose.ui.graphics.Color(it) } ?: MaterialTheme.colorScheme.surface) {
                    if (!loaded) Box(Modifier.fillMaxSize(), contentAlignment = androidx.compose.ui.Alignment.Center) { CircularProgressIndicator() }
                    else if (session == null) LoginScreen(onLogin = { current -> lifecycleScope.launch { store.saveSession(current); session = current; loadCalendars() } })
                    else if (session!!.offline) {
                        // Retain existing offline storage and export while the online workspace moves to WebView.
                        MainScaffold(store, session!!, sharedUris, { sharedUris = emptyList() }, { requestCalendar() }, { logout() })
                    } else Workspace()
                }
                webDialog?.let { dialog ->
                    var input by remember(dialog) { mutableStateOf(dialog.initial.orEmpty()) }
                    AlertDialog(onDismissRequest = { dialog.result.cancel(); webDialog = null },
                        title = { Text(dialog.title) },
                        text = { Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) { Text(dialog.text); if (dialog.initial != null) OutlinedTextField(input, { input = it }, modifier = Modifier.fillMaxWidth()) } },
                        confirmButton = { TextButton(onClick = { if (dialog.result is JsPromptResult) dialog.result.confirm(input) else dialog.result.confirm(); webDialog = null }) { Text("确定") } },
                        dismissButton = { TextButton(onClick = { dialog.result.cancel(); webDialog = null }) { Text("取消") } })
                }
            }
        }
    }
    @OptIn(ExperimentalMaterial3Api::class)
    @Composable private fun Workspace() {
        val current = session ?: return
        BackHandler { web?.evaluateJavascript("(()=>{const d=document.querySelector('dialog[open]');if(d){uiMotion.closeDialog(d);return;}if(typeof state!=='undefined'&&state.taskId){state.taskId=null;render();return;}if(history.length>1)history.back();})()", null) }
        Column(Modifier.fillMaxSize()
            .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal))
            .background(panelColor?.let { androidx.compose.ui.graphics.Color(it) } ?: MaterialTheme.colorScheme.surface)
            .windowInsetsPadding(WindowInsets.navigationBars.only(WindowInsetsSides.Bottom)).imePadding()) {
            if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
            if (message.isNotBlank()) Surface(color = MaterialTheme.colorScheme.secondaryContainer) {
                Row(Modifier.fillMaxWidth().padding(start = 16.dp), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                    Text(message, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                    TextButton(onClick = { message = "" }) { Text("关闭") }
                }
            }
            key(current.server, current.token) { AndroidView(modifier = Modifier.weight(1f).fillMaxWidth(), factory = { createWebView(current) }) }
            progress?.let { transfer -> Surface(tonalElevation = 3.dp) {
                Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(transfer.title, style = MaterialTheme.typography.labelLarge, maxLines = 1)
                    if (transfer.total > 0) LinearProgressIndicator(progress = { (transfer.transferred.toFloat() / transfer.total).coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth())
                    else LinearProgressIndicator(Modifier.fillMaxWidth())
                    Text("${bytes(transfer.transferred)} / ${if (transfer.total >= 0) bytes(transfer.total) else "未知大小"} · ${bytes(transfer.speed)}/s", style = MaterialTheme.typography.bodySmall)
                }
            } }
        }
        LaunchedEffect(sharedUris) { if (sharedUris.isNotEmpty()) connectors = true }
        if (connectors) ModalBottomSheet(onDismissRequest = { connectors = false }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
            Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                Text("手机连接器", style = MaterialTheme.typography.headlineSmall)
                Text("网页工作区，连接手机上的文件与日历。", color = MaterialTheme.colorScheme.onSurfaceVariant)
                HorizontalDivider(); Text("文件", style = MaterialTheme.typography.titleMedium)
                Text(if (sharedUris.isEmpty()) "可接收其他应用分享的文件，也可以从系统文件管理器选择。" else "${sharedUris.size} 个文件等待导入")
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { importFiles.launch(arrayOf("*/*")) }, enabled = progress == null) { Text("选择文件") }
                    Button(onClick = { uploadShared(current) }, enabled = sharedUris.isNotEmpty() && progress == null) { Text("导入交件箱") }
                }
                HorizontalDivider(); Text("系统日历", style = MaterialTheme.typography.titleMedium)
                Text("把待办截止时间和提醒写入所选日历。已提交、归档的待办会移除交件箱创建的事件。")
                if (!hasCalendarPermission()) OutlinedButton(onClick = { requestCalendar() }) { Text("连接系统日历") }
                else if (calendars.isEmpty()) Text("未找到可写入日历，请先在系统日历中添加账户。")
                for (calendar in calendars) Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                    RadioButton(selected = calendarId == calendar.id, onClick = { calendarId = calendar.id; ShellCalendar(this@MobileShellActivity, current).calendarId = calendar.id }); Text(calendar.name)
                }
                Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                    Text("在工作区更新时同步", Modifier.weight(1f))
                    Switch(checked = autoCalendar, onCheckedChange = { autoCalendar = it; ShellCalendar(this@MobileShellActivity, current).enabled = it }, enabled = calendarId >= 0 && hasCalendarPermission())
                }
                Button(onClick = { syncCalendar(current, null, false) }, enabled = calendarId >= 0 && hasCalendarPermission()) { Text("同步待办到日历") }
                Text("文件保存在系统选择的位置；日历同步仅在应用运行时执行。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.height(16.dp))
            }
        }
    }
    @Suppress("SetJavaScriptEnabled") private fun createWebView(current: Session): WebView = WebView(this).also { view ->
        WebView.setWebContentsDebuggingEnabled(applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0)
        web = view; view.setBackgroundColor(android.graphics.Color.TRANSPARENT)
        view.settings.apply { javaScriptEnabled = true; domStorageEnabled = true; allowFileAccess = false; allowContentAccess = true; mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW; setSupportMultipleWindows(false) }
        view.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                if (!trusted(request.url, current) || request.method != "GET") return null
                val path = request.url.path.orEmpty().removePrefix("/").ifEmpty { "index.html" }
                if (path.contains("..") || path.contains("\\") || path.startsWith("api/")) return null
                return runCatching {
                    val data = assets.open("web/$path").readBytes()
                    val mime = when (path.substringAfterLast('.')) { "html" -> "text/html"; "js" -> "application/javascript"; "css" -> "text/css"; "svg" -> "image/svg+xml"; "png" -> "image/png"; else -> "application/octet-stream" }
                    val sessionJson = JSONObject().put("server", current.server).put("token", current.token).put("username", current.username).put("user_id", current.userId.ifBlank { current.username }).toString().replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
                    val bytes = if (path == "index.html") String(data, Charsets.UTF_8).replace("<head>", "<head><script>window.__JJB_ANDROID__=true;window.__JJB_SESSION__=$sessionJson;</script>").toByteArray() else data
                    WebResourceResponse(mime, "utf-8", ByteArrayInputStream(bytes)).apply { responseHeaders = mapOf("Cache-Control" to "no-store") }
                }.getOrNull()
            }
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (!request.isForMainFrame || trusted(request.url, current)) return false
                if (request.url.scheme in listOf("https", "http", "mailto")) runCatching { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
                return true
            }
            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) { bridge?.close(); bridge = null; loading = true }
            override fun onPageFinished(view: WebView, url: String) {
                loading = false
                if (!trusted(Uri.parse(url), current)) return
                bridge?.close()
                val ports = view.createWebMessageChannel(); bridge = ports[0]
                ports[0].setWebMessageCallback(object : WebMessagePort.WebMessageCallback() {
                    override fun onMessage(port: WebMessagePort, msg: WebMessage) {
                        if (bridge !== port || session?.token != current.token) return
                        runCatching { JSONObject(msg.data.orEmpty()) }.onSuccess { handleBridge(current, it) }
                    }
                })
                val origin = Uri.parse(current.server).buildUpon().path("").query(null).fragment(null).build()
                view.postWebMessage(WebMessage("jjb-bridge", arrayOf(ports[1])), origin)
            }
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) { if (request.isForMainFrame) { loading = false; message = "页面加载失败：${error.description}" } }
        }
        view.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null); fileCallback = callback
                val types = params.acceptTypes.flatMap { it.split(',') }.filter { it.contains('/') }.distinct()
                val picker = Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(types.singleOrNull() ?: "*/*")
                    .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.mode == FileChooserParams.MODE_OPEN_MULTIPLE).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                if (types.size > 1) picker.putExtra(Intent.EXTRA_MIME_TYPES, types.toTypedArray())
                return try { chooseFile.launch(picker); true } catch (_: Exception) { fileCallback?.onReceiveValue(null); fileCallback = null; false }
            }
            override fun onJsPrompt(view: WebView, url: String, text: String, defaultValue: String?, result: JsPromptResult): Boolean {
                if (!trusted(Uri.parse(url), current) || !trusted(Uri.parse(view.url.orEmpty()), current)) { result.cancel(); return true }
                webDialog?.result?.cancel(); webDialog = WebDialog("填写信息", text, result, defaultValue.orEmpty()); return true
            }
            override fun onJsAlert(view: WebView, url: String, text: String, result: JsResult): Boolean { webDialog?.result?.cancel(); webDialog = WebDialog("提示", text, result); return true }
            override fun onJsConfirm(view: WebView, url: String, text: String, result: JsResult): Boolean { webDialog?.result?.cancel(); webDialog = WebDialog("确认操作", text, result); return true }
        }
        view.loadUrl(current.server.trimEnd('/') + "/")
    }
    private fun trusted(uri: Uri, current: Session): Boolean { val base = Uri.parse(current.server); return uri.scheme == base.scheme && uri.host == base.host && uri.port == base.port }
    private fun complete(id: String, value: Any? = true, error: String? = null) {
        val response = JSONObject().put("id", id).put("value", value ?: JSONObject.NULL).put("error", error ?: JSONObject.NULL)
        bridge?.postMessage(WebMessage(response.toString()))
    }
    private fun handleBridge(current: Session, request: JSONObject) {
        val id = request.optString("id"); val payload = request.optJSONObject("payload") ?: JSONObject()
        when (request.optString("method")) {
            "appearance" -> {
                fun color(key: String): Int? = runCatching {
                    var hex = payload.optString(key)
                    if (Regex("#[0-9a-fA-F]{3}").matches(hex)) hex = "#" + hex.drop(1).map { "$it$it" }.joinToString("")
                    android.graphics.Color.parseColor(hex)
                }.getOrNull()
                canvasColor = color("canvas"); panelColor = color("panel"); webDark = payload.optBoolean("dark"); complete(id)
            }
            "connectors" -> { connectors = true; complete(id) }
            "logout" -> { complete(id); logout() }
            "download" -> {
                if (exporting != null) { complete(id, null, "另一个保存操作尚未结束"); return }
                val route = payload.optString("route")
                if (!route.startsWith("/api/")) { complete(id, null, "不支持此下载地址"); return }
                exporting = Export(id, route, payload.optString("name", "交件箱文件").replace(Regex("[\\\\/:*?\"<>|]"), "_").take(180)); saveFile.launch(exporting!!.name)
            }
            "calendarTask" -> { val task = payload.optString("taskId").takeIf { it.isNotBlank() && it != "null" }; if (task == null) complete(id, null, "请先打开一项待办") else { syncCalendar(current, task, false); complete(id) } }
            "calendarRefresh" -> { if (autoCalendar && System.currentTimeMillis() - lastCalendarSync > 30000) syncCalendar(current, null, true); complete(id) }
            else -> complete(id, null, "不支持的手机连接器操作")
        }
    }
    private fun transfer(current: Session) = MobileTransfer(this, current) { value -> runOnUiThread { progress = value } }
    private fun uploadShared(current: Session) {
        val files = sharedUris
        lifecycleScope.launch { runCatching { transfer(current).upload(files) }.onSuccess { sharedUris = emptyList(); connectors = false; message = "已导入 ${files.size} 个文件"; web?.evaluateJavascript("dispatchEvent(new Event('mobile-files-imported'))", null) }.onFailure { message = "导入失败：${it.message}" } }
    }
    private fun hasCalendarPermission() = checkSelfPermission(Manifest.permission.READ_CALENDAR) == PackageManager.PERMISSION_GRANTED && checkSelfPermission(Manifest.permission.WRITE_CALENDAR) == PackageManager.PERMISSION_GRANTED
    private fun requestCalendar() = calendarPermission.launch(arrayOf(Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR))
    private fun loadCalendars() {
        val current = session ?: return
        if (current.offline || !hasCalendarPermission()) return
        lifecycleScope.launch { runCatching { withContext(Dispatchers.IO) { ShellCalendar(this@MobileShellActivity, current).let { Triple(it.calendars(), it.calendarId, it.enabled) } } }.onSuccess { calendars = it.first; calendarId = it.second; autoCalendar = it.third }.onFailure { message = "读取日历失败：${it.message}" } }
    }
    private fun syncCalendar(current: Session, taskId: String?, quiet: Boolean) {
        if (calendarBusy) return
        if (!hasCalendarPermission() || calendarId < 0) { if (!quiet) { connectors = true; message = "请先连接并选择系统日历，再点击同步。" }; return }
        calendarBusy = true; lastCalendarSync = System.currentTimeMillis()
        lifecycleScope.launch {
            try { val tasks = JjbApi(current).snapshot().tasks; val count = withContext(Dispatchers.IO) { ShellCalendar(this@MobileShellActivity, current).sync(tasks, taskId) }; if (!quiet) message = "已同步 $count 项待办到系统日历" }
            catch (error: Exception) { if (!quiet) message = "日历同步失败：${error.message}" }
            finally { calendarBusy = false }
        }
    }
    private fun logout() { lifecycleScope.launch { store.clearSession(); bridge?.close(); bridge = null; web?.stopLoading(); web?.destroy(); web = null; session = null; connectors = false; message = ""; webDark = null; canvasColor = null; panelColor = null } }
    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); incoming(intent) }
    @Suppress("DEPRECATION") private fun incoming(intent: Intent?) {
        val uris = when (intent?.action) { Intent.ACTION_SEND -> listOfNotNull(intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)); Intent.ACTION_SEND_MULTIPLE -> intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM).orEmpty(); Intent.ACTION_VIEW -> listOfNotNull(intent.data); else -> emptyList() }
        sharedUris = (sharedUris + uris.filter { it.scheme == "content" }).distinct()
    }
    override fun onDestroy() { webDialog?.result?.cancel(); bridge?.close(); bridge = null; fileCallback?.onReceiveValue(null); fileCallback = null; web?.destroy(); web = null; super.onDestroy() }
    private fun bytes(value: Long): String = when { value >= 1024 * 1024 -> String.format(Locale.ROOT, "%.1f MB", value / 1048576.0); value >= 1024 -> String.format(Locale.ROOT, "%.1f KB", value / 1024.0); else -> "$value B" }
}
