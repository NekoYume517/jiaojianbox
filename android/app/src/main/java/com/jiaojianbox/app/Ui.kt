package com.jiaojianbox.app

import android.net.Uri
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
    More("提醒", Icons.Filled.Notifications),
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
    val current = sessionState
    if (current == null) {
        LoginScreen(onLogin = { session -> lifecycleDispatch { store.saveSession(session) } })
    } else {
        MainScaffold(store, current, pendingUris, onUrisConsumed, requestCalendar, onLogout = { lifecycleDispatch { store.clearSession() } })
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
    var tab by remember { mutableStateOf(Tab.Shelf) }
    val snackbar = remember { SnackbarHostState() }
    var snapshot by remember { mutableStateOf<Snapshot?>(null) }
    var busy by remember { mutableStateOf(false) }
    var calendarPickerFor by remember { mutableStateOf<Task?>(null) }

    suspend fun reload() {
        runCatching { JjbApi(session).snapshot() }
            .onSuccess { snapshot = it }
            .onFailure { snackbar.showSnackbar(it.message ?: "同步失败") }
    }

    LaunchedEffect(session) { reload() }

    // 日历自动同步：每次打开/回到前台，把云端提醒时间对齐到系统日历
    val context = LocalContext.current
    LaunchedEffect(session) {
        ReminderSync.syncOnStart(context, store)
    }
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) ReminderSync.syncOnStart(context, store)
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    // 分享/拖进来的文件：上传收纳 → 自动 AI 归类
    LaunchedEffect(pendingUris) {
        if (pendingUris.isEmpty()) return@LaunchedEffect
        val api = JjbApi(session)
        val context = store.context()
        for (uri in pendingUris) {
            runCatching {
                val bytes = context.contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: return@runCatching
                val name = queryDisplayName(context, uri) ?: "分享文件"
                busy = true
                val saved = api.uploadShelf(name, bytes)
                snackbar.showSnackbar("已收纳 $name，AI 整理中…")
                runCatching { api.analyzeShelf(saved.id) }
                reload()
            }.onFailure { snackbar.showSnackbar(it.message ?: "收纳失败") }
        }
        busy = false
        onUrisConsumed()
    }

    Scaffold(
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
            if (tab == Tab.Tasks) {
                // FAB 占位：创建任务后续接
            }
        },
    ) { padding ->
        Box(Modifier.padding(padding)) {
            when (tab) {
                Tab.Shelf -> ShelfPage(snapshot, busy)
                Tab.Tasks -> TasksPage(
                    snapshot = snapshot,
                    onStatusChange = { task, status ->
                        lifecycleDispatch {
                            runCatching { JjbApi(session).setStatus(task.id, task.raw, status) }
                                .onSuccess { reload() }
                                .onFailure { snackbar.showSnackbar(it.message ?: "更新失败") }
                        }
                    },                    onRemind = {
                        if (CalendarReminders.available(store.context())) calendarPickerFor = it
                        else requestCalendar()
                    },
                )
                Tab.Inbox -> InboxPage(snapshot)
                Tab.More -> RemindersPage(snapshot, requestCalendar, store)
            }
        }
    }

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
                                CalendarReminders.upsert(context, calendar.id, task.id, task.title, due)
                                calendarPickerFor = null
                                lifecycleDispatch { snackbar.showSnackbar("已写入日历提醒") }
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
            LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
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

@Composable
fun TasksPage(snapshot: Snapshot?, onStatusChange: (Task, String) -> Unit, onRemind: (Task) -> Unit) {
    val tasks = snapshot?.tasks.orEmpty().filter { it.status != "archived" }
    Column(Modifier.fillMaxSize().padding(16.dp)) {
        Text("交件任务", style = MaterialTheme.typography.headlineSmall)
        Spacer(Modifier.height(12.dp))
        if (tasks.isEmpty()) EmptyHint("还没有待办", "在电脑/网页端确认通知后会同步到这里")
        else LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            items(tasks, key = { it.id }) { task ->
                ElevatedCard(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(14.dp)) {
                        Text(task.title, style = MaterialTheme.typography.titleMedium)
                        if (task.description.isNotBlank()) Text(task.description, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Spacer(Modifier.height(8.dp))
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            AssistChip(onClick = {}, label = { Text(fmtDate(task.dueAt), style = MaterialTheme.typography.labelSmall) })
                            AssistChip(onClick = { onRemind(task) }, label = { Text("日历提醒", style = MaterialTheme.typography.labelSmall) }, leadingIcon = { Icon(Icons.Filled.Notifications, null, Modifier.height(16.dp)) })
                            Spacer(Modifier.weight(1f))
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
fun InboxPage(snapshot: Snapshot?) {
    val messages = snapshot?.messages.orEmpty().take(100)
    Column(Modifier.fillMaxSize().padding(16.dp)) {
        Text("通知", style = MaterialTheme.typography.headlineSmall)
        Spacer(Modifier.height(12.dp))
        if (messages.isEmpty()) EmptyHint("还没有同步的通知", "桌面端连接 QQ/微信后自动同步")
        else LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            items(messages, key = { it.id }) { message ->
                ElevatedCard(Modifier.fillMaxWidth()) {
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
    Column(Modifier.fillMaxSize().padding(16.dp)) {
        Text("定时提醒", style = MaterialTheme.typography.headlineSmall)
        Text("提醒写入系统日历：App 不在后台也准时响。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(12.dp))
        Button(onClick = requestCalendar) { Text("检查日历权限") }
        Spacer(Modifier.height(12.dp))
        if (tasks.isEmpty()) EmptyHint("没有进行中的任务", "任务创建后可一键写入日历提醒")
        else LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
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
