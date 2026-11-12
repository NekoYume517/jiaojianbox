package api

import (
	"context"
	"strings"

	"github.com/NekoYume517/jiaojianbox/internal/store"
)

const maxTaskSourceMessages = 30

func taskSourceMessage(message Object) Object {
	out := Object{}
	for _, key := range []string{"id", "source", "account_id", "conversation_id", "conversation_name", "sender_name", "sender_id", "sent_at"} {
		out[key] = message[key]
	}
	out["text"] = clip(str(message, "text"), 12000)
	return out
}

func sameSourceConversation(left, right Object) bool {
	return str(left, "conversation_id") != "" &&
		str(left, "conversation_id") == str(right, "conversation_id") &&
		str(left, "source") == str(right, "source")
}

func taskMatchesConversation(ctx context.Context, db store.SQL, user string, task, message Object) bool {
	for _, source := range objects(task["source_messages"]) {
		if sameSourceConversation(source, message) {
			return true
		}
	}
	if sourceID := str(task, "source_message_id"); sourceID != "" {
		row := first(query(ctx, db, "SELECT payload FROM messages WHERE id=? AND user_id=?", sourceID, user))
		if row != nil && sameSourceConversation(store.Payload(row), message) {
			return true
		}
	}
	return false
}

func appendTaskSources(task Object, message Object) []any {
	sources := []any{}
	if sourceID := str(task, "source_message_id"); sourceID != "" {
		for _, source := range objects(task["source_messages"]) {
			if str(source, "id") == sourceID {
				sources = append(sources, source)
				break
			}
		}
	}
	for _, source := range objects(task["source_messages"]) {
		found := false
		for _, existing := range sources {
			if str(object(existing), "id") == str(source, "id") {
				found = true
				break
			}
		}
		if !found {
			sources = append(sources, source)
		}
	}
	if str(message, "id") != "" {
		found := false
		for _, source := range sources {
			if str(object(source), "id") == str(message, "id") {
				found = true
				break
			}
		}
		if !found {
			sources = append(sources, taskSourceMessage(message))
		}
	}
	if len(sources) > maxTaskSourceMessages {
		kept := []any{sources[0]}
		kept = append(kept, sources[len(sources)-(maxTaskSourceMessages-1):]...)
		sources = kept
	}
	return sources
}

func mergeTaskRequirements(existing, additions any) []any {
	merged := []Object{}
	index := map[string]int{}
	merge := func(value any) {
		req := object(value)
		label := strings.TrimSpace(clip(fmtValue(req["label"]), 100))
		if label == "" {
			return
		}
		key := strings.ToLower(strings.Join(strings.Fields(label), " "))
		extensions := []string{}
		seenExtensions := map[string]bool{}
		for _, value := range asList(req["extensions"], 12) {
			ext := strings.TrimLeft(strings.ToLower(strings.TrimSpace(fmtValue(value))), "*.")
			if extensionPattern.MatchString(ext) && !seenExtensions[ext] {
				seenExtensions[ext] = true
				extensions = append(extensions, ext)
			}
		}
		count := int(num(req, "min_count"))
		if count < 1 {
			count = 1
		}
		if count > 50 {
			count = 50
		}
		normalized := Object{"label": label, "extensions": extensions, "min_count": count}
		if position, ok := index[key]; ok {
			merged[position] = normalized
			return
		}
		if len(merged) < 50 {
			index[key] = len(merged)
			merged = append(merged, normalized)
		}
	}
	for _, req := range objects(existing) {
		merge(req)
	}
	for _, req := range objects(additions) {
		merge(req)
	}
	out := make([]any, 0, len(merged))
	for _, req := range merged {
		out = append(out, req)
	}
	return out
}

func mergeTaskReminders(existing, additions any) []any {
	out := []any{}
	seen := map[string]bool{}
	merge := func(values any) {
		for _, value := range asList(values, 20) {
			if date := iso(value); date != nil && !seen[date.(string)] {
				seen[date.(string)] = true
				out = append(out, date)
			}
			if len(out) == 5 {
				return
			}
		}
	}
	merge(existing)
	merge(additions)
	return out
}

func appendPatchHasChanges(patch Object) bool {
	if str(patch, "due_at") != "" || str(patch, "urgency") != "" || str(patch, "naming_hint") != "" || str(patch, "submit_url") != "" {
		return true
	}
	if num(patch, "max_total_bytes") > 0 || len(list(patch, "requirements")) > 0 || len(list(patch, "reminder_suggestions")) > 0 {
		return true
	}
	return false
}

func appendPatchFromAnalysis(result Object) Object {
	patch := Object{"reason": result["reason"]}
	for _, key := range []string{"due_at", "urgency", "requirements", "max_total_bytes", "naming_hint", "submit_url", "reminder_suggestions"} {
		if result[key] != nil {
			patch[key] = result[key]
		}
	}
	return patch
}

// appendToTask merges one follow-up message into an existing task. The target
// message and task must belong to the same QQ/WeChat conversation. Repeating the
// same message is idempotent and never appends it twice.
func (s *Server) appendToTask(ctx context.Context, db store.SQL, user, messageID, taskID string, patch Object) Object {
	messageRow := first(query(ctx, db, "SELECT payload FROM messages WHERE id=? AND user_id=?", messageID, user))
	if messageRow == nil {
		return Object{"error": "来源通知不存在"}
	}
	taskRow := first(query(ctx, db, "SELECT payload FROM tasks WHERE id=? AND user_id=?", taskID, user))
	if taskRow == nil {
		return Object{"error": "待办不存在"}
	}
	message := store.Payload(messageRow)
	task := store.Payload(taskRow)
	if !taskMatchesConversation(ctx, db, user, task, message) {
		return Object{"error": "只能追加到同一 QQ/微信会话建立的待办"}
	}
	if len(objects(task["source_messages"])) == 0 {
		if sourceID := str(task, "source_message_id"); sourceID != "" {
			row := first(query(ctx, db, "SELECT payload FROM messages WHERE id=? AND user_id=?", sourceID, user))
			if row != nil {
				task["source_messages"] = []any{taskSourceMessage(store.Payload(row))}
			}
		}
	}
	for _, source := range objects(task["source_messages"]) {
		if str(source, "id") == messageID {
			return Object{"task_id": taskID, "appended": false, "already_present": true}
		}
	}

	changed := []any{}
	if due := iso(patch["due_at"]); due != nil && due != task["due_at"] {
		task["due_at"] = due
		changed = append(changed, "due_at")
	}
	if urgency := strings.ToLower(strings.TrimSpace(str(patch, "urgency"))); choice(urgency, "high", "normal", "low") && urgency != str(task, "urgency") {
		task["urgency"] = urgency
		changed = append(changed, "urgency")
	}
	if requirements := mergeTaskRequirements(task["requirements"], patch["requirements"]); store.JSON(requirements) != store.JSON(task["requirements"]) {
		task["requirements"] = requirements
		changed = append(changed, "requirements")
	}
	if size := num(patch, "max_total_bytes"); size > 0 && size <= 1e12 && size != num(task, "max_total_bytes") {
		task["max_total_bytes"] = int64(size)
		changed = append(changed, "max_total_bytes")
	}
	if hint := strings.TrimSpace(clip(str(patch, "naming_hint"), 300)); hint != "" && hint != str(task, "naming_hint") {
		task["naming_hint"] = hint
		changed = append(changed, "naming_hint")
	}
	if submitURL := strings.TrimSpace(clip(str(patch, "submit_url"), 2000)); (strings.HasPrefix(submitURL, "http://") || strings.HasPrefix(submitURL, "https://")) && submitURL != str(task, "submit_url") {
		task["submit_url"] = submitURL
		changed = append(changed, "submit_url")
	}
	if reminders := mergeTaskReminders(task["reminders"], patch["reminder_suggestions"]); store.JSON(reminders) != store.JSON(task["reminders"]) {
		task["reminders"] = reminders
		changed = append(changed, "reminders")
	}

	sources := appendTaskSources(task, message)
	task["source_messages"] = sources
	history := asList(task["append_log"], 40)
	history = append(history, Object{
		"at":             store.Now(),
		"message_id":     messageID,
		"changed_fields": changed,
		"reason":         clip(fmtValue(patch["reason"]), 1000),
	})
	if len(history) > 40 {
		history = history[len(history)-40:]
	}
	task["append_log"] = history
	changed = append(changed, "source_messages")

	// Reuse the regular task contract so model-provided values cannot bypass
	// field lengths, URLs, dates, reminders or status validation.
	validated := taskInput(task)
	for key, value := range validated {
		task[key] = value
	}
	task["source_messages"] = sources
	task["append_log"] = history
	task["version"] = int(num(task, "version")) + 1
	task["updated_at"] = store.Now()
	delete(task, "attachments")
	s.updateTask(ctx, db, user, task)
	message["auto_task_id"] = taskID
	message["auto_task_action"] = "appended"
	exec(ctx, db, "UPDATE messages SET payload=? WHERE id=? AND user_id=?", store.JSON(message), messageID, user)
	event(ctx, db, user, "message.upsert", messageID)
	return Object{
		"task_id":        taskID,
		"appended":       true,
		"changed_fields": changed,
		"task":           compactTasks([]Object{task})[0],
	}
}
