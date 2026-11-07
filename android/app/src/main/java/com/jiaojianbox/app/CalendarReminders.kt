package com.jiaojianbox.app

import android.content.ContentValues
import android.content.Context
import android.provider.CalendarContract
import java.util.concurrent.TimeUnit

/**
 * 定时提醒依赖系统日历：把任务截止写入用户选定的日历账户，提醒由系统日历触发，
 * App 退出/卸载后提醒仍在。不自带闹钟调度，避免重复的提醒通道。
 */
object CalendarReminders {

    data class CalendarInfo(val id: Long, val name: String)

    fun available(context: Context): Boolean = runCatching {
        context.contentResolver.query(
            CalendarContract.Calendars.CONTENT_URI,
            arrayOf(CalendarContract.Calendars._ID),
            null, null, null,
        )?.use { it.count > 0 } ?: false
    }.getOrDefault(false)

    fun list(context: Context): List<CalendarInfo> = runCatching {
        val projection = arrayOf(CalendarContract.Calendars._ID, CalendarContract.Calendars.CALENDAR_DISPLAY_NAME)
        context.contentResolver.query(
            CalendarContract.Calendars.CONTENT_URI, projection, null, null, null,
        )?.use { cursor ->
            buildList {
                while (cursor.moveToNext()) add(CalendarInfo(cursor.getLong(0), cursor.getString(1) ?: "日历"))
            }
        } ?: emptyList()
    }.getOrDefault(emptyList())

    /**
     * 写入一条「截止提醒」事件：提前 1 天 + 当天上午各一次（系统日历的 reminder 分钟数）。
     * 返回事件 id；同一任务重复调用会先清掉旧事件（通过 eventId 后缀匹配描述）。
     */
    fun upsert(context: Context, calendarId: Long, taskId: String, title: String, dueAtMillis: Long, location: String? = null): Long? = runCatching {
        remove(context, taskId)
        val values = ContentValues().apply {
            put(CalendarContract.Events.CALENDAR_ID, calendarId)
            put(CalendarContract.Events.TITLE, "交件：$title")
            put(CalendarContract.Events.DESCRIPTION, "由交件箱创建 · 任务 $taskId")
            put(CalendarContract.Events.DTSTART, dueAtMillis - TimeUnit.HOURS.toMillis(1))
            put(CalendarContract.Events.DTEND, dueAtMillis)
            put(CalendarContract.Events.EVENT_TIMEZONE, java.util.TimeZone.getDefault().id)
            location?.takeIf { it.startsWith("http") }?.let { put(CalendarContract.Events.EVENT_LOCATION, it) }
            put(CalendarContract.Events.AVAILABILITY, CalendarContract.Events.AVAILABILITY_FREE)
        }
        val id = context.contentResolver.insert(CalendarContract.Events.CONTENT_URI, values)
            ?.lastPathSegment?.toLong() ?: return null
        // 两条提醒：提前 1 天、提前 60 分钟
        for (minutes in listOf(1440, 60)) {
            val reminder = ContentValues().apply {
                put(CalendarContract.Reminders.EVENT_ID, id)
                put(CalendarContract.Reminders.MINUTES, minutes)
                put(CalendarContract.Reminders.METHOD, CalendarContract.Reminders.METHOD_ALERT)
            }
            context.contentResolver.insert(CalendarContract.Reminders.CONTENT_URI, reminder)
        }
        id
    }.getOrNull()

    fun remove(context: Context, taskId: String) {
        runCatching {
            context.contentResolver.delete(
                CalendarContract.Events.CONTENT_URI,
                "${CalendarContract.Events.DESCRIPTION} LIKE ?",
                arrayOf("%任务 $taskId%"),
            )
        }
    }
}
