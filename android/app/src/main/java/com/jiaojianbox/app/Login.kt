package com.jiaojianbox.app

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

/**
 * 登录 = OAuth Device Flow（与桌面端一致）：填服务端地址 → 拉起浏览器确认授权码 → 回来自动完成。
 * 也保留账号密码直接登录（兼容浏览器不可用的场景）。
 */
@Composable
fun LoginScreen(onLogin: (Session) -> Unit) {
    val context = LocalContext.current
    var server by remember { mutableStateOf("http://") }
    var browserBusy by remember { mutableStateOf(false) }
    var browserError by remember { mutableStateOf("") }
    var showPassword by remember { mutableStateOf(false) }
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var pwBusy by remember { mutableStateOf(false) }
    var pwError by remember { mutableStateOf("") }

    fun openBrowser(url: String) {
        runCatching {
            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }.onFailure { browserError = "未找到可用的浏览器应用" }
    }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(28.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("交件箱", style = MaterialTheme.typography.headlineLarge, color = MaterialTheme.colorScheme.primary)
        Text("消息很多，要交的事一件不漏。", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(28.dp))
        OutlinedTextField(server, { server = it }, label = { Text("服务端地址") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        Spacer(Modifier.height(14.dp))

        Button(
            onClick = {
                browserBusy = true; browserError = ""
                lifecycleDispatch {
                    var resultSession: Session? = null
                    runCatching {
                        val base = server.trim().trimEnd('/')
                        val start = DeviceFlow.start(base)
                        withContext(Dispatchers.Main) { openBrowser(start.verificationUrl) }
                        val deadline = System.currentTimeMillis() + start.expiresIn * 1000L
                        while (System.currentTimeMillis() < deadline) {
                            delay(2000)
                            when (val status = DeviceFlow.poll(base, start.deviceCode)) {
                                is DeviceFlow.PollResult.Approved -> {
                                    resultSession = Session(base.trimEnd('/'), status.token, status.username)
                                    return@lifecycleDispatch
                                }
                                is DeviceFlow.PollResult.Denied -> throw IllegalStateException("授权已取消")
                                is DeviceFlow.PollResult.Expired -> throw IllegalStateException("授权已过期，请重试")
                                DeviceFlow.PollResult.Pending -> {}
                            }
                        }
                        throw IllegalStateException("授权超时，请重试")
                    }.onSuccess {
                        resultSession?.let { onLogin(it) }
                    }.onFailure { browserError = it.message ?: "授权失败"; browserBusy = false }
                }
            },
            enabled = !browserBusy && server.startsWith("http"),
            modifier = Modifier.fillMaxWidth(),
        ) { Text(if (browserBusy) "等待浏览器确认…" else "在浏览器中登录") }
        if (browserError.isNotBlank()) {
            Spacer(Modifier.height(6.dp))
            Text(browserError, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
        }
        Spacer(Modifier.height(14.dp))
        TextButton(onClick = { showPassword = !showPassword }) {
            Text(if (showPassword) "收起账号密码登录" else "使用账号密码登录")
        }

        if (showPassword) {
            OutlinedTextField(username, { username = it }, label = { Text("用户名") }, singleLine = true, modifier = Modifier.fillMaxWidth())
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
                    lifecycleDispatch {
                        runCatching { JjbApi(Session(server, "", "")).login(server, username, password) }
                            .onSuccess { session -> onLogin(session) }
                            .onFailure { pwError = it.message ?: "登录失败" }
                        pwBusy = false
                    }
                },
                enabled = !pwBusy && server.startsWith("http") && username.length >= 3 && password.length >= 10,
                modifier = Modifier.fillMaxWidth(),
            ) { Text(if (pwBusy) "登录中…" else "登录") }
        }
        Spacer(Modifier.height(10.dp))
        Text("与电脑端/网页端同一账号。首次使用请先在网页端注册。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
