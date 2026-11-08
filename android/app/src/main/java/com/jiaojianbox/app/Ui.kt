package com.jiaojianbox.app

import android.net.Uri
import kotlinx.coroutines.launch
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.CancellationException
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.compose.BackHandler
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.Inbox
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.clickable
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.compose.ui.platform.LocalLifecycleOwner
import java.time.format.DateTimeFormatter
import java.time.ZonedDateTime
import java.time.format.FormatStyle

private val cnDate: DateTimeFormatter = DateTimeFormatter.ofPattern("MM/dd HH:mm")

private fun fmtDate(iso: String?): String = runCatching {
    ZonedDateTime.parse(iso).format(cnDate)
}.getOrDefault("未设置")

enum class Tab(val label: String, val icon: ImageVector) {
    Shelf("收纳", Icons.Filled.Inbox),
    Tasks("待办", Icons.Filled.CheckCircle),
    Inbox("通知", Icons.Filled.MailOutline),
    More("我的", Icons.Filled.Person),
}

/** 根路由：未登录 → 登录页；已登录 → 主脚手架。 */
@Composable
fun JjbApp(
    store: AppStore,
    pendingUris: List<Uri>,
    onUrisConsumed: () -> Unit,
    requestCalendar: () -> Unit,
) {
    val session by store.session.collectAsState(initial = null)
    var sessionState by remember { mutableStateOf<Session?>(null) }
    var loaded by remember { mutableStateOf(false) }
    LaunchedEffect(session) { sessionState = session; loaded = true }
    if (!loaded) return
    val scope = rememberCoroutineScope()
    val current = sessionState
    if (current == null) {
        LoginScreen(onLogin = { session -> scope.launch { store.saveSession(session) } })
    } else {
        key(current.token, current.server) { MainScaffold(store, current, pendingUris, onUrisConsumed, requestCalendar, onLogout = { scope.launch { store.clearSession() } }) }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MainScaffold(
    store: AppStore,
    session: Session,
    pendingUris: List<Uri>,
    onUrisConsumed: () -> Unit,
    requestCalendar: () -> Unit,
    onLogout: () -> Unit,
) {
    var tab by rememberSaveable { mutableStateOf(Tab.Tasks) }
    val scope = rememberCoroutineScope()
    var selectedTask by remember { mutableStateOf<Task?>(null) }
    var selectedMessage by remember { mutableStateOf<Message?>(null) }
    var creating by rememberSaveable { mutableStateOf(false) }
    var title by rememberSaveable { mutableStateOf("") }
    var description by rememberSaveable { mutableStateOf("") }
    var localUris by remember { mutableStateOf<List<Uri>>(emptyList()) }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { localUris = it }
    BackHandler(tab != Tab.Tasks) { tab = Tab.Tasks }

    val snackbar = remember { SnackbarHostState() }
    var snapshot by remember { mutableStateOf<Snapshot?>(null) }
    var busy by remember { mutableStateOf(false) }
    var connecting by remember { mutableStateOf(false) }
    var uploadOnConnect by remember { mutableStateOf(false) }
    var connectionError by remember { mutableStateOf("") }
    var accountDialog by remember { mutableStateOf(false) }
    var displayName by remember { mutableStateOf(session.username) }
    var calendarPickerFor by remember { mutableStateOf<Task?>(null) }

    suspend fun reload() {
        if(!session.offline) runCatching {JjbApi(session).account("/api/auth/me")}.onSuccess {displayName=it.optString("nickname",session.username)}.onFailure {if(it is CancellationException)throw it}
        runCatching { JjbApi(session).snapshot() }
            .onSuccess { snapshot = it }
            .onFailure { if(it is CancellationException)throw it; snackbar.showSnackbar(it.message ?: "同步失败") }
    }

    LaunchedEffect(session) { reload() }

    // 日历自动同步：每次打开/回到前台，把云端提醒时间对齐到系统日历
    val context = LocalContext.current
    LaunchedEffect(session) {
        ReminderSync.syncOnStart(context, store)
    }
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner, session) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) { ReminderSync.syncOnStart(context, store); scope.launch { reload() } }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    // 分享/拖进来的文件：上传收纳 → 自动 AI 归类
    LaunchedEffect(pendingUris, localUris) {
        val incoming = (pendingUris + localUris).distinct()
        if (incoming.isEmpty()) return@LaunchedEffect
        tab = Tab.Shelf
        val api = JjbApi(session)
        val context = store.context()
        for (uri in incoming) {
            runCatching {
                val bytes = withContext(Dispatchers.IO) { context.contentResolver.openInputStream(uri)?.use {
                    val data = java.io.ByteArrayOutputStream().use { output ->
                        val buffer = ByteArray(8192); var total = 0
                        while (true) { val count = it.read(buffer); if (count < 0) break; total += count; require(total <= 50 * 1024 * 1024) { "文件不能超过 50MB" }; output.write(buffer,0,count) }; output.toByteArray() }
                    require(data.size <= 50 * 1024 * 1024) { "文件不能超过 50MB" }; data
                } ?: error("无法读取文件") }
                val name = queryDisplayName(context, uri) ?: "分享文件"
                busy = true
                val saved = api.uploadShelf(name, bytes)
                snackbar.showSnackbar("已收纳 $name，AI 整理中…")
                runCatching { api.analyzeShelf(saved.id) }.onFailure { if(it is CancellationException)throw it; snackbar.showSnackbar("文件已保存，AI 整理失败：${it.message}") }
                reload()
            }.onFailure { if(it is CancellationException)throw it; snackbar.showSnackbar(it.message ?: "收纳失败") }
        }
        busy = false
        localUris = emptyList()
        onUrisConsumed()
    }

    if(connecting) {
        LoginScreen(onLogin={ target -> scope.launch {
            busy=true
            try {
                if(uploadOnConnect && !target.offline) withContext(Dispatchers.IO) { val archive=LocalWorkspace.exportZip();try{JjbApi(target).importWorkspace(archive)}finally{archive.delete()} }
                store.saveSession(target)
            } catch(e:Exception){if(e is CancellationException)throw e;connectionError="连接或导入未完成，本机数据已保留："+(e.message?:"")}
            finally{busy=false}
        }},onCancel={connecting=false},externalError=connectionError)
        return
    }
    if(accountDialog) AccountDialog(session,onDismiss={accountDialog=false;scope.launch{reload()}},onPasswordChanged=onLogout)
    Scaffold(
        topBar = { CenterAlignedTopAppBar(title = { Text(tab.label) }, actions = {
            IconButton(onClick = { scope.launch { reload() } }, enabled = !busy) { Icon(Icons.Filled.Refresh,"刷新") }
        }) },
        snackbarHost = { SnackbarHost(snackbar) },
        bottomBar = {
            NavigationBar {
                Tab.entries.forEach { entry ->
                    NavigationBarItem(
                        selected = tab == entry,
                        onClick = { tab = entry },
                        icon = { Icon(entry.icon, contentDescription = entry.label) },
                        label = { Text(entry.label) },
                    )
                }
            }
        },
        floatingActionButton = {
            if (tab == Tab.Tasks || tab == Tab.Shelf) ExtendedFloatingActionButton(
                onClick = { if(tab == Tab.Tasks) creating=true else picker.launch(arrayOf("*/*")) },
                icon = { Icon(Icons.Filled.Add,null) }, text = { Text(if(tab==Tab.Tasks) "新建待办" else "收纳文件") })
        },
    ) { padding ->
        Box(Modifier.padding(padding)) {
            when (tab) {
                Tab.Shelf -> ShelfPage(snapshot, busy)
                Tab.Tasks -> TasksPage(
                    snapshot = snapshot,
                    onOpen = { selectedTask = it },
                    onStatusChange = { task, status ->
                        scope.launch {
                            runCatching { JjbApi(session).setStatus(task.id, task.raw, status) }
                                .onSuccess { reload() }
                                .onFailure { if(it is CancellationException)throw it; snackbar.showSnackbar(it.message ?: "更新失败") }
                        }
                    },                    onRemind = {
                        if (CalendarReminders.available(store.context())) calendarPickerFor = it
                        else requestCalendar()
                    },
                )
                Tab.Inbox -> InboxPage(snapshot) { selectedMessage = it }
                Tab.More -> Column(Modifier.fillMaxSize().verticalScroll(androidx.compose.foundation.rememberScrollState()).padding(16.dp)) {
                    ListItem(headlineContent={Text(displayName)}, supportingContent={Text(if(session.offline) "离线使用 · 数据仅存本机" else "已连接服务器")}, leadingContent={Icon(Icons.Filled.AccountCircle,null)})
                    HorizontalDivider()
                    if(!session.offline) {
                        ListItem(headlineContent={Text("账号资料")},supportingContent={Text("昵称、邮箱和密码")},modifier=Modifier.clickable{accountDialog=true},trailingContent={Icon(Icons.Filled.ChevronRight,null)})
                        ListItem(headlineContent={Text("复制到本机并离线使用")},supportingContent={Text("包括附件，云端数据保留")},modifier=Modifier.clickable(enabled=!busy){scope.launch {
                            busy=true
                            try {val data=JjbApi(session).exportWorkspace();try{withContext(Dispatchers.IO){LocalWorkspace.importZip(data)}}finally{data.delete()};store.saveSession(LocalWorkspace.session())}
                            catch(e:Exception){if(e is CancellationException)throw e;snackbar.showSnackbar(e.message?:"复制失败，云端数据保持不变")}
                            finally{busy=false}
                        }})
                    } else {
                        ListItem(headlineContent={Text("连接服务器并上传本地数据")},supportingContent={Text("登录后复制导入，本机数据保留")},modifier=Modifier.clickable{uploadOnConnect=true;connecting=true})
                    }
                    ListItem(headlineContent={Text("切换连接方式")},supportingContent={Text("默认云端、自建服务器或离线")},modifier=Modifier.clickable{uploadOnConnect=false;connecting=true})
                    ListItem(headlineContent={Text("日历提醒")}, supportingContent={Text("授权后可将截止时间写入系统日历")}, modifier=Modifier.clickable(onClick=requestCalendar), trailingContent={Icon(Icons.Filled.ChevronRight,null)})
                    ListItem(headlineContent={Text("外观")}, supportingContent={Text("跟随系统深浅色模式")})
                    TextButton(onClick=onLogout) { Text("退出登录") }
                }
            }
        }
    }

    if(creating) AlertDialog(onDismissRequest={if(!busy)creating=false}, title={Text("新建待办")}, text={Column {
        OutlinedTextField(title,{title=it},label={Text("任务名称")},singleLine=true)
        Spacer(Modifier.height(12.dp));OutlinedTextField(description,{description=it},label={Text("说明")},minLines=3)
    }}, confirmButton={TextButton(enabled=!busy && title.isNotBlank() && title.length<=200,onClick={scope.launch {
        busy=true
        try { JjbApi(session).createTask(title.trim(),description);creating=false;title="";description="";reload() }
        catch(e:Exception){if(e is CancellationException)throw e;snackbar.showSnackbar(e.message?:"创建失败")}
        finally {busy=false}
    }}){Text("创建")}},dismissButton={TextButton(onClick={creating=false},enabled=!busy){Text("取消")}})
    selectedMessage?.let { message -> ModalBottomSheet(onDismissRequest={selectedMessage=null}) {
        Column(Modifier.fillMaxWidth().padding(24.dp).verticalScroll(androidx.compose.foundation.rememberScrollState())) {
            Text(message.conversationName,style=MaterialTheme.typography.titleLarge);Text(fmtDate(message.sentAt),style=MaterialTheme.typography.labelMedium)
            Spacer(Modifier.height(16.dp));Text(message.text);Spacer(Modifier.height(32.dp))
        }
    } }
    selectedTask?.let { task -> ModalBottomSheet(onDismissRequest={selectedTask=null}) {
        Column(Modifier.fillMaxWidth().padding(24.dp).verticalScroll(androidx.compose.foundation.rememberScrollState())) {
            Text(task.title,style=MaterialTheme.typography.headlineSmall);Text("截止 "+fmtDate(task.dueAt),style=MaterialTheme.typography.labelLarge)
            Spacer(Modifier.height(16.dp));Text(task.description.ifBlank {"暂无说明"});Spacer(Modifier.height(16.dp))
            Text("${task.materialCount} 份材料",style=MaterialTheme.typography.titleMedium)
            val attachments=task.raw.optJSONArray("attachments")
            if(attachments!=null) for(i in 0 until attachments.length()) Text(attachments.getJSONObject(i).optString("name"),Modifier.padding(vertical=8.dp))
            FilledTonalButton(onClick={selectedTask=null; if(task.dueAt!=null)calendarPickerFor=task else scope.launch {snackbar.showSnackbar("请先设置截止时间")}}){Text("设置日历提醒")}
            Spacer(Modifier.height(32.dp))
        }
    } }
    calendarPickerFor?.let { task ->
        val context = store.context()
        val calendars = remember(task) { CalendarReminders.list(context) }
        AlertDialog(
            onDismissRequest = { calendarPickerFor = null },
            title = { Text("写入系统日历提醒") },
            text = {
                Column {
                    Text("「${task.title}」的截止提醒将写入你选择的日历，由系统日历准时提醒。", style = MaterialTheme.typography.bodyMedium)
                    Spacer(Modifier.height(12.dp))
                    calendars.forEach { calendar ->
                        ListItem(
                            headlineContent = { Text(calendar.name) },
                            modifier = Modifier.clickable {
                                val due = task.dueAt?.let { runCatching { ZonedDateTime.parse(it).toInstant().toEpochMilli() }.getOrNull() }
                                    ?: return@clickable
                                val eventId = CalendarReminders.upsert(context, calendar.id, task.id, task.title, due)
                                calendarPickerFor = null
                                scope.launch { snackbar.showSnackbar(if(eventId!=null) "已写入日历提醒" else "写入失败，请检查日历权限和账户") }
                            },
                        )
                    }
                    if (calendars.isEmpty()) Text("未找到可用日历账户，请先在系统日历中添加账户。", style = MaterialTheme.typography.bodySmall)
                }
            },
            confirmButton = { TextButton(onClick = { calendarPickerFor = null }) { Text("取消") } },
        )
    }
}

@Composable
fun ShelfPage(snapshot: Snapshot?, busy: Boolean) {
    val files = snapshot?.shelf.orEmpty()
    Column(Modifier.fillMaxSize().padding(16.dp)) {
        Text("文件收纳", style = MaterialTheme.typography.headlineSmall)
        Text("从文件管理器分享或拖入文件，AI 按内容归到待办。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(12.dp))
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        if (files.isEmpty()) {
            EmptyHint("还没有收纳的文件", "在文件管理器里选中文件 → 分享 → 交件箱")
        } else {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp),contentPadding=PaddingValues(bottom=96.dp)) {
                items(files, key = { it.id }) { file ->
                    ElevatedCard(Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(14.dp)) {
                            Text(file.name, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(
                                text = file.taskId?.let { "已归入待办 · ${if (file.kind == "receipt") "提交回执" else "任务材料"}" } ?: file.reason ?: "待整理",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun TasksPage(snapshot: Snapshot?, onOpen: (Task) -> Unit, onStatusChange: (Task, String) -> Unit, onRemind: (Task) -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    var filter by rememberSaveable { mutableStateOf("active") }
    val tasks = snapshot?.tasks.orEmpty().filter { (if(filter=="archived") it.status=="archived" else if(filter=="submitted") it.status=="submitted" else it.status in listOf("collecting","ready")) && (it.title+it.description).contains(query,true) }
    Column(Modifier.fillMaxSize().padding(16.dp)) {
        OutlinedTextField(query,{query=it},modifier=Modifier.fillMaxWidth(),singleLine=true,placeholder={Text("搜索待办")},leadingIcon={Icon(Icons.Filled.Search,null)})
        FlowRow(horizontalArrangement=Arrangement.spacedBy(8.dp)) {
            listOf("active" to "进行中","submitted" to "已提交","archived" to "已归档").forEach { (value,label) -> FilterChip(selected=filter==value,onClick={filter=value},label={Text(label)}) }
        }
        Spacer(Modifier.height(12.dp))
        if (tasks.isEmpty()) EmptyHint("还没有待办", "在电脑/网页端确认通知后会同步到这里")
        else LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp),contentPadding=PaddingValues(bottom=96.dp)) {
            items(tasks, key = { it.id }) { task ->
                ElevatedCard(onClick={onOpen(task)},modifier=Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(14.dp)) {
                        Text(task.title, style = MaterialTheme.typography.titleMedium)
                        if (task.description.isNotBlank()) Text(task.description, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Spacer(Modifier.height(8.dp))
                        FlowRow(verticalArrangement=Arrangement.Center, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            AssistChip(onClick = {}, label = { Text(fmtDate(task.dueAt), style = MaterialTheme.typography.labelSmall) })
                            AssistChip(onClick = { if(task.dueAt!=null)onRemind(task) }, enabled=task.dueAt!=null, label = { Text("日历提醒", style = MaterialTheme.typography.labelSmall) }, leadingIcon = { Icon(Icons.Filled.Notifications, null, Modifier.height(16.dp)) })

                            Text("${task.materialCount} 份材料", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        Spacer(Modifier.height(8.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            listOf("collecting" to "备料", "ready" to "待提交", "submitted" to "已交").forEach { (status, label) ->
                                FilterChip(
                                    selected = task.status == status,
                                    onClick = { if (task.status != status) onStatusChange(task, status) },
                                    label = { Text(label) },
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun InboxPage(snapshot: Snapshot?, onOpen: (Message) -> Unit) {
    val messages = snapshot?.messages.orEmpty().take(100)
    Column(Modifier.fillMaxSize().padding(16.dp)) {
        Text("来自你在电脑端选择的聊天", style = MaterialTheme.typography.bodyMedium,color=MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(12.dp))
        if (messages.isEmpty()) EmptyHint("还没有同步的通知", "桌面端连接 QQ/微信后自动同步")
        else LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp),contentPadding=PaddingValues(bottom=96.dp)) {
            items(messages, key = { it.id }) { message ->
                ElevatedCard(onClick={onOpen(message)},modifier=Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(14.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(message.conversationName, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(fmtDate(message.sentAt), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        Spacer(Modifier.height(6.dp))
                        Text(message.text, style = MaterialTheme.typography.bodySmall, maxLines = 3, overflow = TextOverflow.Ellipsis)
                        message.classification?.let {
                            Spacer(Modifier.height(8.dp))
                            when (it) {
                                "actionable" -> AssistChip(onClick = {}, label = { Text("交件通知") })
                                "chatting" -> AssistChip(onClick = {}, label = { Text("普通聊天") })
                                else -> AssistChip(onClick = {}, label = { Text("其他信息") })
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun RemindersPage(snapshot: Snapshot?, requestCalendar: () -> Unit, store: AppStore) {
    val tasks = snapshot?.tasks.orEmpty().filter { it.status == "collecting" || it.status == "ready" }
    val context = LocalContext.current
    var updateText by remember { mutableStateOf("") }
    var checking by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize().padding(16.dp)) {
        Text("定时提醒", style = MaterialTheme.typography.headlineSmall)
        Text("提醒写入系统日历：App 不在后台也准时响。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(12.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Button(onClick = requestCalendar) { Text("检查日历权限") }
            OutlinedButton(enabled = !checking, onClick = {
                checking = true; updateText = "检查中…"
                lifecycleDispatch {
                    runCatching { Updater.check("0.1.0") }
                        .onSuccess { result -> updateText = if (result.updatable) "发现新版本 v${result.latest}，请在浏览器打开更新" else "已是最新版本" }
                        .onFailure { updateText = it.message ?: "检查失败" }
                    checking = false
                }
            }) { Text(if (checking) "检查中…" else "检查更新") }
        }
        if (updateText.isNotBlank()) {
            Spacer(Modifier.height(8.dp))
            Text(updateText, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Spacer(Modifier.height(12.dp))
        if (tasks.isEmpty()) EmptyHint("没有进行中的任务", "任务创建后可一键写入日历提醒")
        else LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp),contentPadding=PaddingValues(bottom=96.dp)) {
            items(tasks, key = { it.id }) { task ->
                ElevatedCard(Modifier.fillMaxWidth()) {
                    Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(task.title, style = MaterialTheme.typography.titleSmall)
                            Text("截止 " + fmtDate(task.dueAt), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        FilledTonalIconButton(onClick = { requestCalendar(); }) { Icon(Icons.Filled.Alarm, contentDescription = "提醒") }
                    }
                }
            }
        }
    }
}

@Composable
fun EmptyHint(title: String, body: String) {
    Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
        Column(Modifier.padding(22.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(Icons.Outlined.Inbox, null, tint = MaterialTheme.colorScheme.primary)
            Spacer(Modifier.height(8.dp))
            Text(title, style = MaterialTheme.typography.titleSmall)
            Text(body, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        }
    }
}
