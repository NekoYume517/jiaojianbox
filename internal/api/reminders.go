package api

import (
	"context"

	"github.com/NekoYume517/jiaojianbox/internal/store"
)

// reminderRoutes provides the compact task projection used by the desktop
// reminder scheduler. Keeping it separate from the full workspace snapshot
// avoids transferring messages, file metadata and collection definitions every
// 30 seconds.
func (s *Server) reminderRoutes() {
	s.route("GET /api/reminders", "owner", func(r request) any {
		return s.reminderTasks(r.Context(), r.User)
	})
}

func (s *Server) reminderTasks(ctx context.Context, user string) Object {
	rows := query(ctx, s.Store.DB, "SELECT payload FROM tasks WHERE user_id=? ORDER BY rowid DESC", user)
	tasks := make([]Object, 0, len(rows))
	for _, row := range rows {
		task := store.Payload(row)
		id := str(task, "id")
		materialCount := num(first(query(ctx, s.Store.DB,
			"SELECT COUNT(*) AS count FROM attachments WHERE task_id=? AND user_id=? AND kind='material'",
			id, user)), "count")
		tasks = append(tasks, Object{
			"id":                id,
			"title":             str(task, "title"),
			"status":            str(task, "status"),
			"due_at":            str(task, "due_at"),
			"reminders":         list(task, "reminders"),
			"requirement_count": len(list(task, "requirements")),
			"material_count":    int(materialCount),
		})
	}
	return Object{"tasks": tasks}
}
