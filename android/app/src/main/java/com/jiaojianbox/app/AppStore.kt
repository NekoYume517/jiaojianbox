package com.jiaojianbox.app

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.dataStore by preferencesDataStore(name = "jiaojianbox")

/** 本机持久化：服务端地址、登录令牌。令牌经 Android Keystore 加密后写入 DataStore。 */
class AppStore(private val context: Context) {
    private val serverKey = stringPreferencesKey("server")
    private val tokenKey = stringPreferencesKey("token")
    private val usernameKey = stringPreferencesKey("username")
    private val userIdKey = stringPreferencesKey("user_id")

    val session: Flow<Session?> = context.dataStore.data.map { prefs ->
        val stored = prefs[tokenKey] ?: return@map null
        val token = if (TokenCipher.isEncrypted(stored)) TokenCipher.decrypt(stored) ?: return@map null else stored
        Session(server = prefs[serverKey] ?: "", token = token, username = prefs[usernameKey] ?: "", userId = prefs[userIdKey] ?: "")
    }

    suspend fun saveSession(session: Session) {
        context.dataStore.edit { prefs ->
            prefs[serverKey] = session.server
            prefs[tokenKey] = TokenCipher.encrypt(session.token)
            prefs[usernameKey] = session.username
            prefs[userIdKey] = session.userId
        }
    }

    /**
     * Migrates tokens written by releases that predate TokenCipher. This runs
     * outside the DataStore flow transform so an edit cannot block the same
     * stream that triggered it.
     */
    suspend fun migrateLegacyToken() {
        val stored = context.dataStore.data.first()[tokenKey] ?: return
        if (TokenCipher.isEncrypted(stored)) return
        val encrypted = TokenCipher.encrypt(stored)
        context.dataStore.edit { prefs ->
            if (prefs[tokenKey] == stored) prefs[tokenKey] = encrypted
        }
    }

    suspend fun clearSession() = context.dataStore.edit { prefs ->
        prefs.remove(serverKey)
        prefs.remove(tokenKey)
        prefs.remove(usernameKey)
        prefs.remove(userIdKey)
    }

    suspend fun sessionOnce(): Session? {
        migrateLegacyToken()
        return session.first()
    }
}

const val DEFAULT_SERVER = "https://jiaojianbox.bansonic.top"
data class Session(val server: String, val token: String, val username: String, val userId: String = "") {
    val offline: Boolean get() = server == "offline://local"
}
