package com.jiaojianbox.app

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.json.JSONObject

@Composable
fun AccountDialog(session: Session, onDismiss: () -> Unit, onPasswordChanged: () -> Unit) {
    val scope=rememberCoroutineScope()
    var nickname by remember { mutableStateOf("") };var email by remember { mutableStateOf("") }
    var current by remember { mutableStateOf("") };var password by remember { mutableStateOf("") }
    var message by remember { mutableStateOf("") };var busy by remember { mutableStateOf(false) }
    LaunchedEffect(session) {runCatching {JjbApi(session).account("/api/auth/me")}.onSuccess {nickname=it.optString("nickname");email=it.optString("email").takeUnless {e->e=="null"}?:""}.onFailure {if(it is CancellationException)throw it;message=it.message?:"读取失败"}}
    fun run(action: suspend () -> Unit) {scope.launch {busy=true;try {action()}catch(e:Exception){if(e is CancellationException)throw e;message=e.message?:"操作失败"}finally{busy=false}}}
    AlertDialog(onDismissRequest={if(!busy)onDismiss()},title={Text("账号资料")},text={Column(Modifier.verticalScroll(rememberScrollState())) {
        OutlinedTextField(nickname,{nickname=it},label={Text("昵称")},singleLine=true)
        TextButton(enabled=!busy && nickname.isNotBlank(),onClick={run {JjbApi(session).account("/api/account/profile","PUT",JSONObject().put("nickname",nickname));message="昵称已保存"}}){Text("保存昵称")}
        OutlinedTextField(email,{email=it},label={Text("绑定邮箱")},singleLine=true)
        TextButton(enabled=!busy && email.contains("@"),onClick={run {JjbApi(session).account("/api/account/email","POST",JSONObject().put("email",email));message="验证邮件已发送，请在浏览器中确认"}}){Text("发送绑定验证邮件")}
        HorizontalDivider();Spacer(Modifier.height(12.dp))
        OutlinedTextField(current,{current=it},label={Text("当前密码")},visualTransformation=PasswordVisualTransformation(),singleLine=true)
        Spacer(Modifier.height(8.dp));OutlinedTextField(password,{password=it},label={Text("新密码（至少10位）")},visualTransformation=PasswordVisualTransformation(),singleLine=true)
        TextButton(enabled=!busy && password.length>=10 && current.isNotBlank(),onClick={run {JjbApi(session).account("/api/account/password","POST",JSONObject().put("current_password",current).put("new_password",password));onPasswordChanged()}}){Text("修改密码并重新登录")}
        if(message.isNotBlank())Text(message,style=MaterialTheme.typography.bodySmall)
    }},confirmButton={TextButton(enabled=!busy,onClick=onDismiss){Text("完成")}})
}
