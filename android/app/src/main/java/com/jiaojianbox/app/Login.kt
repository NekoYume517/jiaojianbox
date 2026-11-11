package com.jiaojianbox.app

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

/**
 * 登录 = OAuth Device Flow（与桌面端一致）：填服务端地址 → 拉起浏览器确认授权码 → 回来自动完成。
 * 也保留账号密码直接登录（兼容浏览器不可用的场景）。
 */
@Composable
fun LoginScreen(onLogin: (Session) -> Unit, onCancel: (() -> Unit)? = null, externalError: String = "") {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var server by rememberSaveable { mutableStateOf(DEFAULT_SERVER) }
    var customServer by rememberSaveable { mutableStateOf(false) }
    var browserBusy by remember { mutableStateOf(false) }
    var browserError by remember { mutableStateOf("") }
    var showPassword by remember { mutableStateOf(false) }
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var pwBusy by remember { mutableStateOf(false) }
    var pwError by remember { mutableStateOf("") }
    var userCode by remember { mutableStateOf("") }
    var authorization by remember { mutableStateOf<kotlinx.coroutines.Job?>(null) }
    DisposableEffect(Unit) { onDispose { authorization?.cancel() } }

    fun openBrowser(url: String) {
        runCatching {
            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }.onFailure { if(it is CancellationException)throw it; browserError = "未找到可用的浏览器应用" }
    }

    Column(
        Modifier.fillMaxSize().safeDrawingPadding().imePadding().verticalScroll(rememberScrollState()).padding(28.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(painterResource(R.drawable.ic_jiaojianbox), contentDescription = null, tint = androidx.compose.ui.graphics.Color.Unspecified, modifier = Modifier.size(64.dp))
        Spacer(Modifier.height(20.dp))
        Text("登录交件箱", style = MaterialTheme.typography.headlineLarge)
        Spacer(Modifier.height(10.dp))
        Text("同一个工作区，随身带走。", style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(8.dp))
        Text("通知、待办与文件，在手机上继续。", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(28.dp))
        if(customServer) OutlinedTextField(server, { server = it }, label = { Text("自建服务器地址") }, singleLine = true, enabled = !browserBusy, modifier = Modifier.fillMaxWidth())
        TextButton(enabled = !browserBusy, onClick = { customServer = !customServer; if(!customServer)server=DEFAULT_SERVER }) { Text(if(customServer) "使用默认服务器" else "连接其他自建服务器") }
        Spacer(Modifier.height(14.dp))

        Button(
            onClick = {
                browserBusy = true; browserError = ""
                authorization = scope.launch {
                    var resultSession: Session? = null
                    runCatching {
                        val base = server.trim().trimEnd('/')
                        val start = withContext(Dispatchers.IO) { DeviceFlow.start(base) }
                        userCode = start.userCode
                        withContext(Dispatchers.Main) { openBrowser(start.verificationUrl) }
                        val deadline = System.currentTimeMillis() + start.expiresIn * 1000L
                        while (System.currentTimeMillis() < deadline) {
                            delay(2000)
                            when (val status = withContext(Dispatchers.IO) { DeviceFlow.poll(base, start.deviceCode) }) {
                                is DeviceFlow.PollResult.Approved -> {
                                    resultSession = Session(base.trimEnd('/'), status.token, status.username, status.userId)
                                    return@runCatching
                                }
                                is DeviceFlow.PollResult.Denied -> throw IllegalStateException("授权已取消")
                                is DeviceFlow.PollResult.Expired -> throw IllegalStateException("授权已过期，请重试")
                                DeviceFlow.PollResult.Pending -> {}
                            }
                        }
                        throw IllegalStateException("授权超时，请重试")
                    }.onSuccess {
                        resultSession?.let { onLogin(it) }
                    }.onFailure { if(it is CancellationException)throw it; browserError = it.message ?: "授权失败"; browserBusy = false }
                }
            },
            enabled = !browserBusy && server.startsWith("http"),
            modifier = Modifier.fillMaxWidth(),
        ) { Text(if (browserBusy) "等待浏览器确认…" else "在浏览器中登录") }
        if (browserBusy) {
            Spacer(Modifier.height(12.dp))
            Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                LinearProgressIndicator(Modifier.fillMaxWidth())
                Text("请在浏览器中确认授权", style = MaterialTheme.typography.titleMedium)
                if (userCode.isNotBlank()) Text(userCode, style = MaterialTheme.typography.headlineSmall)
                Text("确认后返回这里，将自动进入你的工作区。", style = MaterialTheme.typography.bodySmall)
                TextButton(onClick = { authorization?.cancel(); browserBusy = false; userCode = "" }) { Text("取消本次登录") }
            } }
        }
        if (browserError.isNotBlank()) {
            Spacer(Modifier.height(6.dp))
            Text(browserError, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
        }
        Spacer(Modifier.height(14.dp))
        TextButton(onClick = { showPassword = !showPassword }) {
            Text(if (showPassword) "收起账号密码登录" else "使用账号密码登录")
        }

        if (showPassword) {
            OutlinedTextField(username, { username = it }, label = { Text("邮箱 / 原有用户名") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(10.dp))
            OutlinedTextField(password, { password = it }, label = { Text("密码") }, singleLine = true, visualTransformation = androidx.compose.ui.text.input.PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
            if (pwError.isNotBlank()) {
                Spacer(Modifier.height(8.dp))
                Text(pwError, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
            Spacer(Modifier.height(14.dp))
            Button(
                onClick = {
                    pwBusy = true; pwError = ""
                    scope.launch {
                        runCatching { JjbApi(Session(server, "", "")).login(server, username, password) }
                            .onSuccess { session -> onLogin(session) }
                            .onFailure { if(it is CancellationException)throw it; pwError = it.message ?: "登录失败" }
                        pwBusy = false
                    }
                },
                enabled = !pwBusy && server.startsWith("http") && username.length >= 3 && password.length >= 10,
                modifier = Modifier.fillMaxWidth(),
            ) { Text(if (pwBusy) "登录中…" else "登录") }
        }
        Spacer(Modifier.height(10.dp))
        TextButton(enabled = !browserBusy && !pwBusy, onClick = { onLogin(LocalWorkspace.session()) }) { Text("不连接服务器，离线使用") }
        TextButton(onClick = { openBrowser(server.trimEnd('/') + "/?forgot=1") }) { Text("忘记密码") }
        if(externalError.isNotBlank())Text(externalError,color=MaterialTheme.colorScheme.error)
        if(onCancel!=null)TextButton(onClick=onCancel){Text("返回当前工作区")}
        Text("首次使用可在浏览器中通过邮箱注册。离线数据只保存在本机。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
