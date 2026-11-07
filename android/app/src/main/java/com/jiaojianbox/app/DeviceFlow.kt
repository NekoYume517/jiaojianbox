package com.jiaojianbox.app

import org.json.JSONObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody

/** Device Flow 协议封装（与桌面端 auth/device 接口一致）。 */
object DeviceFlow {
    data class Start(val deviceCode: String, val userCode: String, val verificationUrl: String, val expiresIn: Int)

    sealed class PollResult {
        object Pending : PollResult()
        object Denied : PollResult()
        object Expired : PollResult()
        data class Approved(val token: String, val userId: String, val username: String) : PollResult()
    }

    private val http = okhttp3.OkHttpClient.Builder()
        .connectTimeout(15, java.util.concurrent.TimeUnit.SECONDS)
        .readTimeout(20, java.util.concurrent.TimeUnit.SECONDS)
        .build()

    private fun post(base: String, route: String, body: String): JSONObject {
        val req = okhttp3.Request.Builder()
            .url(base.trimEnd('/') + route)
            .post(body.toRequestBody("application/json".toMediaType()))
            .build()
        http.newCall(req).execute().use { response ->
            val text = response.body?.string().orEmpty()
            val obj = runCatching { JSONObject(text) }.getOrElse { JSONObject() }
            if (!response.isSuccessful) throw IllegalStateException(obj.optString("detail").ifEmpty { "请求失败（HTTP ${response.code}）" })
            return obj
        }
    }

    fun start(base: String): Start {
        val obj = post(base, "/api/auth/device/start", "{}")
        val path = obj.getString("verification_path")
        return Start(
            deviceCode = obj.getString("device_code"),
            userCode = obj.getString("user_code"),
            verificationUrl = base.trimEnd('/') + path,
            expiresIn = obj.optInt("expires_in", 600),
        )
    }

    fun poll(base: String, deviceCode: String): PollResult {
        val obj = post(base, "/api/auth/device/poll", """{"device_code":"$deviceCode"}""")
        return when (obj.optString("status")) {
            "approved" -> PollResult.Approved(obj.getString("token"), obj.getString("user_id"), obj.getString("username"))
            "denied" -> PollResult.Denied
            else -> PollResult.Pending
        }
    }
}
