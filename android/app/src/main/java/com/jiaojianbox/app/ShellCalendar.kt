package com.jiaojianbox.app

import android.content.ContentProviderOperation
import android.content.ContentUris
import android.content.Context
import android.provider.CalendarContract as Cal
import java.security.MessageDigest
import java.time.Instant
import java.util.TimeZone

/** Calendar adapter owned by the mobile shell; cloud deadlines remain the source of truth. */
class ShellCalendar(private val context: Context, private val session: Session) {
    private val owner = MessageDigest.getInstance("SHA-256").digest((session.server + "|" + session.userId.ifBlank { session.username }).toByteArray()).take(12).joinToString("") { "%02x".format(it) }
    private val prefs = context.getSharedPreferences("shell-calendar-$owner", Context.MODE_PRIVATE)
    var calendarId: Long
        get() = prefs.getLong("calendar", -1)
        set(value) { prefs.edit().putLong("calendar", value).apply() }
    var enabled: Boolean
        get() = prefs.getBoolean("enabled", false)
        set(value) { prefs.edit().putBoolean("enabled", value).apply() }

    fun calendars(): List<CalendarReminders.CalendarInfo> {
        return context.contentResolver.query(Cal.Calendars.CONTENT_URI,
            arrayOf(Cal.Calendars._ID, Cal.Calendars.CALENDAR_DISPLAY_NAME),
            "${Cal.Calendars.CALENDAR_ACCESS_LEVEL} >= ?", arrayOf(Cal.Calendars.CAL_ACCESS_CONTRIBUTOR.toString()), null
        )?.use { cursor -> buildList { while (cursor.moveToNext()) add(CalendarReminders.CalendarInfo(cursor.getLong(0), cursor.getString(1) ?: "日历")) } } ?: emptyList()
    }

    fun sync(tasks: List<Task>, onlyTask: String? = null): Int {
        require(calendarId >= 0) { "请先选择一个可写入的系统日历" }
        val valid = calendars().any { it.id == calendarId }
        require(valid) { "所选日历已不可用，请重新选择" }
        var count = 0
        if (onlyTask != null) {
            val selected = tasks.find { it.id == onlyTask } ?: error("待办已不存在，请刷新后重试")
            require(selected.raw.optString("due_at").isNotBlank()) { "请先为待办设置截止时间" }
        } else {
            val validIds = tasks.map { "JiaojianBox:$owner:${it.id}" }.toSet()
            val stale = context.contentResolver.query(Cal.Events.CONTENT_URI,
                arrayOf(Cal.Events._ID, Cal.Events.DESCRIPTION),
                "${Cal.Events.CALENDAR_ID}=? AND ${Cal.Events.DESCRIPTION} LIKE ?",
                arrayOf(calendarId.toString(), "JiaojianBox:$owner:%"), null
            )?.use { cursor -> buildList { while (cursor.moveToNext()) if (cursor.getString(1) !in validIds) add(cursor.getLong(0)) } } ?: emptyList()
            stale.forEach { context.contentResolver.delete(ContentUris.withAppendedId(Cal.Events.CONTENT_URI, it), null, null) }
        }
        for (task in tasks.filter { onlyTask == null || it.id == onlyTask }) {
            val marker = "JiaojianBox:$owner:${task.id}"
            val existing = context.contentResolver.query(Cal.Events.CONTENT_URI, arrayOf(Cal.Events._ID),
                "${Cal.Events.CALENDAR_ID}=? AND ${Cal.Events.DESCRIPTION}=?", arrayOf(calendarId.toString(), marker), null
            )?.use { cursor -> if (cursor.moveToFirst()) cursor.getLong(0) else null }
            val due = runCatching { Instant.parse(task.raw.optString("due_at")).toEpochMilli() }.getOrNull()
            if (due == null || task.status in listOf("submitted", "archived")) {
                if (existing != null) context.contentResolver.delete(ContentUris.withAppendedId(Cal.Events.CONTENT_URI, existing), null, null)
                continue
            }
            val operations = arrayListOf<ContentProviderOperation>()
            val values = android.content.ContentValues().apply {
                put(Cal.Events.CALENDAR_ID, calendarId); put(Cal.Events.TITLE, task.title)
                put(Cal.Events.DESCRIPTION, marker); put(Cal.Events.DTSTART, due)
                put(Cal.Events.DTEND, due + 15 * 60_000); put(Cal.Events.EVENT_TIMEZONE, TimeZone.getDefault().id)
                put(Cal.Events.HAS_ALARM, 1)
            }
            if (existing == null) operations.add(ContentProviderOperation.newInsert(Cal.Events.CONTENT_URI).withValues(values).build())
            else {
                operations.add(ContentProviderOperation.newUpdate(ContentUris.withAppendedId(Cal.Events.CONTENT_URI, existing)).withValues(values).build())
                operations.add(ContentProviderOperation.newDelete(Cal.Reminders.CONTENT_URI).withSelection("${Cal.Reminders.EVENT_ID}=?", arrayOf(existing.toString())).build())
            }
            val reminders = task.raw.optJSONArray("reminders")
            val offsets = (0 until (reminders?.length() ?: 0)).mapNotNull { i ->
                runCatching { ((due - Instant.parse(reminders!!.getString(i)).toEpochMilli()) / 60_000).toInt() }.getOrNull()?.takeIf { it >= 0 }
            }.distinct().ifEmpty { listOf(0) }
            for (minutes in offsets) {
                val insert = ContentProviderOperation.newInsert(Cal.Reminders.CONTENT_URI)
                    .withValue(Cal.Reminders.MINUTES, minutes).withValue(Cal.Reminders.METHOD, Cal.Reminders.METHOD_ALERT)
                if (existing == null) insert.withValueBackReference(Cal.Reminders.EVENT_ID, 0) else insert.withValue(Cal.Reminders.EVENT_ID, existing)
                operations.add(insert.build())
            }
            context.contentResolver.applyBatch(Cal.AUTHORITY, operations)
            count++
        }
        return count
    }
}
