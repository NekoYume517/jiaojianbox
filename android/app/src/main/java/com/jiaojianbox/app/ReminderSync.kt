package com.jiaojianbox.app

import android.content.Context
import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.CalendarContract
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter

/**
 * 日历提醒自动同步：App 每次打开（以及日历数据变化时）把云端待办的提醒时间
 * 同步到系统日历。云端是唯一事实源；本模块只做「按云端修正日历」这一件事。
 *
 * 识别规则：事件 DESCRIPTION 含「待办 <taskId>」（与 CalendarReminders.upsert 写入格式一致）。
 * 同步策略：
 *  - 云端有提醒、日历缺失/时间不同 → 重写（upsert 内部先清旧事件）
 *  - 云端无提醒、日历有该待办事件 → 删除（用户在网页端移除了提醒）
 *  - 云端待办已 submitted/archived → 不再写新提醒，已有事件保留由用户在日历处理
 */
object ReminderSync {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var registered = false

    /** App 启动调用一次；授权日历后由 UI 触发。 */
    fun syncOnStart(context: Context, store: AppStore) {
        scope.launch {
            val session = runCatching { store.sessionOnce() }.getOrNull() ?: return@launch
            val api = JjbApi(session)
            runCatching { api.snapshot() }.onSuccess { snapshot ->
                withContext(Dispatchers.IO) { syncAll(context, snapshot.tasks) }
            }
            registerObserver(context, store)
        }
    }

    /** 核心：把待办提醒时间对齐到系统日历。需要已授予日历权限。 */
    fun syncAll(context: Context, tasks: List<Task>) {
        for (task in tasks) NotificationScheduler.syncTask(context, task)
        if (!CalendarReminders.available(context)) return
        val calendars = CalendarReminders.list(context)
        if (calendars.isEmpty()) return
        val calendarId = calendars.first().id
        val existing = existingEventIds(context) // taskId -> eventMillis
        for (task in tasks) {
            val reminders = task.raw.optJSONArray("reminders")?.let { arr ->
                (0 until arr.length()).mapNotNull { i ->
                    runCatching { ZonedDateTime.parse(arr.getString(i)).toInstant().toEpochMilli() }.getOrNull()
                }
            }.orEmpty()
            if (task.status in listOf("submitted", "archived")) {
                if (existing.containsKey(task.id)) CalendarReminders.remove(context, task.id)
                continue
            }
            if (reminders.isEmpty()) {
                // 云端没有提醒：若日历里有旧事件则清掉
                if (existing.containsKey(task.id)) CalendarReminders.remove(context, task.id)
                continue
            }
            // 多条提醒时日历事件取最早一条作为起止锚点（与手动写入行为一致）
            val targetMillis = reminders.min()
            val current = existing[task.id]
            if (current != null && Math.abs(current - targetMillis) < 60_000) continue // 已一致
            CalendarReminders.upsert(context, calendarId, task.id, task.title, targetMillis)
        }
    }

    private data class EventRow(val taskId: String, val start: Long)

    private fun existingEventIds(context: Context): Map<String, Long> {
        val fallback: Map<String, Long> = emptyMap()
        return runCatching<Map<String, Long>> {
            val projection = arrayOf(CalendarContract.Events._ID, CalendarContract.Events.TITLE, CalendarContract.Events.DESCRIPTION, CalendarContract.Events.DTSTART)
            context.contentResolver.query(CalendarContract.Events.CONTENT_URI, projection, null, null, null)?.use { cursor ->
                val result = mutableMapOf<String, Long>()
                while (cursor.moveToNext()) {
                    val desc = cursor.getString(2) ?: continue
                    val match = Regex("待办 ([0-9a-f-]{36})").find(desc) ?: continue
                    result[match.groupValues[1]] = cursor.getLong(3)
                }
                result
            } ?: fallback
        }.getOrDefault(fallback)
    }

    /** 日历被用户改动时也自动再对齐一次（去抖 5 秒）。 */
    private fun registerObserver(context: Context, store: AppStore) {
        if (registered || !CalendarReminders.available(context)) return
        registered = true
        val handler = Handler(Looper.getMainLooper())
        var pending = false
        context.contentResolver.registerContentObserver(CalendarContract.Events.CONTENT_URI, true, object : ContentObserver(handler) {
            override fun onChange(selfChange: Boolean) {
                if (pending) return
                pending = true
                handler.postDelayed({
                    pending = false
                    scope.launch {
                        val session = runCatching { store.sessionOnce() }.getOrNull() ?: return@launch
                        runCatching { JjbApi(session).snapshot() }.onSuccess { snapshot ->
                            withContext(Dispatchers.IO) { syncAll(context, snapshot.tasks) }
                        }
                    }
                }, 5000)
            }
        })
    }
}
