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
    private val releaseTagPattern = Regex("""/releases/tag/(v[^/?#]+)""")

    data class Result(val updatable: Boolean, val current: String, val latest: String, val url: String)

    suspend fun check(currentVersion: String): Result = withContext(Dispatchers.IO) {
        var apiError: Exception? = null
        try {
            return@withContext checkAPI(currentVersion)
        } catch (error: Exception) {
            apiError = error
        }
        try {
            checkReleaseRedirect(currentVersion)
        } catch (fallbackError: Exception) {
            throw IllegalStateException(
                "检查更新失败：${apiError.message ?: "GitHub 接口不可用"}；备用通道：${fallbackError.message ?: "不可用"}"
            )
        }
    }

    private fun checkAPI(currentVersion: String): Result {
        val connection = open("https://api.github.com/repos/$REPO/releases/latest", "application/vnd.github+json")
        try {
            if (connection.responseCode == 404) {
                return Result(false, currentVersion, "", "https://github.com/$REPO/releases")
            }
            if (connection.responseCode != 200) {
                throw IllegalStateException("GitHub 接口 HTTP ${connection.responseCode}")
            }
            val body = connection.inputStream.bufferedReader().use { it.readText() }
            val release = JSONObject(body)
            val latest = release.optString("tag_name").removePrefix("v")
            if (latest.isBlank()) throw IllegalStateException("GitHub 接口未返回版本号")
            val url = release.optString("html_url")
            return Result(compareVersions(latest, currentVersion) > 0, currentVersion, latest, url)
        } finally {
            connection.disconnect()
        }
    }

    private fun checkReleaseRedirect(currentVersion: String): Result {
        var target = URL("https://github.com/$REPO/releases/latest")
        repeat(6) {
            val connection = target.openConnection() as HttpURLConnection
            connection.connectTimeout = 15000
            connection.readTimeout = 15000
            connection.requestMethod = "HEAD"
            connection.instanceFollowRedirects = false
            connection.setRequestProperty("Accept", "text/html")
            connection.setRequestProperty("User-Agent", "JiaojianBox/$currentVersion")
            try {
                when (connection.responseCode) {
                    in 300..399 -> {
                        val location = connection.getHeaderField("Location")
                            ?: throw IllegalStateException("GitHub 发布页未返回跳转地址")
                        target = URL(target, location)
                    }
                    200 -> {
                        val latest = releaseTagPattern.find(target.toString())?.groupValues?.getOrNull(1)?.removePrefix("v")
                            ?: throw IllegalStateException("GitHub 发布页缺少版本号")
                        return Result(
                            compareVersions(latest, currentVersion) > 0,
                            currentVersion,
                            latest,
                            "https://github.com/$REPO/releases/tag/v$latest",
                        )
                    }
                    else -> throw IllegalStateException("备用接口 HTTP ${connection.responseCode}")
                }
            } finally {
                connection.disconnect()
            }
        }
        throw IllegalStateException("GitHub 发布页跳转次数过多")
    }

    private fun open(url: String, accept: String): HttpURLConnection {
        val connection = URL(url).openConnection() as HttpURLConnection
        connection.connectTimeout = 15000
        connection.readTimeout = 15000
        connection.setRequestProperty("Accept", accept)
        connection.setRequestProperty("User-Agent", "JiaojianBox")
        return connection
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
