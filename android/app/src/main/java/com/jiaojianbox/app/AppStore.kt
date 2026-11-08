package com.jiaojianbox.app

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.dataStore by preferencesDataStore(name = "jiaojianbox")

/** 本机持久化：服务端地址、登录令牌。令牌只存 DataStore，不上日志。 */
class AppStore(private val context: Context) {
    private val serverKey = stringPreferencesKey("server")
    private val tokenKey = stringPreferencesKey("token")
    private val usernameKey = stringPreferencesKey("username")

    val session: Flow<Session?> = context.dataStore.data.map { prefs ->
        val token = prefs[tokenKey] ?: return@map null
        Session(server = prefs[serverKey] ?: "", token = token, username = prefs[usernameKey] ?: "")
    }

    suspend fun saveSession(session: Session) {
        context.dataStore.edit { prefs ->
            prefs[serverKey] = session.server
            prefs[tokenKey] = session.token
            prefs[usernameKey] = session.username
        }
    }

    suspend fun clearSession() = context.dataStore.edit { it.remove(tokenKey) }

    suspend fun sessionOnce(): Session? = session.first()
}

const val DEFAULT_SERVER = "https://jiaojianbox.bansonic.top"
data class Session(val server: String, val token: String, val username: String) {
    val offline: Boolean get() = server == "offline://local"
}
