package gui

import (
	"context"
	"errors"
	"fmt"
	"log"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/NekoYume517/jiaojianbox/internal/store"
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/services/notifications"
)

const (
	reminderVaultKey = "desktop-reminders"
	reminderGrace    = 30 * time.Minute
	reminderPoll     = 30 * time.Second
	reminderStartup  = 3 * time.Second
)

// desktopNotifier keeps a failed Windows toast registration from aborting the
// whole application. The Wails service normally returns an error from startup,
// which would stop App.Run before the main window ever appears.
type desktopNotifier struct {
	inner     *notifications.NotificationService
	mu        sync.Mutex
	err       error
	ok        bool
	supported bool
	reason    string
}

func newDesktopNotifier(inner *notifications.NotificationService) *desktopNotifier {
	supported, reason := nativeNotificationsSupported()
	return &desktopNotifier{inner: inner, supported: supported, reason: reason}
}

func (n *desktopNotifier) ServiceName() string { return "desktop-notifications" }

func (n *desktopNotifier) ServiceStartup(ctx context.Context, options application.ServiceOptions) error {
	if !n.supported {
		n.mu.Lock()
		n.err = errors.New(n.reason)
		n.mu.Unlock()
		return nil
	}
	err := n.inner.ServiceStartup(ctx, options)
	n.mu.Lock()
	n.err = err
	n.ok = err == nil
	n.mu.Unlock()
	if err != nil {
		log.Printf("Windows 原生通知不可用，桌面提醒已停用: %v", err)
	}
	return nil
}

func (n *desktopNotifier) ServiceShutdown() error {
	n.mu.Lock()
	ok := n.ok
	n.mu.Unlock()
	if !ok {
		return nil
	}
	return n.inner.ServiceShutdown()
}

func (n *desktopNotifier) onResponse(callback func(notifications.NotificationResult)) {
	n.inner.OnNotificationResponse(callback)
}

func (n *desktopNotifier) send(options notifications.NotificationOptions) error {
	n.mu.Lock()
	err := n.err
	ok := n.ok
	supported := n.supported
	reason := n.reason
	n.mu.Unlock()
	if !supported {
		return errors.New(reason)
	}
	if err != nil {
		return err
	}
	if !ok {
		return errors.New("Windows 原生通知服务尚未就绪")
	}
	return n.inner.SendNotification(options)
}

func (n *desktopNotifier) status() (bool, bool, string) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if !n.supported {
		return false, false, n.reason
	}
	if n.err != nil {
		return true, false, "Windows 原生通知不可用：" + n.err.Error()
	}
	if !n.ok {
		return true, false, "Windows 原生通知服务正在启动"
	}
	return true, true, ""
}

func (d *Desktop) setupReminders() {
	d.notifier = newDesktopNotifier(notifications.New())
	d.reminderEnabled = true
	d.reminderFired = map[string]string{}
	value, err := d.vault.get(reminderVaultKey)
	if err != nil || value == nil {
		return
	}
	saved := getObject(value)
	if enabled, ok := saved["enabled"].(bool); ok {
		d.reminderEnabled = enabled
	}
	for key, raw := range getObject(saved["fired"]) {
		if firedAt, ok := raw.(string); ok {
			d.reminderFired[key] = firedAt
		}
	}
}

func (d *Desktop) saveReminderState() error {
	d.reminderMu.Lock()
	fired := Object{}
	for key, value := range d.reminderFired {
		fired[key] = value
	}
	state := Object{"enabled": d.reminderEnabled, "fired": fired}
	d.reminderMu.Unlock()
	return d.vault.set(reminderVaultKey, state)
}

func (d *Desktop) reminderStatus() Object {
	supported, available, notificationError := d.notifier.status()
	d.reminderMu.Lock()
	defer d.reminderMu.Unlock()
	return Object{
		"enabled":               d.reminderEnabled,
		"next_at":               d.reminderNext,
		"next_title":            d.reminderNextTitle,
		"last_checked":          d.reminderChecked,
		"native_supported":      supported,
		"native_available":      available,
		"native_error":          notificationError,
		"minimum_windows_build": "Windows 10",
	}
}

func (d *Desktop) setReminderEnabled(enabled bool) (Object, error) {
	d.reminderMu.Lock()
	d.reminderEnabled = enabled
	d.reminderMu.Unlock()
	if err := d.saveReminderState(); err != nil {
		return nil, err
	}
	return d.reminderStatus(), nil
}

func (d *Desktop) startReminders() {
	if !d.notifier.supported {
		log.Printf("桌面提醒未启动: %s", d.notifier.reason)
		return
	}
	d.reminderOnce.Do(func() {
		go d.reminderLoop()
	})
}

func (d *Desktop) reminderLoop() {
	timer := time.NewTimer(reminderStartup)
	defer timer.Stop()
	for {
		select {
		case <-d.ctx.Done():
			return
		case <-timer.C:
		}
		d.checkReminders()
		timer.Reset(reminderPoll)
	}
}

func (d *Desktop) checkReminders() {
	d.reminderMu.Lock()
	enabled := d.reminderEnabled
	fired := map[string]bool{}
	for key := range d.reminderFired {
		fired[key] = true
	}
	d.reminderMu.Unlock()
	if !enabled {
		return
	}
	tasks, err := d.reminderTasks()
	if err != nil {
		return
	}
	now := time.Now()
	hits, active, next := reminderDecision(tasks, now, fired, reminderGrace)
	sent := false
	d.reminderMu.Lock()
	for _, hit := range hits {
		if !d.reminderEnabled {
			break
		}
		if err := d.sendReminder(hit); err != nil {
			log.Printf("发送待办提醒失败: %v", err)
			continue
		}
		d.reminderFired[hit.Key] = now.UTC().Format(time.RFC3339Nano)
		sent = true
	}
	if next.At.IsZero() {
		d.reminderNext, d.reminderNextTitle = "", ""
	} else {
		d.reminderNext = next.At.Format(time.RFC3339Nano)
		d.reminderNextTitle = next.Title
	}
	d.reminderChecked = now.UTC().Format(time.RFC3339Nano)
	d.reminderMu.Unlock()
	d.pruneFired(active, sent)
}

func (d *Desktop) pruneFired(active map[string]bool, forceSave bool) {
	d.reminderMu.Lock()
	changed := false
	for key := range d.reminderFired {
		if !active[key] {
			delete(d.reminderFired, key)
			changed = true
		}
	}
	d.reminderMu.Unlock()
	if changed || forceSave {
		_ = d.saveReminderState()
	}
}

func (d *Desktop) reminderTasks() ([]reminderTask, error) {
	out, err := d.jsonRequest("GET", "/api/reminders", nil)
	if err == nil {
		return reminderTasksFrom(out), nil
	}
	// Older servers do not expose /api/reminders yet. Fall back to the full
	// snapshot so upgrading the desktop first does not silently lose reminders.
	snapshot, snapshotErr := d.jsonRequest("GET", "/api/snapshot", nil)
	if snapshotErr != nil {
		return nil, snapshotErr
	}
	return reminderTasksFromSnapshot(snapshot), nil
}

func (d *Desktop) sendReminder(hit reminderHit) error {
	body := hit.Title
	details := []string{}
	if hit.DueAt != "" {
		if due, err := time.Parse(time.RFC3339Nano, hit.DueAt); err == nil {
			details = append(details, "截止 "+due.In(time.Local).Format("01月02日 15:04"))
		}
	}
	if hit.Requirements > 0 {
		details = append(details, fmt.Sprintf("材料 %d/%d", hit.Materials, hit.Requirements))
	}
	if len(details) > 0 {
		body += "\n" + strings.Join(details, " · ")
	}
	return d.notifier.send(notifications.NotificationOptions{
		ID:                hit.Key,
		Title:             "交件箱 · 待办提醒",
		Body:              truncateRunes(body, 300),
		InterruptionLevel: notifications.InterruptionLevelTimeSensitive,
		Data: map[string]any{
			"task_id":  hit.TaskID,
			"reminder": hit.At.Format(time.RFC3339Nano),
		},
	})
}

func (d *Desktop) sendTestReminder() (Object, error) {
	err := d.notifier.send(notifications.NotificationOptions{
		ID:    "reminder-test-" + strconv.FormatInt(time.Now().UnixNano(), 36),
		Title: "交件箱 · Windows 通知测试",
		Body:  "桌面提醒已启用。点击这条通知可以打开交件箱。",
		Data:  map[string]any{"test": true},
	})
	if err != nil {
		return Object{"ok": false, "message": "发送失败：" + err.Error()}, nil
	}
	return Object{"ok": true, "message": "已发送测试通知，请查看 Windows 通知中心。"}, nil
}

func (d *Desktop) handleNotificationResponse(result notifications.NotificationResult) {
	if result.Error != nil {
		log.Printf("解析通知响应失败: %v", result.Error)
		return
	}
	info := result.Response.UserInfo
	if info == nil {
		return
	}
	taskID, _ := info["task_id"].(string)
	d.openReminderTask(taskID)
}

func (d *Desktop) openReminderTask(taskID string) {
	d.reminderOpenMu.Lock()
	if taskID != "" {
		d.reminderOpenTask = taskID
	}
	d.reminderOpenMu.Unlock()
	d.showMain()
	d.flushReminderTask()
}

func (d *Desktop) flushReminderTask() {
	d.reminderOpenMu.Lock()
	taskID := d.reminderOpenTask
	d.reminderOpenMu.Unlock()
	if taskID == "" || d.main == nil {
		return
	}
	d.windowMu.Lock()
	ready := d.windowReady
	d.windowMu.Unlock()
	if !ready {
		return
	}
	d.reminderOpenMu.Lock()
	if d.reminderOpenTask == taskID {
		d.reminderOpenTask = ""
	}
	d.reminderOpenMu.Unlock()
	d.main.ExecJS("window.jjbOpenTask && window.jjbOpenTask(" + strconv.Quote(taskID) + ")")
}

type reminderTask struct {
	ID           string
	Title        string
	Status       string
	DueAt        string
	Reminders    []string
	Requirements int
	Materials    int
}

type reminderHit struct {
	Key          string
	TaskID       string
	Title        string
	DueAt        string
	At           time.Time
	Requirements int
	Materials    int
}

// reminderDecision is pure so the scheduling rules can be tested without a
// running desktop shell or a real clock.
func reminderDecision(tasks []reminderTask, now time.Time, fired map[string]bool, grace time.Duration) (hits []reminderHit, active map[string]bool, next reminderHit) {
	active = map[string]bool{}
	for _, task := range tasks {
		for _, raw := range task.Reminders {
			at, err := time.Parse(time.RFC3339Nano, raw)
			if err != nil {
				continue
			}
			key := task.ID + "|" + raw
			active[key] = true
			if task.Status == "submitted" || task.Status == "archived" {
				continue
			}
			hit := reminderHit{
				Key:          key,
				TaskID:       task.ID,
				Title:        task.Title,
				DueAt:        task.DueAt,
				At:           at,
				Requirements: task.Requirements,
				Materials:    task.Materials,
			}
			if at.After(now) {
				if next.At.IsZero() || at.Before(next.At) {
					next = hit
				}
				continue
			}
			if now.Sub(at) > grace || fired[key] {
				continue
			}
			hits = append(hits, hit)
		}
	}
	sort.Slice(hits, func(i, j int) bool { return hits[i].At.Before(hits[j].At) })
	return hits, active, next
}

func reminderTasksFrom(value Object) []reminderTask {
	tasks := []reminderTask{}
	for _, item := range objectSlice(value["tasks"]) {
		tasks = append(tasks, reminderTask{
			ID:           getString(item, "id"),
			Title:        getString(item, "title"),
			Status:       getString(item, "status"),
			DueAt:        getString(item, "due_at"),
			Reminders:    stringSlice(item["reminders"]),
			Requirements: int(store.Number(item, "requirement_count")),
			Materials:    int(store.Number(item, "material_count")),
		})
	}
	return tasks
}

func reminderTasksFromSnapshot(value Object) []reminderTask {
	tasks := []reminderTask{}
	for _, item := range objectSlice(value["tasks"]) {
		materials := 0
		for _, attachment := range objectSlice(item["attachments"]) {
			if getString(attachment, "kind") == "material" {
				materials++
			}
		}
		tasks = append(tasks, reminderTask{
			ID:           getString(item, "id"),
			Title:        getString(item, "title"),
			Status:       getString(item, "status"),
			DueAt:        getString(item, "due_at"),
			Reminders:    stringSlice(item["reminders"]),
			Requirements: len(objectSlice(item["requirements"])),
			Materials:    materials,
		})
	}
	return tasks
}

func objectSlice(value any) []Object {
	out := []Object{}
	if items, ok := value.([]any); ok {
		for _, item := range items {
			if object, ok := item.(map[string]any); ok {
				out = append(out, object)
			}
		}
	}
	if items, ok := value.([]Object); ok {
		out = append(out, items...)
	}
	return out
}

func stringSlice(value any) []string {
	out := []string{}
	if items, ok := value.([]any); ok {
		for _, item := range items {
			if text, ok := item.(string); ok {
				out = append(out, text)
			}
		}
	}
	if items, ok := value.([]string); ok {
		out = append(out, items...)
	}
	return out
}

func truncateRunes(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit]) + "…"
}
