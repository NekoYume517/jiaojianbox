package api

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/NekoYume517/jiaojianbox/internal/store"
)

var badFilename = regexp.MustCompile(`[<>:"/\\|?*\x00-\x1f]`)
var deviceFilename = regexp.MustCompile(`(?i)^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)`)

// defaultQuotaBytes is the per-account server storage allowance unless an
// administrator overrides it in user_quotas (-1 means unlimited).
const defaultQuotaBytes = int64(10) << 30

func safeName(value string) string {
	name := strings.Trim(clip(badFilename.ReplaceAllString(value, "_"), 180), ". ")
	if name == "" {
		name = "未命名文件"
	}
	if deviceFilename.MatchString(name) {
		name = "_" + name
	}
	return name
}
func (s *Server) blob(id string) string { return filepath.Join(s.Store.Root, "files", id) }
func (s *Server) shelfItem(ctx context.Context, db store.SQL, user, id string) Object {
	o := one(ctx, db, "SELECT a.*,s.category,s.suggestion,s.created_at,s.version FROM attachments a JOIN shelf_meta s ON s.file_id=a.id WHERE a.id=? AND a.user_id=?", id, user)
	if text := str(o, "suggestion"); text != "" {
		o["suggestion"] = decodeObject(text)
	} else {
		o["suggestion"] = nil
	}
	return o
}
func (s *Server) shelfItems(ctx context.Context, db store.SQL, user string) []Object {
	rows := query(ctx, db, "SELECT a.id,a.name,a.size,a.sha256,a.kind,a.task_id,s.category,s.suggestion,s.created_at,s.version FROM attachments a JOIN shelf_meta s ON s.file_id=a.id WHERE a.user_id=? ORDER BY s.created_at DESC LIMIT 200", user)
	for _, r := range rows {
		if str(r, "suggestion") != "" {
			r["suggestion"] = decodeObject(str(r, "suggestion"))
		} else {
			r["suggestion"] = nil
		}
	}
	return rows
}
func (s *Server) assign(ctx context.Context, db store.SQL, user, id, target, category string) Object {
	if !choice(category, "inbox", "reference", "other", "material", "receipt") {
		fail(422, "文件分类无效")
	}
	original := s.shelfItem(ctx, db, user, id)
	var taskID any
	if target != "" {
		if !choice(category, "material", "receipt") {
			fail(422, "待办中的文件用途须为材料或回执")
		}
		t := s.task(ctx, db, user, target)
		if str(t, "status") == "archived" && str(original, "task_id") != target {
			fail(400, "已归档待办不能接收新文件")
		}
		s.taskQuota(ctx, db, target, id, int64(num(original, "size")))
		taskID = target
	}
	kind := "material"
	if category == "receipt" {
		kind = "receipt"
	}
	exec(ctx, db, "UPDATE attachments SET task_id=?,kind=? WHERE id=? AND user_id=?", taskID, kind, id, user)
	exec(ctx, db, "UPDATE shelf_meta SET category=?,version=version+1 WHERE file_id=?", category, id)
	seen := map[string]bool{}
	for _, task := range []string{str(original, "task_id"), target} {
		if task != "" && !seen[task] {
			seen[task] = true
			t := s.task(ctx, db, user, task)
			t["version"] = num(t, "version") + 1
			delete(t, "attachments")
			s.updateTask(ctx, db, user, t)
		}
	}
	event(ctx, db, user, "shelf.upsert", id)
	return s.shelfItem(ctx, db, user, id)
}
func (s *Server) taskQuota(ctx context.Context, db store.SQL, id, excluded string, size int64) {
	totals := one(ctx, db, "SELECT COUNT(*) AS count,COALESCE(SUM(size),0) AS size FROM attachments WHERE task_id=? AND id<>?", id, excluded)
	if num(totals, "count") >= 50 || num(totals, "size")+float64(size) > 200<<20 {
		fail(413, "每项待办最多 50 个文件，总大小不超过 200 MB")
	}
}
func (s *Server) userQuota(ctx context.Context, db store.SQL, user string) int64 {
	row, err := store.One(ctx, db, "SELECT bytes FROM user_quotas WHERE user_id=?", user)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		check(err)
	}
	if row == nil {
		return defaultQuotaBytes
	}
	return int64(num(row, "bytes"))
}
func (s *Server) checkUserQuota(ctx context.Context, db store.SQL, user string, incoming int64) {
	quota := s.userQuota(ctx, db, user)
	if quota < 0 {
		return
	}
	used := one(ctx, db, "SELECT COALESCE(SUM(size),0) AS used FROM attachments WHERE user_id=?", user)
	if int64(num(used, "used"))+incoming > quota {
		fail(413, "服务器存储空间已满，请清理文件或联系管理员调整配额")
	}
}
func (s *Server) uploadFile(r request, fn func(store.SQL, Object) any) any {
	r.Body = http.MaxBytesReader(r.W, r.Body, s.MaxUpload+(1<<20))
	checkMultipart := r.ParseMultipartForm(8 << 20)
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}
	if checkMultipart != nil {
		fail(413, "文件过大或上传内容无效")
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		fail(422, "请选择文件")
	}
	defer file.Close()
	id := store.ID()
	path := s.blob(id)
	stored := false
	defer func() {
		if !stored {
			os.Remove(path)
		}
	}()
	out, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	check(err)
	hash := sha256.New()
	size, copyErr := io.Copy(io.MultiWriter(out, hash), io.LimitReader(file, s.MaxUpload+1))
	closeErr := out.Close()
	check(copyErr)
	check(closeErr)
	if size > s.MaxUpload {
		fail(413, "文件超过单文件上传上限")
	}
	value := s.transaction(r.Context(), func(db store.SQL) any {
		s.checkUserQuota(r.Context(), db, r.User, size)
		return fn(db, Object{"id": id, "name": safeName(header.Filename), "size": size, "sha256": hex.EncodeToString(hash.Sum(nil))})
	})
	stored = true
	return value
}
func (s *Server) fileRoutes() {
	s.route("GET /api/storage", "owner", func(r request) any {
		used := one(r.Context(), s.Store.DB, "SELECT COALESCE(SUM(size),0) AS used FROM attachments WHERE user_id=?", r.User)
		quota := s.userQuota(r.Context(), s.Store.DB, r.User)
		return Object{"used": int64(num(used, "used")), "quota": quota, "unlimited": quota < 0, "default_quota": defaultQuotaBytes}
	})
	s.route("POST /api/shelf", "owner", func(r request) any {
		return s.uploadFile(r, func(db store.SQL, f Object) any {
			totals := one(r.Context(), db, "SELECT COUNT(*) AS count,COALESCE(SUM(size),0) AS size FROM attachments WHERE user_id=? AND task_id IS NULL", r.User)
			if num(totals, "count") >= 200 || num(totals, "size")+num(f, "size") > 1<<30 {
				fail(413, "待整理文件空间已满，请先整理或清理")
			}
			exec(r.Context(), db, "INSERT INTO attachments VALUES(?,?,?,?,?,?,?)", f["id"], r.User, nil, f["name"], f["size"], f["sha256"], "material")
			exec(r.Context(), db, "INSERT INTO shelf_meta(file_id,user_id,category,suggestion,created_at) VALUES(?,?,?,?,?)", f["id"], r.User, "inbox", nil, store.Now())
			event(r.Context(), db, r.User, "shelf.upsert", str(f, "id"))
			return s.shelfItem(r.Context(), db, r.User, str(f, "id"))
		})
	})
	s.route("PUT /api/shelf/{file_id}", "owner", func(r request) any {
		b := r.body()
		return s.transaction(r.Context(), func(db store.SQL) any {
			original := s.shelfItem(r.Context(), db, r.User, r.PathValue("file_id"))
			if b["version"] != nil && num(b, "version") != num(original, "version") {
				fail(409, "此文件已在其他设备整理，请刷新")
			}
			return s.assign(r.Context(), db, r.User, r.PathValue("file_id"), str(b, "task_id"), fallback(str(b, "category"), "inbox"))
		})
	})
	s.route("DELETE /api/shelf/{file_id}", "owner", func(r request) any {
		id := r.PathValue("file_id")
		s.transaction(r.Context(), func(db store.SQL) any {
			f := s.shelfItem(r.Context(), db, r.User, id)
			version(f, r.integer("version", 0, 1, 1e9))
			exec(r.Context(), db, "DELETE FROM attachments WHERE id=? AND user_id=?", id, r.User)
			if target := str(f, "task_id"); target != "" {
				t := s.task(r.Context(), db, r.User, target)
				t["version"] = num(t, "version") + 1
				delete(t, "attachments")
				s.updateTask(r.Context(), db, r.User, t)
			}
			event(r.Context(), db, r.User, "shelf.delete", id)
			return nil
		})
		os.Remove(s.blob(id))
		return Object{"ok": true}
	})
	s.route("GET /api/files/{file_id}", "owner", func(r request) any {
		f := one(r.Context(), s.Store.DB, "SELECT * FROM attachments WHERE id=? AND user_id=?", r.PathValue("file_id"), r.User)
		path := s.blob(str(f, "id"))
		if _, err := os.Stat(path); err != nil {
			fail(404, "文件不存在")
		}
		r.W.Header().Set("Content-Type", "application/octet-stream")
		r.W.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": str(f, "name")}))
		http.ServeFile(r.W, r.Request, path)
		return nil
	})
	s.route("POST /api/tasks/{task_id}/files", "owner", func(r request) any {
		target := r.PathValue("task_id")
		kind := fallback(r.URL.Query().Get("kind"), "material")
		if !choice(kind, "material", "receipt") {
			fail(422, "文件用途无效")
		}
		s.task(r.Context(), s.Store.DB, r.User, target)
		return s.uploadFile(r, func(db store.SQL, f Object) any {
			t := s.task(r.Context(), db, r.User, target)
			version(t, r.integer("version", 0, 1, 1e9))
			s.taskQuota(r.Context(), db, target, "", int64(num(f, "size")))
			exec(r.Context(), db, "INSERT INTO attachments VALUES(?,?,?,?,?,?,?)", f["id"], r.User, target, f["name"], f["size"], f["sha256"], kind)
			t["version"] = num(t, "version") + 1
			delete(t, "attachments")
			s.updateTask(r.Context(), db, r.User, t)
			return s.task(r.Context(), db, r.User, target)
		})
	})
	s.route("DELETE /api/tasks/{task_id}/files/{file_id}", "owner", func(r request) any {
		s.transaction(r.Context(), func(db store.SQL) any {
			t := s.task(r.Context(), db, r.User, r.PathValue("task_id"))
			version(t, r.integer("version", 0, 1, 1e9))
			one(r.Context(), db, "SELECT id FROM attachments WHERE id=? AND user_id=? AND task_id=?", r.PathValue("file_id"), r.User, t["id"])
			exec(r.Context(), db, "DELETE FROM attachments WHERE id=? AND user_id=?", r.PathValue("file_id"), r.User)
			t["version"] = num(t, "version") + 1
			delete(t, "attachments")
			s.updateTask(r.Context(), db, r.User, t)
			event(r.Context(), db, r.User, "shelf.delete", r.PathValue("file_id"))
			return nil
		})
		os.Remove(s.blob(r.PathValue("file_id")))
		return Object{"ok": true}
	})
	for _, mode := range []string{"rename", "kind"} {
		suffix := ""
		if mode == "kind" {
			suffix = "/kind"
		}
		mode := mode
		s.route("PUT /api/tasks/{task_id}/files/{file_id}"+suffix, "owner", func(r request) any {
			b := r.body()
			return s.transaction(r.Context(), func(db store.SQL) any {
				t := s.task(r.Context(), db, r.User, r.PathValue("task_id"))
				version(t, int(num(b, "version")))
				one(r.Context(), db, "SELECT id FROM attachments WHERE id=? AND user_id=? AND task_id=?", r.PathValue("file_id"), r.User, t["id"])
				if mode == "rename" {
					if str(b, "name") == "" {
						fail(422, "请输入文件名")
					}
					exec(r.Context(), db, "UPDATE attachments SET name=? WHERE id=?", safeName(str(b, "name")), r.PathValue("file_id"))
				} else {
					kind := str(b, "kind")
					if !choice(kind, "material", "receipt") {
						fail(422, "文件用途无效")
					}
					exec(r.Context(), db, "UPDATE attachments SET kind=? WHERE id=?", kind, r.PathValue("file_id"))
					exec(r.Context(), db, "UPDATE shelf_meta SET category=?,version=version+1 WHERE file_id=?", kind, r.PathValue("file_id"))
					event(r.Context(), db, r.User, "shelf.upsert", r.PathValue("file_id"))
				}
				t["version"] = num(t, "version") + 1
				delete(t, "attachments")
				s.updateTask(r.Context(), db, r.User, t)
				return s.task(r.Context(), db, r.User, str(t, "id"))
			})
		})
	}
	s.route("GET /api/tasks/{task_id}/check", "owner", func(r request) any { return checkTask(s.task(r.Context(), s.Store.DB, r.User, r.PathValue("task_id"))) })
	s.route("GET /api/tasks/{task_id}/package", "owner", func(r request) any {
		archive, err := os.CreateTemp("", "jjb-package-*.zip")
		check(err)
		defer os.Remove(archive.Name())
		defer archive.Close()
		s.transaction(r.Context(), func(db store.SQL) any {
			t := s.task(r.Context(), db, r.User, r.PathValue("task_id"))
			files := []Object{}
			for _, f := range objects(t["attachments"]) {
				if str(f, "kind") == "material" {
					files = append(files, f)
				}
			}
			if len(files) == 0 {
				fail(400, "请先添加材料")
			}
			z := zip.NewWriter(archive)
			used := map[string]bool{"交件清单.json": true}
			for _, f := range files {
				name := safeName(str(f, "name"))
				original := name
				for n := 2; used[strings.ToLower(name)]; n++ {
					ext := filepath.Ext(original)
					name = strings.TrimSuffix(original, ext) + " (" + fmtValue(n) + ")" + ext
				}
				used[strings.ToLower(name)] = true
				dst, err := z.Create(name)
				check(err)
				source, err := os.Open(s.blob(str(f, "id")))
				check(err)
				_, err = io.Copy(dst, source)
				source.Close()
				check(err)
			}
			dst, err := z.Create("交件清单.json")
			check(err)
			_, err = io.WriteString(dst, store.JSON(Object{"task": t, "check": checkTask(t)}))
			check(err)
			check(z.Close())
			return nil
		})
		r.W.Header().Set("Content-Type", "application/zip")
		r.W.Header().Set("Content-Disposition", `attachment; filename="submission.zip"`)
		_, err = archive.Seek(0, 0)
		check(err)
		_, err = io.Copy(r.W, archive)
		check(err)
		return nil
	})
}
func checkTask(t Object) Object {
	files := []Object{}
	for _, f := range objects(t["attachments"]) {
		if str(f, "kind") == "material" {
			files = append(files, f)
		}
	}
	requirements := objects(t["requirements"])
	slots := []int{}
	for i, req := range requirements {
		for range int(num(req, "min_count")) {
			slots = append(slots, i)
		}
	}
	assignments := map[int]int{}
	var allocate func(int, map[int]bool) bool
	allocate = func(slot int, seen map[int]bool) bool {
		exts := list(requirements[slots[slot]], "extensions")
		for i, f := range files {
			if seen[i] {
				continue
			}
			matches := len(exts) == 0
			ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(str(f, "name")), "."))
			for _, v := range exts {
				if v == ext {
					matches = true
				}
			}
			if !matches {
				continue
			}
			seen[i] = true
			previous, occupied := assignments[i]
			if !occupied || allocate(previous, seen) {
				assignments[i] = slot
				return true
			}
		}
		return false
	}
	for i := range slots {
		allocate(i, map[int]bool{})
	}
	results := []any{}
	ready := len(files) > 0
	for i, req := range requirements {
		count := 0
		for _, slot := range assignments {
			if slots[slot] == i {
				count++
			}
		}
		ok := float64(count) >= num(req, "min_count")
		if !ok {
			ready = false
		}
		results = append(results, Object{"label": req["label"], "ok": ok, "detail": fmtValue(count) + "/" + fmtValue(req["min_count"])})
	}
	if max := num(t, "max_total_bytes"); max > 0 {
		size := float64(0)
		for _, f := range files {
			size += num(f, "size")
		}
		ok := size <= max
		if !ok {
			ready = false
		}
		results = append(results, Object{"label": "材料总大小", "ok": ok, "detail": fmtValue(size) + "/" + fmtValue(max) + " 字节"})
	}
	if pattern := str(t, "filename_pattern"); pattern != "" {
		bad := []string{}
		for _, f := range files {
			matched, _ := filepath.Match(pattern, str(f, "name"))
			if !matched {
				bad = append(bad, str(f, "name"))
			}
		}
		if len(bad) > 0 {
			ready = false
		}
		results = append(results, Object{"label": "文件命名", "ok": len(bad) == 0, "detail": fallback(strings.Join(bad, "、"), "全部符合")})
	} else if str(t, "naming_hint") != "" {
		ready = false
		results = append(results, Object{"label": "命名要求需人工核对", "ok": nil, "detail": t["naming_hint"]})
	}
	return Object{"results": results, "ready": ready, "material_count": len(files)}
}
