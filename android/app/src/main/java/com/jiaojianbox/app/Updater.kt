package com.jiaojianbox.app

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * GitHub Releases 更新检查：只读。发现新版本给出下载页，由用户手动安装。
 */
object Updater {
    private const val REPO = "NekoYume517/jiaojianbox"

    data class Result(val updatable: Boolean, val current: String, val latest: String, val url: String)

    suspend fun check(currentVersion: String): Result = withContext(Dispatchers.IO) {
        val connection = URL("https://api.github.com/repos/$REPO/releases/latest").openConnection() as HttpURLConnection
        connection.connectTimeout = 15000
        connection.readTimeout = 15000
        connection.setRequestProperty("Accept", "application/vnd.github+json")
        try {
            if (connection.responseCode == 404) return@withContext Result(false, currentVersion, "", "https://github.com/$REPO/releases")
            if (connection.responseCode != 200) throw IllegalStateException("检查更新失败（HTTP ${connection.responseCode}）")
            val body = connection.inputStream.bufferedReader().use { it.readText() }
            val release = JSONObject(body)
            val latest = release.optString("tag_name").removePrefix("v")
            val url = release.optString("html_url")
            Result(compareVersions(latest, currentVersion) > 0, currentVersion, latest, url)
        } finally {
            connection.disconnect()
        }
    }

    fun compareVersions(a: String, b: String): Int {
        val pa = a.split('.', '-').map { it.toIntOrNull() ?: 0 }
        val pb = b.split('.', '-').map { it.toIntOrNull() ?: 0 }
        for (i in 0 until maxOf(pa.size, pb.size)) {
            val diff = (pa.getOrNull(i) ?: 0) - (pb.getOrNull(i) ?: 0)
            if (diff != 0) return diff
        }
        return 0
    }
}
