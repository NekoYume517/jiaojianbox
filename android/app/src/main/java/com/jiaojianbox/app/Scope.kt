package com.jiaojianbox.app

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/** 全局 IO 协程域：事件回调里用 lifecycleDispatch 发起异步。 */
val globalScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

fun lifecycleDispatch(block: suspend () -> Unit) {
    globalScope.launch { block() }
}

/** 应用上下文桥：MainActivity.onCreate 里初始化，供任何地方读 ContentResolver。 */
object AppContext {
    lateinit var context: Context
        private set
    fun init(context: Context) { this.context = context.applicationContext }
}

fun AppStore.context(): Context = AppContext.context

fun queryDisplayName(context: Context, uri: android.net.Uri): String? = runCatching {
    context.contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) cursor.getString(0) else null
    }
}.getOrNull()
