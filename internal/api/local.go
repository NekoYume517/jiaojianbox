package api

import (
	"context"
	"github.com/NekoYume517/jiaojianbox/internal/store"
)

// LocalSession is only called by the native desktop, never mounted as an HTTP route.
// Existing offline users retain their ID, password, tasks and files.
func (s *Server) LocalSession(ctx context.Context) (Object, error) {
	value, err := attempt(func() any {
		return s.transaction(ctx, func(db store.SQL) any {
			row := first(query(ctx, db, "SELECT id,username FROM users WHERE username='offline'"))
			if row == nil {
				salt, digest, err := store.NewPassword(store.Token())
				check(err)
				id := store.ID()
				exec(ctx, db, "INSERT INTO users VALUES(?,?,?,?)", id, "offline", salt, digest)
				row = Object{"id": id, "username": "offline"}
			}
			exec(ctx, db, "INSERT OR REPLACE INTO user_roles VALUES(?,'superadmin')", row["id"])
			exec(ctx, db, "INSERT OR IGNORE INTO site_settings VALUES('registration_mode','closed')")
			return Object{"token": s.newSession(ctx, db, str(row, "id")), "user_id": row["id"], "username": "offline", "mode": "offline"}
		})
	})
	if err != nil {
		return nil, err
	}
	return value.(Object), nil
}
