package com.jiaojianbox.app

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okio.BufferedSink
import org.json.JSONObject
import java.util.concurrent.TimeUnit

data class MobileProgress(val title: String, val transferred: Long, val total: Long, val speed: Long)

class MobileTransfer(private val context: Context, private val session: Session, private val progress: (MobileProgress?) -> Unit) {
    private val http = OkHttpClient.Builder().connectTimeout(20, TimeUnit.SECONDS).readTimeout(180, TimeUnit.SECONDS).writeTimeout(180, TimeUnit.SECONDS).followRedirects(false).build()
    private fun ensure(response: okhttp3.Response) {
        if (!response.isSuccessful) throw IllegalStateException(runCatching { JSONObject(response.body?.string().orEmpty()).opt("detail").toString().takeIf { it != "null" } }.getOrNull() ?: "服务器请求失败（${response.code}）")
    }
    suspend fun upload(uris: List<Uri>) = withContext(Dispatchers.IO) {
        try { for ((index, uri) in uris.withIndex()) {
            require(uri.scheme == "content") { "只支持系统文件选择器提供的文件" }
            var name = "文件"; var size = -1L
            context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { if (it.moveToFirst()) { name = it.getString(0) ?: name; if (!it.isNull(1)) size = it.getLong(1) } }
            val title = "导入 ${index + 1}/${uris.size} · $name"
            val start = System.nanoTime()
            val body = object : RequestBody() {
                override fun contentType() = (context.contentResolver.getType(uri) ?: "application/octet-stream").toMediaTypeOrNull()
                override fun contentLength() = size
                override fun writeTo(sink: BufferedSink) {
                    var total = 0L; var last = 0L
                    context.contentResolver.openInputStream(uri).use { input ->
                        requireNotNull(input) { "无法打开文件，请重新选择" }
                        val buffer = ByteArray(65536)
                        while (true) { val n = input.read(buffer); if (n < 0) break; sink.write(buffer, 0, n); total += n
                            val now = System.nanoTime(); if (now - last > 150_000_000) { progress(MobileProgress(title, total, size, (total * 1e9 / (now - start).coerceAtLeast(1)).toLong())); last = now }
                        }
                    }
                }
            }
            progress(MobileProgress(title, 0, size, 0))
            val payload = MultipartBody.Builder().setType(MultipartBody.FORM).addFormDataPart("file", name, body).build()
            http.newCall(Request.Builder().url(session.server + "/api/shelf").header("Authorization", "Bearer " + session.token).post(payload).build()).execute().use { ensure(it) }
        } } finally { progress(null) }
    }
    suspend fun download(route: String, target: Uri, name: String) = withContext(Dispatchers.IO) {
        require(route.startsWith("/api/") && !route.contains("\\") && !route.contains("\r") && !route.contains("\n")) { "无效的文件下载路径" }
        val parsed = Uri.parse(session.server + route)
        require(parsed.scheme == Uri.parse(session.server).scheme && parsed.authority == Uri.parse(session.server).authority) { "下载地址不属于当前服务器" }
        try { http.newCall(Request.Builder().url(parsed.toString()).header("Authorization", "Bearer " + session.token).build()).execute().use { response ->
            ensure(response); val body = requireNotNull(response.body) { "下载内容为空" }; val size = body.contentLength(); val start = System.nanoTime()
            progress(MobileProgress("保存 $name", 0, size, 0))
            context.contentResolver.openOutputStream(target, "wt").use { out ->
                requireNotNull(out) { "无法写入所选位置" }
                body.byteStream().use { input ->
                    val buffer = ByteArray(65536); var total = 0L; var last = 0L
                    while (true) { val n = input.read(buffer); if (n < 0) break; out.write(buffer, 0, n); total += n
                        val now = System.nanoTime(); if (now - last > 150_000_000) { progress(MobileProgress("保存 $name", total, size, (total * 1e9 / (now - start).coerceAtLeast(1)).toLong())); last = now }
                    }
                    if (size >= 0) check(total == size) { "文件下载未完成，请重试" }
                }
            }
        } } finally { progress(null) }
    }
}
