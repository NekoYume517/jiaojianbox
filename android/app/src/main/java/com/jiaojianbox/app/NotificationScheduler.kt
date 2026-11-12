package com.jiaojianbox.app

import android.Manifest
import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.util.concurrent.TimeUnit

/**
 * Local notification scheduler. Calendar events remain useful outside the app,
 * while these alarms close the loop inside 交件箱 and can open the exact task.
 */
object NotificationScheduler {
    const val ACTION_REMIND = "com.jiaojianbox.app.REMIND"
    const val ACTION_SNOOZE = "com.jiaojianbox.app.SNOOZE"
    private const val channelId = "jjb_task_reminders"
    private const val taskPrefix = "task:"

    private fun prefs(context: Context) = context.getSharedPreferences("jjb_reminders", Context.MODE_PRIVATE)
    private fun alarm(context: Context) = context.getSystemService(AlarmManager::class.java)

    private fun pending(context: Context, taskId: String, title: String, dueAt: Long, atMillis: Long, action: String = ACTION_REMIND): PendingIntent {
        val intent = Intent(context, NotificationReceiver::class.java).apply {
            this.action = action
            data = Uri.parse("jjb://reminder/${Uri.encode(taskId)}/$atMillis")
            putExtra("task_id", taskId)
            putExtra("title", title)
            putExtra("due_at", dueAt)
            putExtra("remind_at", atMillis)
        }
        return PendingIntent.getBroadcast(
            context, intent.data.hashCode(), intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < 26) return
        val manager = context.getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel(channelId, "待办提醒", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "待办到达提醒时间的本机通知"
        }
        manager.createNotificationChannel(channel)
    }

    fun syncTask(context: Context, task: Task) {
        ensureChannel(context)
        val alarmManager = alarm(context) ?: return
        val key = "scheduled:${task.id}"
        val scheduled = prefs(context).getStringSet(key, emptySet()).orEmpty().toSet()
        for (raw in scheduled) {
            val at = raw.toLongOrNull() ?: continue
            alarmManager.cancel(pending(context, task.id, task.title, 0L, at))
        }
        if (task.status in listOf("submitted", "archived")) {
            rememberTask(context, task, emptyList())
            prefs(context).edit().remove(key).apply()
            return
        }
        val due = task.dueAt?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() } ?: 0L
        val times = task.raw.optJSONArray("reminders")?.let { values ->
            (0 until values.length()).mapNotNull { index ->
                runCatching { Instant.parse(values.getString(index)).toEpochMilli() }.getOrNull()
            }
        }.orEmpty().filter { it > System.currentTimeMillis() }.distinct().sorted()
        val next = mutableSetOf<String>()
        for (at in times) {
            alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending(context, task.id, task.title, due, at))
            next += at.toString()
        }
        rememberTask(context, task, times)
        prefs(context).edit().putStringSet(key, next).apply()
    }

    private fun rememberTask(context: Context, task: Task, times: List<Long>) {
        val record = JSONObject()
            .put("id", task.id)
            .put("title", task.title)
            .put("due_at", task.dueAt?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrDefault(0L) } ?: 0L)
            .put("status", task.status)
            .put("times", JSONArray(times))
        prefs(context).edit().putString(taskPrefix + task.id, record.toString()).apply()
    }

    /** AlarmManager alarms do not survive a reboot; restore the last cloud snapshot locally. */
    fun restore(context: Context) {
        ensureChannel(context)
        val manager = alarm(context) ?: return
        val now = System.currentTimeMillis()
        val prefs = prefs(context)
        for ((key, raw) in prefs.all) {
            if (!key.startsWith(taskPrefix) || raw !is String) continue
            val record = runCatching { JSONObject(raw) }.getOrNull() ?: continue
            if (record.optString("status") in listOf("submitted", "archived")) continue
            val taskId = record.optString("id")
            if (taskId.isBlank()) continue
            val title = record.optString("title")
            val dueAt = record.optLong("due_at", 0L)
            val values = record.optJSONArray("times") ?: JSONArray()
            val future = mutableListOf<Long>()
            for (index in 0 until values.length()) {
                val at = values.optLong(index, 0L)
                if (at > now) {
                    manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending(context, taskId, title, dueAt, at))
                    future += at
                }
            }
            record.put("times", JSONArray(future))
            prefs.edit().putString(key, record.toString()).apply()
        }
    }

    fun snooze(context: Context, taskId: String, title: String, dueAt: Long) {
        val at = System.currentTimeMillis() + TimeUnit.MINUTES.toMillis(10)
        alarm(context)?.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending(context, taskId, title, dueAt, at, ACTION_SNOOZE))
    }

    fun notify(context: Context, taskId: String, title: String, dueAt: Long, remindAt: Long) {
        ensureChannel(context)
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val open = PendingIntent.getActivity(
            context, ("open:$taskId").hashCode(),
            Intent(context, MobileShellActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
                putExtra("task_id", taskId)
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val snooze = PendingIntent.getBroadcast(
            context, ("snooze:$taskId:$remindAt").hashCode(),
            Intent(context, NotificationReceiver::class.java).apply {
                action = ACTION_SNOOZE
                data = Uri.parse("jjb://snooze/${Uri.encode(taskId)}/$remindAt")
                putExtra("task_id", taskId)
                putExtra("title", title)
                putExtra("due_at", dueAt)
                putExtra("remind_at", remindAt)
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val dueText = if (dueAt > 0) "截止 ${java.text.DateFormat.getDateTimeInstance().format(java.util.Date(dueAt))}" else "该处理这项待办了"
        val notification = NotificationCompat.Builder(context, channelId)
            .setSmallIcon(R.drawable.ic_jiaojianbox)
            .setContentTitle(title.ifBlank { "待办提醒" })
            .setContentText(dueText)
            .setStyle(NotificationCompat.BigTextStyle().bigText(dueText))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setAutoCancel(true)
            .setContentIntent(open)
            .addAction(0, "稍后 10 分钟", snooze)
            .build()
        NotificationManagerCompat.from(context).notify(("task:$taskId:$remindAt").hashCode(), notification)
    }
}

class NotificationReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val taskId = intent.getStringExtra("task_id").orEmpty()
        val title = intent.getStringExtra("title").orEmpty()
        val dueAt = intent.getLongExtra("due_at", 0L)
        val remindAt = intent.getLongExtra("remind_at", System.currentTimeMillis())
        if (taskId.isBlank()) return
        NotificationScheduler.notify(context, taskId, title, dueAt, remindAt)
    }
}

class NotificationBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
            NotificationScheduler.restore(context)
        }
    }
}
