package api

import "context"
import "database/sql"
import "github.com/NekoYume517/jiaojianbox/internal/store"

// Events are committed before their notifications are delivered. In particular,
// do not wake a sync client from inside the SQLite transaction: its snapshot
// could otherwise run before the new task or message is visible.
type eventNotificationsKey struct{}
type eventNotifications struct{ users map[string]bool }

type contextBoundSQL struct {
	ctx context.Context
	store.SQL
}

func (db contextBoundSQL) Context() context.Context { return db.ctx }

func (db contextBoundSQL) ExecContext(_ context.Context, query string, args ...any) (sql.Result, error) {
	return db.SQL.ExecContext(db.ctx, query, args...)
}

func (db contextBoundSQL) QueryContext(_ context.Context, query string, args ...any) (*sql.Rows, error) {
	return db.SQL.QueryContext(db.ctx, query, args...)
}

func (db contextBoundSQL) QueryRowContext(_ context.Context, query string, args ...any) *sql.Row {
	return db.SQL.QueryRowContext(db.ctx, query, args...)
}

func (s *Server) notifyEventUsers(users map[string]bool) {
	for user := range users {
		value, _ := s.eventWake.LoadOrStore(user, make(chan struct{}, 1))
		wake := value.(chan struct{})
		select {
		case wake <- struct{}{}:
		default:
		}
	}
}

func (s *Server) eventNotification(user string) <-chan struct{} {
	value, _ := s.eventWake.LoadOrStore(user, make(chan struct{}, 1))
	return value.(chan struct{})
}

func waitForWake[T any](ctx context.Context, wake <-chan struct{}, fallback <-chan T) bool {
	select {
	case <-ctx.Done():
		return false
	case <-wake:
		return true
	case <-fallback:
		return true
	}
}
