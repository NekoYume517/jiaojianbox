package com.jiaojianbox.app

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * 服务端 API 客户端。所有请求带 Bearer 令牌；与桌面/网页共用同一套 REST。
 */
class JjbApi(private val session: Session) {
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(300, TimeUnit.SECONDS)
        .build()

    private fun request(route: String) = Request.Builder()
        .url(session.server.trimEnd('/') + route)
        .header("Authorization", "Bearer " + session.token)
        .build()

    private suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
        enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) { if (cont.isActive) cont.resumeWithException(e) }
            override fun onResponse(call: Call, response: Response) { if (cont.isActive) cont.resume(response) else response.close() }
        })
        cont.invokeOnCancellation { runCatching { cancel() } }
    }

    private fun Response.errorMessage(): String = runCatching {
        val body = body?.string().orEmpty()
        JSONObject(body).optString("detail").ifEmpty { "请求失败（HTTP $code）" }
    }.getOrDefault("请求失败（HTTP $code）")

    private fun Response.jsonOrThrow(): JSONObject {
        if (!isSuccessful) throw IOException(errorMessage())
        val text = body?.string().orEmpty()
        return JSONObject(text)
    }

    suspend fun snapshot(): Snapshot = withContext(Dispatchers.IO) {
        if(session.offline) return@withContext LocalWorkspace.snapshot()
        http.newCall(request("/api/snapshot")).await().use { response ->
            val obj = response.jsonOrThrow()
            Snapshot(
                tasks = obj.getJSONArray("tasks").let { arr -> List(arr.length()) { arr.getJSONObject(it).toTask() } },
                messages = obj.getJSONArray("messages").let { arr -> List(arr.length()) { arr.getJSONObject(it).toMessage() } },
                shelf = obj.optJSONArray("shelf")?.let { arr -> List(arr.length()) { arr.getJSONObject(it).toShelf() } } ?: emptyList(),
            )
        }
    }

    suspend fun uploadShelf(name: String, bytes: ByteArray): ShelfItem = withContext(Dispatchers.IO) {
        if(session.offline) return@withContext LocalWorkspace.upload(name,bytes)
        http.newCall(Request.Builder()
            .url(session.server.trimEnd('/') + "/api/shelf")
            .header("Authorization", "Bearer " + session.token)
            .post(okhttp3.MultipartBody.Builder().setType(okhttp3.MultipartBody.FORM).addFormDataPart("file", name, bytes.toRequestBody("application/octet-stream".toMediaType())).build())
            .build()).await().use { response ->
            response.jsonOrThrow().toShelf()
        }
    }

    suspend fun analyzeShelf(fileId: String, autoAssign: Boolean = true): ShelfItem = withContext(Dispatchers.IO) {
        if(session.offline) throw IOException("离线模式已在本机保存文件，连接服务器后可使用 AI 整理")
        val payload = JSONObject().put("auto_assign", autoAssign).toString().toRequestBody("application/json".toMediaType())
        http.newCall(request("/api/shelf/$fileId/suggest").newBuilder().post(payload).build()).await().use { it.jsonOrThrow().toShelf() }
    }

    suspend fun setStatus(taskId: String, task: JSONObject, status: String): JSONObject = withContext(Dispatchers.IO) {
        if(session.offline) return@withContext LocalWorkspace.setStatus(taskId,status)
        val updated = JSONObject(task.toString()).put("status", status)
        val payload = updated.toString().toRequestBody("application/json".toMediaType())
        http.newCall(request("/api/tasks/$taskId").newBuilder().put(payload).build()).await().use { it.jsonOrThrow() }
    }

    suspend fun createTask(title: String, description: String) = withContext(Dispatchers.IO) {
        if(session.offline) return@withContext LocalWorkspace.createTask(title,description)
        val payload = JSONObject().put("title",title).put("description",description).toString().toRequestBody("application/json".toMediaType())
        http.newCall(request("/api/tasks").newBuilder().post(payload).build()).await().use { it.jsonOrThrow() }
    }

    suspend fun login(server: String, username: String, password: String): Session = withContext(Dispatchers.IO) {
        val payload = JSONObject().put("username", username).put("password", password).toString().toRequestBody("application/json".toMediaType())
        http.newCall(Request.Builder().url(server.trimEnd('/') + "/api/auth/login").post(payload).build()).await().use { response ->
            val obj = response.jsonOrThrow()
            Session(server = server.trimEnd('/'), token = obj.getString("token"), username = obj.getString("username"), userId = obj.optString("user_id"))
        }
    }

    suspend fun exportWorkspace(): java.io.File = withContext(Dispatchers.IO) {
        if(session.offline)return@withContext LocalWorkspace.exportZip()
        http.newCall(request("/api/workspace/export")).await().use {
            if(!it.isSuccessful)throw IOException(it.errorMessage())
            val output=java.io.File.createTempFile("workspace-", ".zip", AppContext.context.cacheDir)
            try {
                it.body!!.byteStream().use { src -> output.outputStream().use { dst ->
                    val buffer=ByteArray(65536);var total=0L
                    while(true){val n=src.read(buffer);if(n<0)break;total+=n;require(total<=256L*1024*1024){"数据包超过手机迁移上限 256MB"};dst.write(buffer,0,n)}
                }}
                output
            } catch(e:Exception){output.delete();throw e}
        }
    }
    suspend fun importWorkspace(file: java.io.File) = withContext(Dispatchers.IO) {
        if(session.offline) {LocalWorkspace.importZip(file);return@withContext JSONObject().put("imported",true)}
        val body=okhttp3.MultipartBody.Builder().setType(okhttp3.MultipartBody.FORM).addFormDataPart("file","workspace.zip",file.asRequestBody("application/zip".toMediaType())).build()
        http.newCall(request("/api/workspace/import").newBuilder().post(body).build()).await().use { it.jsonOrThrow() }
    }
    suspend fun account(route: String, method: String="GET", body: JSONObject?=null): JSONObject = withContext(Dispatchers.IO) {
        val builder=request(route).newBuilder()
        if(method!="GET")builder.method(method,(body?:JSONObject()).toString().toRequestBody("application/json".toMediaType()))
        http.newCall(builder.build()).await().use { it.jsonOrThrow() }
    }
}

data class Snapshot(val tasks: List<Task>, val messages: List<Message>, val shelf: List<ShelfItem>)

data class Task(
    val id: String, val title: String, val description: String, val status: String,
    val dueAt: String?, val version: Int, val materialCount: Int, val raw: JSONObject,
)

data class Message(val id: String, val text: String, val conversationName: String, val sentAt: String, val source: String, val classification: String?, val confidence: Double?, val analysisPending: Boolean = false, val analysisState: String = "", val analysisError: String? = null)

data class ShelfItem(val id: String, val name: String, val size: Long, val taskId: String?, val kind: String, val category: String, val reason: String?, val version: Int)

fun JSONObject.toTask() = Task(
    id = getString("id"),
    title = getString("title"),
    description = optString("description"),
    status = optString("status", "collecting"),
    dueAt = optString("due_at").takeUnless { isNull("due_at") || it.isBlank() },
    version = optInt("version", 1),
    materialCount = optJSONArray("attachments")?.let { arr -> (0 until arr.length()).count { arr.getJSONObject(it).optString("kind") == "material" } } ?: 0,
    raw = this,
)

fun JSONObject.toMessage() = Message(
    id = getString("id"),
    text = optString("text"),
    conversationName = optString("conversation_name", "手动通知"),
    sentAt = optString("sent_at"),
    source = optString("source", "manual"),
    classification = optJSONObject("analysis")?.optString("classification")?.ifEmpty { null },
    confidence = optJSONObject("analysis")?.optDouble("confidence")?.takeIf { !it.isNaN() },
    analysisPending = optBoolean("analysis_pending"),
    analysisState = optString("analysis_state"),
    analysisError = optString("analysis_error").takeUnless { isNull("analysis_error") || it.isBlank() },
)

fun JSONObject.toShelf() = ShelfItem(
    id = getString("id"),
    name = getString("name"),
    size = optLong("size"),
    taskId = optString("task_id").takeUnless { isNull("task_id") || it.isBlank() },
    kind = optString("kind", "material"),
    category = optString("category", "inbox"),
    reason = optJSONObject("suggestion")?.optString("reason")?.ifEmpty { null },
    version = optInt("version", 1),
)
