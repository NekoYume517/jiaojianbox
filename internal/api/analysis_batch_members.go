package api

import (
	"context"

	"github.com/NekoYume517/jiaojianbox/internal/store"
)

// Manual analysis keeps the existing immediate single-message behavior.
// Automatic calls receive the exact members claimed by the queue transaction.
func (s *Server) analysisBatch(ctx context.Context, db store.SQL, user, messageID string, body Object) []Object {
	ids := []string{messageID}
	if boolean(body, "_automatic") {
		ids = []string{}
		for _, value := range list(body, "message_ids") {
			if id, ok := value.(string); ok && id != "" {
				ids = append(ids, id)
			}
		}
		if len(ids) == 0 {
			if job := first(query(ctx, db, "SELECT window_key FROM analysis_jobs WHERE user_id=? AND message_id=?", user, messageID)); job != nil && str(job, "window_key") != "" {
				for _, row := range query(ctx, db, "SELECT message_id FROM analysis_jobs WHERE user_id=? AND window_key=? AND state IN ('queued','running') ORDER BY id", user, job["window_key"]) {
					ids = append(ids, str(row, "message_id"))
				}
			} else {
				ids = append(ids, messageID)
			}
		}
	}
	out := []Object{}
	for _, id := range ids {
		if row := first(query(ctx, db, "SELECT payload FROM messages WHERE id=? AND user_id=? AND deleted_at IS NULL", id, user)); row != nil {
			out = append(out, store.Payload(row))
		}
	}
	return out
}
