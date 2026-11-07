package com.jiaojianbox.app

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/** 全局 IO 协程域：事件回调里用 lifecycleDispatch 发起异步。 */
val globalScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

fun lifecycleDispatch(block: suspend () -> Unit) {
    globalScope.launch { block() }
}

