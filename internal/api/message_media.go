package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"os"
	"strings"

	"github.com/NekoYume517/jiaojianbox/internal/store"
	_ "golang.org/x/image/webp"
)

const maxMessageImageBytes = 20 << 20

type messageImageUpload struct {
	data []byte
}

func messageInput(r request) (Object, *messageImageUpload) {
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/form-data") {
		return r.body(), nil
	}
	r.Body = http.MaxBytesReader(r.W, r.Body, maxMessageImageBytes+(2<<20))
	check(r.ParseMultipartForm(2 << 20))
	b := decodeObject(r.FormValue("payload"))
	if r.MultipartForm == nil || len(r.MultipartForm.File["media"]) == 0 {
		if r.MultipartForm != nil {
			r.MultipartForm.RemoveAll()
		}
		return b, nil
	}
	file, err := r.MultipartForm.File["media"][0].Open()
	check(err)
	data, readErr := io.ReadAll(io.LimitReader(file, maxMessageImageBytes+1))
	closeErr := file.Close()
	r.MultipartForm.RemoveAll()
	check(readErr)
	check(closeErr)
	if len(data) > maxMessageImageBytes {
		fail(413, "微信图片超过 20 MB，未上传")
	}
	return b, &messageImageUpload{data: data}
}

func (s *Server) storeMessageImage(r request, db store.SQL, messageID string, upload *messageImageUpload, media Object) Object {
	if upload == nil {
		if len(media) > 0 {
			return Object{"kind": "image", "status": fallback(str(media, "status"), "not_downloaded"), "tier": str(media, "tier")}
		}
		return nil
	}
	data := upload.data
	if str(media, "status") != "ready" {
		fail(422, "微信图片内容无效")
	}
	mime := str(media, "mime")
	if !choice(mime, "image/jpeg", "image/png", "image/gif", "image/webp") {
		fail(415, "不支持的微信图片格式")
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width <= 0 || config.Height <= 0 || int64(config.Width)*int64(config.Height) > 40_000_000 {
		fail(422, "微信图片无法解码或尺寸过大")
	}
	if (format == "jpeg" && mime != "image/jpeg") || (format != "jpeg" && mime != "image/"+format) {
		fail(422, "微信图片声明格式与实际内容不符")
	}
	id := store.ID()
	path := s.blob(id)
	s.checkUserQuota(r.Context(), db, r.User, int64(len(data)))
	check(os.WriteFile(path, data, 0600))
	stored := false
	defer func() {
		if !stored {
			os.Remove(path)
		}
	}()
	extension := map[string]string{"image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp"}[mime]
	hash := sha256.Sum256(data)
	exec(r.Context(), db, `INSERT INTO message_media(id,user_id,message_id,name,mime,size,sha256,created_at) VALUES(?,?,?,?,?,?,?,?)`,
		id, r.User, messageID, "微信图片"+extension, mime, len(data), hex.EncodeToString(hash[:]), store.Now())
	stored = true
	return Object{"id": id, "kind": "image", "status": "ready", "mime": mime, "size": len(data), "tier": str(media, "tier")}
}

func (s *Server) messageMedia(ctx context.Context, db store.SQL, user, messageID string) Object {
	row := first(query(ctx, db, `SELECT mm.id,mm.message_id,mm.mime,mm.size FROM message_media mm JOIN messages m ON m.id=mm.message_id AND m.user_id=mm.user_id
		WHERE mm.user_id=? AND mm.message_id=? AND m.deleted_at IS NULL ORDER BY mm.rowid LIMIT 1`, user, messageID))
	if row == nil {
		return nil
	}
	return Object{"id": row["id"], "kind": "image", "status": "ready", "mime": row["mime"], "size": row["size"]}
}

func (s *Server) messageMediaRoutes() {
	s.route("GET /api/messages/{message_id}/media/{media_id}", "owner", func(r request) any {
		media := one(r.Context(), s.Store.DB, `SELECT mm.* FROM message_media mm JOIN messages m ON m.id=mm.message_id AND m.user_id=mm.user_id
			WHERE mm.id=? AND mm.message_id=? AND mm.user_id=? AND m.deleted_at IS NULL`, r.PathValue("media_id"), r.PathValue("message_id"), r.User)
		r.W.Header().Set("Content-Type", str(media, "mime"))
		r.W.Header().Set("Content-Disposition", "inline")
		r.W.Header().Set("Cache-Control", "private, max-age=3600")
		r.W.Header().Set("X-Content-Type-Options", "nosniff")
		http.ServeFile(r.W, r.Request, s.blob(str(media, "id")))
		return nil
	})
}
