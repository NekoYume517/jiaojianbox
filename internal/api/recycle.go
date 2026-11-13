package api

import (
	"context"
	"os"
	"time"

	"github.com/NekoYume517/jiaojianbox/internal/store"
)

const recycleRetention = 30 * 24 * time.Hour

func recycleExpiry(deleted string) string {
	at, err := time.Parse(time.RFC3339Nano, deleted)
	if err != nil {
		at = time.Now()
	}
	return at.Add(recycleRetention).Format(time.RFC3339Nano)
}

func (s *Server) trashTask(r request) Object {
	var task Object
	s.transaction(r.Context(), func(db store.SQL) any {
		task = s.task(r.Context(), db, r.User, r.PathValue("task_id"))
		version(task, r.integer("version", 0, 1, 1e9))
		now := store.Now()
		exec(r.Context(), db, "UPDATE tasks SET deleted_at=? WHERE id=? AND user_id=?", now, task["id"], r.User)
		exec(r.Context(), db, "UPDATE attachments SET deleted_at=? WHERE task_id=? AND user_id=? AND deleted_at IS NULL", now, task["id"], r.User)
		event(r.Context(), db, r.User, "task.delete", str(task, "id"))
		return nil
	})
	return Object{"ok": true, "recoverable": true, "retention_days": 30, "task": task}
}

func (s *Server) recycleRoutes() {
	s.route("GET /api/recycle", "owner", func(r request) any {
		s.purgeExpiredRecycle(r.Context(), s.Store.DB, r.User)
		items := []Object{}
		for _, row := range query(r.Context(), s.Store.DB, "SELECT id,payload,deleted_at FROM tasks WHERE user_id=? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC", r.User) {
			payload := store.Payload(row)
			items = append(items, Object{
				"kind": "task", "id": str(row, "id"), "title": str(payload, "title"),
				"snippet": clip(str(payload, "description"), 180), "deleted_at": row["deleted_at"],
				"expires_at": recycleExpiry(str(row, "deleted_at")),
			})
		}
		for _, row := range query(r.Context(), s.Store.DB, "SELECT id,payload,deleted_at FROM messages WHERE user_id=? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC", r.User) {
			payload := store.Payload(row)
			items = append(items, Object{
				"kind": "message", "id": str(row, "id"), "title": fallback(str(payload, "conversation_name"), "通知"),
				"snippet": clip(str(payload, "text"), 180), "deleted_at": row["deleted_at"],
				"expires_at": recycleExpiry(str(row, "deleted_at")),
			})
		}
		for _, row := range query(r.Context(), s.Store.DB, "SELECT id,task_id,name,size,deleted_at FROM attachments WHERE user_id=? AND deleted_at IS NOT NULL AND task_id IS NULL ORDER BY deleted_at DESC", r.User) {
			items = append(items, Object{
				"kind": "file", "id": str(row, "id"), "title": str(row, "name"),
				"snippet": bytesLabel(int64(num(row, "size"))), "deleted_at": row["deleted_at"],
				"expires_at": recycleExpiry(str(row, "deleted_at")), "size": row["size"],
			})
		}
		return Object{"items": items, "retention_days": 30}
	})
	s.route("POST /api/recycle/{kind}/{item_id}/restore", "owner", func(r request) any {
		kind, id := r.PathValue("kind"), r.PathValue("item_id")
		switch kind {
		case "task":
			s.transaction(r.Context(), func(db store.SQL) any {
				one(r.Context(), db, "SELECT id FROM tasks WHERE id=? AND user_id=? AND deleted_at IS NOT NULL", id, r.User)
				exec(r.Context(), db, "UPDATE tasks SET deleted_at=NULL WHERE id=? AND user_id=?", id, r.User)
				exec(r.Context(), db, "UPDATE attachments SET deleted_at=NULL WHERE task_id=? AND user_id=?", id, r.User)
				event(r.Context(), db, r.User, "task.upsert", id)
				return nil
			})
		case "message":
			s.transaction(r.Context(), func(db store.SQL) any {
				one(r.Context(), db, "SELECT id FROM messages WHERE id=? AND user_id=? AND deleted_at IS NOT NULL", id, r.User)
				exec(r.Context(), db, "UPDATE messages SET deleted_at=NULL WHERE id=? AND user_id=?", id, r.User)
				event(r.Context(), db, r.User, "message.upsert", id)
				return nil
			})
		case "file":
			s.transaction(r.Context(), func(db store.SQL) any {
				one(r.Context(), db, "SELECT id FROM attachments WHERE id=? AND user_id=? AND deleted_at IS NOT NULL", id, r.User)
				exec(r.Context(), db, "UPDATE attachments SET deleted_at=NULL WHERE id=? AND user_id=?", id, r.User)
				event(r.Context(), db, r.User, "shelf.upsert", id)
				return nil
			})
		default:
			fail(422, "回收站类型无效")
		}
		return Object{"ok": true}
	})
	s.route("DELETE /api/recycle/{kind}/{item_id}", "owner", func(r request) any {
		paths := s.permanentDelete(r.Context(), s.Store.DB, r.User, r.PathValue("kind"), r.PathValue("item_id"))
		for _, path := range paths {
			_ = os.Remove(path)
		}
		return Object{"ok": true}
	})
}

func bytesLabel(size int64) string {
	switch {
	case size >= 1<<20:
		return fmtValue(float64(size)/float64(1<<20)) + " MB"
	case size >= 1<<10:
		return fmtValue(float64(size)/float64(1<<10)) + " KB"
	default:
		return fmtValue(size) + " B"
	}
}

func (s *Server) permanentDelete(ctx context.Context, db store.SQL, user, kind, id string) []string {
	paths := []string{}
	switch kind {
	case "task":
		one(ctx, db, "SELECT id FROM tasks WHERE id=? AND user_id=? AND deleted_at IS NOT NULL", id, user)
		for _, row := range query(ctx, db, "SELECT id FROM attachments WHERE task_id=? AND user_id=?", id, user) {
			paths = append(paths, s.blob(str(row, "id")))
		}
		exec(ctx, db, "DELETE FROM tasks WHERE id=? AND user_id=?", id, user)
		exec(ctx, db, "DELETE FROM attachments WHERE task_id=? AND user_id=?", id, user)
		event(ctx, db, user, "task.purge", id)
	case "message":
		one(ctx, db, "SELECT id FROM messages WHERE id=? AND user_id=? AND deleted_at IS NOT NULL", id, user)
		exec(ctx, db, "DELETE FROM messages WHERE id=? AND user_id=?", id, user)
		exec(ctx, db, "DELETE FROM analysis_jobs WHERE message_id=? AND user_id=?", id, user)
		event(ctx, db, user, "message.purge", id)
	case "file":
		one(ctx, db, "SELECT id FROM attachments WHERE id=? AND user_id=? AND deleted_at IS NOT NULL", id, user)
		exec(ctx, db, "DELETE FROM attachments WHERE id=? AND user_id=?", id, user)
		paths = append(paths, s.blob(id))
		event(ctx, db, user, "file.purge", id)
	default:
		fail(422, "回收站类型无效")
	}
	return paths
}

func (s *Server) purgeExpiredRecycle(ctx context.Context, db store.SQL, user string) {
	before := time.Now().Add(-recycleRetention).UTC().Format(time.RFC3339Nano)
	whereUser := ""
	args := []any{before}
	if user != "" {
		whereUser = " AND user_id=?"
		args = append(args, user)
	}
	for _, row := range query(ctx, db, "SELECT id,user_id FROM tasks WHERE deleted_at IS NOT NULL AND deleted_at<?"+whereUser, args...) {
		s.permanentDelete(ctx, db, str(row, "user_id"), "task", str(row, "id"))
	}
	for _, row := range query(ctx, db, "SELECT id,user_id FROM messages WHERE deleted_at IS NOT NULL AND deleted_at<?"+whereUser, args...) {
		s.permanentDelete(ctx, db, str(row, "user_id"), "message", str(row, "id"))
	}
	for _, row := range query(ctx, db, "SELECT id,user_id FROM attachments WHERE deleted_at IS NOT NULL AND task_id IS NULL AND deleted_at<?"+whereUser, args...) {
		paths := s.permanentDelete(ctx, db, str(row, "user_id"), "file", str(row, "id"))
		for _, path := range paths {
			_ = os.Remove(path)
		}
	}
}

func (s *Server) recycleWorker(ctx context.Context) {
	ticker := time.NewTicker(6 * time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.purgeExpiredRecycle(ctx, s.Store.DB, "")
		}
	}
}
