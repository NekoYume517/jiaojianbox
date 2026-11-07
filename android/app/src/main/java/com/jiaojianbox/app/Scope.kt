package com.jiaojianbox.app

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

val globalScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
