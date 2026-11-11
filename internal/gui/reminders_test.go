package gui

import (
	"strings"
	"testing"
	"time"
)

func TestReminderDecisionUsesGraceAndSelectsEarliestNext(t *testing.T) {
	now := time.Date(2026, 11, 11, 12, 0, 0, 0, time.Local)
	due := now.Add(2 * time.Hour).Format(time.RFC3339Nano)
	tasks := []reminderTask{
		{
			ID:           "inside-grace",
			Title:        "正在截止",
			DueAt:        due,
			Status:       "ready",
			Reminders:    []string{now.Add(-10 * time.Minute).Format(time.RFC3339Nano)},
			Requirements: 2,
			Materials:    1,
		},
		{
			ID:        "expired",
			Title:     "过时提醒",
			Status:    "ready",
			Reminders: []string{now.Add(-31 * time.Minute).Format(time.RFC3339Nano)},
		},
		{
			ID:        "already-fired",
			Title:     "已经提醒",
			Status:    "ready",
			Reminders: []string{now.Add(-time.Minute).Format(time.RFC3339Nano)},
		},
		{
			ID:        "submitted",
			Title:     "已提交",
			Status:    "submitted",
			Reminders: []string{now.Add(-time.Minute).Format(time.RFC3339Nano)},
		},
		{
			ID:        "archived",
			Title:     "已归档",
			Status:    "archived",
			Reminders: []string{now.Add(-time.Minute).Format(time.RFC3339Nano)},
		},
		{
			ID:        "next-later",
			Title:     "稍后提醒",
			Status:    "ready",
			Reminders: []string{now.Add(20 * time.Minute).Format(time.RFC3339Nano)},
		},
		{
			ID:        "next-earlier",
			Title:     "最近提醒",
			Status:    "ready",
			Reminders: []string{now.Add(5 * time.Minute).Format(time.RFC3339Nano)},
		},
	}
	firedKey := "already-fired|" + tasks[2].Reminders[0]

	hits, active, next := reminderDecision(tasks, now, map[string]bool{firedKey: true}, 30*time.Minute)
	if len(hits) != 1 || hits[0].TaskID != "inside-grace" {
		t.Fatalf("hits = %#v", hits)
	}
	if hits[0].Requirements != 2 || hits[0].Materials != 1 || hits[0].DueAt != due {
		t.Fatalf("hit details = %#v", hits[0])
	}
	if next.TaskID != "next-earlier" || !next.At.Equal(now.Add(5*time.Minute)) {
		t.Fatalf("next = %#v", next)
	}
	if !active[firedKey] {
		t.Fatal("active reminder was not retained for persisted fired-state pruning")
	}
}

func TestReminderParsingAndTruncation(t *testing.T) {
	extracted := reminderTasksFrom(Object{"tasks": []any{
		Object{
			"id":                "task-1",
			"title":             "课程提交",
			"status":            "ready",
			"due_at":            "2026-11-11T18:00:00+08:00",
			"reminders":         []any{"2026-11-11T17:00:00+08:00"},
			"requirement_count": 3,
			"material_count":    2,
		},
	}})
	if len(extracted) != 1 || extracted[0].Requirements != 3 || extracted[0].Materials != 2 {
		t.Fatalf("extracted = %#v", extracted)
	}

	fromSnapshot := reminderTasksFromSnapshot(Object{"tasks": []any{
		Object{
			"id":           "task-2",
			"title":        "快照任务",
			"requirements": []any{Object{"label": "报告"}, Object{"label": "截图"}},
			"attachments": []any{
				Object{"kind": "material"},
				Object{"kind": "receipt"},
				Object{"kind": "material"},
			},
		},
	}})
	if len(fromSnapshot) != 1 || fromSnapshot[0].Requirements != 2 || fromSnapshot[0].Materials != 2 {
		t.Fatalf("snapshot = %#v", fromSnapshot)
	}

	if got := truncateRunes("交件箱提醒", 10); got != "交件箱提醒" {
		t.Fatalf("short truncate = %q", got)
	}
	if got := truncateRunes("交件箱提醒", 3); got != "交件箱…" || strings.Count(got, "…") != 1 {
		t.Fatalf("long truncate = %q", got)
	}
}
