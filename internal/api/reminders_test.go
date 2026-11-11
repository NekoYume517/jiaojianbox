package api

import (
	"strconv"
	"testing"
	"time"
)

func reminderRows(value any) []Object {
	rows := []Object{}
	items, _ := value.([]any)
	for _, item := range items {
		if row, ok := item.(map[string]any); ok {
			rows = append(rows, row)
		}
	}
	return rows
}

func TestReminderProjectionIsCompactAndOwnerScoped(t *testing.T) {
	s := testServer(t)
	owner, _ := login(t, s, "reminder-owner")
	other, _ := login(t, s, "reminder-other")

	due := time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano)
	reminder := time.Now().Add(30 * time.Minute).UTC().Format(time.RFC3339Nano)
	code, task := call(t, s, "POST", "/api/tasks", owner, Object{
		"title":     "提交实验报告",
		"due_at":    due,
		"reminders": []any{reminder},
		"requirements": []any{
			Object{"label": "实验报告"},
			Object{"label": "运行截图"},
		},
	})
	if code != 201 {
		t.Fatalf("create task: %d %v", code, task)
	}
	taskID := str(task, "id")
	for index, name := range []string{"report.pdf", "screenshot.png"} {
		route := "/api/tasks/" + taskID + "/files?version=" + strconv.Itoa(index+1)
		if code, out := uploaded(t, s, route, owner, name, []byte(name)); code != 201 {
			t.Fatalf("upload %s: %d %v", name, code, out)
		}
	}

	code, out := call(t, s, "GET", "/api/reminders", owner, nil)
	if code != 200 {
		t.Fatalf("get reminders: %d %v", code, out)
	}
	tasks := reminderRows(out["tasks"])
	if len(tasks) != 1 {
		t.Fatalf("got %d tasks: %v", len(tasks), out)
	}
	got := tasks[0]
	if str(got, "id") != taskID || str(got, "title") != "提交实验报告" || str(got, "due_at") != due {
		t.Fatalf("unexpected task projection: %v", got)
	}
	if got["requirement_count"] != float64(2) && got["requirement_count"] != 2 {
		t.Fatalf("requirement_count = %#v", got["requirement_count"])
	}
	if got["material_count"] != float64(2) && got["material_count"] != 2 {
		t.Fatalf("material_count = %#v", got["material_count"])
	}
	reminders, _ := got["reminders"].([]any)
	if len(reminders) != 1 || reminders[0] != reminder {
		t.Fatalf("reminders = %#v", got["reminders"])
	}
	for _, key := range []string{"attachments", "messages", "description", "requirements"} {
		if _, exists := got[key]; exists {
			t.Fatalf("projection unexpectedly contains %q", key)
		}
	}

	code, otherOut := call(t, s, "GET", "/api/reminders", other, nil)
	if code != 200 || len(reminderRows(otherOut["tasks"])) != 0 {
		t.Fatalf("owner isolation: %d %v", code, otherOut)
	}
}
