package com.jiaojianbox.app

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch

/**
 * 单 Activity + Compose M3。外部分享/打开的文件通过 pendingUris 交给收纳页处理。
 */
class MainActivity : ComponentActivity() {
    private val store by lazy { AppStore(this) }
    private var pendingUris by mutableStateOf<List<Uri>>(emptyList())
    private var calendarPermission = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AppContext.init(this)
        handleIncoming(intent)
        setContent {
            MaterialTheme(colorScheme = if (androidx.compose.foundation.isSystemInDarkTheme()) JjbTheme.dark() else JjbTheme.light()) {
                Surface {
                    JjbApp(
                        store = store,
                        pendingUris = pendingUris,
                        onUrisConsumed = { pendingUris = emptyList() },
                        requestCalendar = { calendarPermission.launch(arrayOf(android.Manifest.permission.READ_CALENDAR, android.Manifest.permission.WRITE_CALENDAR)) },
                    )
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIncoming(intent)
    }

    /** 兼容安卓拖动/分享：SEND、SEND_MULTIPLE、VIEW 都归一成 uri 列表。 */
    private fun handleIncoming(intent: Intent?) {
        val uris = mutableListOf<Uri>()
        when (intent?.action) {
            Intent.ACTION_SEND -> intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)?.let(uris::add)
            Intent.ACTION_SEND_MULTIPLE -> intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)?.let(uris::addAll)
            Intent.ACTION_VIEW -> intent.data?.let(uris::add)
        }
        if (uris.isNotEmpty()) pendingUris = uris
    }
}
