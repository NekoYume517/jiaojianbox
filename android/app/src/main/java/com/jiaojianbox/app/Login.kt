package com.jiaojianbox.app

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/** 应用上下文桥（供 composable 事件回调里读取 ContentResolver）。 */
private var appContext: Context? = null
fun AppStore.context(): Context = appContext ?: throw IllegalStateException("context 未初始化")
fun initAppContext(context: Context) { appContext = context.applicationContext }

fun queryDisplayName(context: Context, uri: Uri): String? = runCatching {
    context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) cursor.getString(0) else null
    }
}.getOrNull()

@Composable
fun LoginScreen(onLogin: (Session) -> Unit) {
    var server by remember { mutableStateOf("http://") }
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(28.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("交件箱", style = MaterialTheme.typography.headlineLarge, color = MaterialTheme.colorScheme.primary)
        Text("消息很多，要交的事一件不漏。", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(28.dp))
        OutlinedTextField(server, { server = it }, label = { Text("服务端地址") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        Spacer(Modifier.height(10.dp))
        OutlinedTextField(username, { username = it }, label = { Text("用户名") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        Spacer(Modifier.height(10.dp))
        OutlinedTextField(password, { password = it }, label = { Text("密码") }, singleLine = true, visualTransformation = androidx.compose.ui.text.input.PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
        if (error.isNotBlank()) {
            Spacer(Modifier.height(8.dp))
            Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
        }
        Spacer(Modifier.height(18.dp))
        Button(
            onClick = {
                busy = true; error = ""
                lifecycleDispatch {
                    runCatching { JjbApi(Session(server, "", "")).login(server, username, password) }
                        .onSuccess { session -> onLogin(session) }
                        .onFailure { error = it.message ?: "登录失败" }
                    busy = false
                }
            },
            enabled = !busy && server.startsWith("http") && username.length >= 3 && password.length >= 10,
            modifier = Modifier.fillMaxWidth(),
        ) { Text(if (busy) "登录中…" else "登录") }
        Spacer(Modifier.height(10.dp))
        Text("与电脑端/网页端同一账号。首次使用请先在网页端注册。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
