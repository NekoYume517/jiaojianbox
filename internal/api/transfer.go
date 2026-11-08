package api

import (
	"archive/zip"
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/NekoYume517/jiaojianbox/internal/store"
)

var uuidPattern = regexp.MustCompile(`(?i)^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)

func (s *Server) transferRoutes() {
	exec(context.Background(), s.Store.DB, "CREATE TABLE IF NOT EXISTS imported_entities(user_id TEXT,origin TEXT,local_id TEXT,PRIMARY KEY(user_id,origin))")
	identity := filepath.Join(s.Store.Root, "workspace.id")
	if f, err := os.OpenFile(identity, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600); err == nil {
		_, err = f.WriteString(store.ID())
		f.Close()
		check(err)
	} else if !os.IsExist(err) {
		check(err)
	}
	raw, err := os.ReadFile(identity)
	check(err)
	workspace := strings.TrimSpace(string(raw))
	s.route("GET /api/workspace/export", "owner", func(r request) any {
		out, err := os.CreateTemp("", "jjb-export-*.zip")
		check(err)
		defer os.Remove(out.Name())
		defer out.Close()
		s.transaction(r.Context(), func(db store.SQL) any {
			manifest := Object{"format": "jiaojianbox-workspace", "version": 1, "workspace_id": workspace + ":" + r.User, "tasks": []Object{}, "messages": []Object{}, "files": query(r.Context(), db, "SELECT id,task_id,name,size,sha256,kind FROM attachments WHERE user_id=?", r.User), "shelf": query(r.Context(), db, "SELECT file_id,category,suggestion,created_at FROM shelf_meta WHERE user_id=?", r.User)}
			for _, kind := range []string{"tasks", "messages"} {
				items := []Object{}
				for _, row := range query(r.Context(), db, "SELECT payload FROM "+kind+" WHERE user_id=?", r.User) {
					item := store.Payload(row)
					delete(item, "analysis_pending")
					delete(item, "analysis_state")
					items = append(items, item)
				}
				manifest[kind] = items
			}
			if row := first(query(r.Context(), db, "SELECT payload FROM llm_settings WHERE user_id=?", r.User)); row != nil {
				manifest["llm_settings"] = store.Payload(row)
			}
			z := zip.NewWriter(out)
			dst, err := z.Create("manifest.json")
			check(err)
			_, err = io.WriteString(dst, store.JSON(manifest))
			check(err)
			for _, f := range objects(manifest["files"]) {
				src, err := os.Open(s.blob(str(f, "id")))
				if err != nil {
					fail(409, "有附件暂不可用，请检查后重试")
				}
				dst, err := z.Create("files/" + str(f, "id"))
				if err != nil {
					src.Close()
					check(err)
				}
				_, err = io.Copy(dst, src)
				src.Close()
				check(err)
			}
			check(z.Close())
			return nil
		})
		_, err = out.Seek(0, 0)
		check(err)
		r.W.Header().Set("Content-Type", "application/zip")
		r.W.Header().Set("Content-Disposition", `attachment; filename="jiaojianbox-workspace.zip"`)
		_, err = io.Copy(r.W, out)
		check(err)
		return nil
	})
	s.route("POST /api/workspace/import", "owner", func(r request) any {
		const limit int64 = 512 << 20
		r.Body = http.MaxBytesReader(r.W, r.Body, limit+(1<<20))
		if r.ParseMultipartForm(8<<20) != nil {
			if r.MultipartForm != nil {
				r.MultipartForm.RemoveAll()
			}
			fail(413, "迁移包超过大小上限或格式无效")
		}
		defer r.MultipartForm.RemoveAll()
		src, _, err := r.FormFile("file")
		if err != nil {
			fail(422, "请选择迁移包")
		}
		defer src.Close()
		incoming, err := os.CreateTemp("", "jjb-import-*.zip")
		check(err)
		defer os.Remove(incoming.Name())
		defer incoming.Close()
		size, err := io.Copy(incoming, io.LimitReader(src, limit+1))
		check(err)
		if size > limit {
			fail(413, "迁移包超过大小上限")
		}
		z, err := zip.NewReader(incoming, size)
		if err != nil {
			fail(400, "迁移包无效或损坏")
		}
		if len(z.File) > 20000 {
			fail(413, "迁移包文件数量过多")
		}
		entries := map[string]*zip.File{}
		var expanded uint64
		for _, f := range z.File {
			if entries[f.Name] != nil {
				fail(400, "迁移包存在重复文件")
			}
			entries[f.Name] = f
			expanded += f.UncompressedSize64
			if expanded > uint64(limit)*2 {
				fail(413, "迁移包解压后过大")
			}
		}
		info := entries["manifest.json"]
		if info == nil || info.UncompressedSize64 > 20<<20 {
			fail(400, "迁移清单无效")
		}
		reader, err := info.Open()
		check(err)
		data, err := io.ReadAll(io.LimitReader(reader, 20<<20))
		reader.Close()
		if err != nil {
			fail(400, "迁移包校验失败")
		}
		var manifest Object
		if json.Unmarshal(data, &manifest) != nil {
			fail(400, "迁移清单无效")
		}
		return s.importManifest(r.Context(), r.User, manifest, entries)
	})
	s.route("POST /api/workspace/import-cache", "owner", func(r request) any {
		b := r.body()
		origin := str(b, "origin")
		if len(origin) > 1000 {
			fail(422, "来源标识过长")
		}
		tasks := objects(b["tasks"])
		messages := objects(b["messages"])
		for _, t := range tasks {
			t["id"] = cacheID(origin, str(t, "id"))
			if str(t, "source_message_id") != "" {
				t["source_message_id"] = cacheID(origin, str(t, "source_message_id"))
			}
		}
		for _, m := range messages {
			m["id"] = cacheID(origin, str(m, "id"))
		}
		manifest := Object{"format": "jiaojianbox-workspace", "version": 1, "workspace_id": "cache:" + store.Hash(origin), "tasks": tasks, "messages": messages, "files": []Object{}}
		return s.importManifest(r.Context(), r.User, manifest, nil)
	})
}
func cacheID(origin, id string) string {
	namespace, _ := hex.DecodeString("6ba7b8119dad11d180b400c04fd430c8")
	h := sha1.New()
	h.Write(namespace)
	h.Write([]byte(origin + "|" + id))
	b := h.Sum(nil)[:16]
	b[6] = b[6]&15 | 80
	b[8] = b[8]&63 | 128
	x := hex.EncodeToString(b)
	return x[:8] + "-" + x[8:12] + "-" + x[12:16] + "-" + x[16:20] + "-" + x[20:]
}
func (s *Server) importManifest(ctx context.Context, user string, m Object, entries map[string]*zip.File) any {
	if str(m, "format") != "jiaojianbox-workspace" || num(m, "version") != 1 || str(m, "workspace_id") == "" || len(str(m, "workspace_id")) > 200 {
		fail(400, "迁移包无效或版本不兼容")
	}
	for kind, limit := range map[string]int{"tasks": 10000, "messages": 100000, "files": 10000} {
		items := objects(m[kind])
		if len(items) > limit {
			fail(413, "迁移内容过多")
		}
		seen := map[string]bool{}
		for _, item := range items {
			id := str(item, "id")
			if !uuidPattern.MatchString(id) || seen[id] {
				fail(400, "迁移内容的标识无效或重复")
			}
			seen[id] = true
		}
	}
	created := []string{}
	committed := false
	defer func() {
		if !committed {
			for _, path := range created {
				os.Remove(path)
			}
		}
	}()
	result := s.transaction(ctx, func(db store.SQL) any {
		type mapping struct {
			id    string
			fresh bool
		}
		mappings := map[string]mapping{}
		counts := Object{"tasks": 0, "messages": 0, "files": 0, "skipped": 0}
		mapped := func(kind, id string) mapping {
			origin := str(m, "workspace_id") + ":" + kind + ":" + id
			previous := first(query(ctx, db, "SELECT local_id FROM imported_entities WHERE user_id=? AND origin=?", user, origin))
			if previous != nil {
				table := kind
				if table == "files" {
					table = "attachments"
				}
				if len(query(ctx, db, "SELECT 1 FROM "+table+" WHERE id=? AND user_id=?", previous["local_id"], user)) > 0 {
					return mapping{str(previous, "local_id"), false}
				}
			}
			local := store.ID()
			exec(ctx, db, "INSERT OR REPLACE INTO imported_entities VALUES(?,?,?)", user, origin, local)
			return mapping{local, true}
		}
		for _, kind := range []string{"tasks", "messages"} {
			for _, item := range objects(m[kind]) {
				mappings[kind+":"+str(item, "id")] = mapped(kind, str(item, "id"))
			}
		}
		for _, item := range objects(m["tasks"]) {
			local := mappings["tasks:"+str(item, "id")]
			if !local.fresh {
				counts["skipped"] = num(counts, "skipped") + 1
				continue
			}
			t := taskInput(item)
			t["id"] = local.id
			t["version"] = 1
			t["client_id"] = nil
			t["source_message_id"] = nil
			if id := mappings["messages:"+str(item, "source_message_id")].id; id != "" {
				t["source_message_id"] = id
			}
			t["created_at"] = fallback(str(item, "created_at"), store.Now())
			t["updated_at"] = store.Now()
			exec(ctx, db, "INSERT INTO tasks VALUES(?,?,?,?,?)", local.id, user, 1, nil, store.JSON(t))
			event(ctx, db, user, "task.upsert", local.id)
			counts["tasks"] = num(counts, "tasks") + 1
		}
		for _, item := range objects(m["messages"]) {
			local := mappings["messages:"+str(item, "id")]
			if !local.fresh {
				counts["skipped"] = num(counts, "skipped") + 1
				continue
			}
			id := str(item, "id")
			item["id"] = local.id
			delete(item, "analysis_pending")
			delete(item, "analysis_state")
			if target := mappings["tasks:"+str(item, "auto_task_id")].id; target != "" {
				item["auto_task_id"] = target
			} else {
				delete(item, "auto_task_id")
			}
			exec(ctx, db, "INSERT INTO messages VALUES(?,?,?,?,?)", local.id, user, "import:"+str(m, "workspace_id")+":"+id, store.JSON(item), store.Now())
			event(ctx, db, user, "message.upsert", local.id)
			counts["messages"] = num(counts, "messages") + 1
		}
		shelf := map[string]Object{}
		for _, item := range objects(m["shelf"]) {
			shelf[str(item, "file_id")] = item
		}
		for _, item := range objects(m["files"]) {
			local := mapped("files", str(item, "id"))
			if !local.fresh {
				counts["skipped"] = num(counts, "skipped") + 1
				continue
			}
			info := entries["files/"+str(item, "id")]
			if info == nil || info.UncompressedSize64 > 50<<20 || float64(info.UncompressedSize64) != num(item, "size") {
				fail(400, "迁移附件缺失或大小无效")
			}
			path := s.blob(local.id)
			created = append(created, path)
			source, err := info.Open()
			check(err)
			target, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
			if err != nil {
				source.Close()
				check(err)
			}
			hash := sha256.New()
			_, err = io.Copy(io.MultiWriter(target, hash), io.LimitReader(source, (50<<20)+1))
			source.Close()
			target.Close()
			if err != nil || hex.EncodeToString(hash.Sum(nil)) != str(item, "sha256") {
				fail(400, "迁移附件校验失败")
			}
			task := mappings["tasks:"+str(item, "task_id")].id
			var taskID any
			if task != "" {
				taskID = task
			}
			kind := "material"
			if str(item, "kind") == "receipt" {
				kind = "receipt"
			}
			name := safeName(filepath.Base(strings.ReplaceAll(str(item, "name"), "\\", "/")))
			exec(ctx, db, "INSERT INTO attachments VALUES(?,?,?,?,?,?,?)", local.id, user, taskID, name, item["size"], item["sha256"], kind)
			category := fallback(str(shelf[str(item, "id")], "category"), "inbox")
			if task != "" {
				category = kind
			}
			if !choice(category, "inbox", "reference", "receipt", "material", "other") {
				category = "inbox"
			}
			exec(ctx, db, "INSERT INTO shelf_meta(file_id,user_id,category,suggestion,created_at) VALUES(?,?,?,?,?)", local.id, user, category, nil, store.Now())
			event(ctx, db, user, "shelf.upsert", local.id)
			counts["files"] = num(counts, "files") + 1
		}
		if settings := object(m["llm_settings"]); len(settings) > 0 && len(query(ctx, db, "SELECT 1 FROM llm_settings WHERE user_id=?", user)) == 0 {
			config := llmInput(settings)
			exec(ctx, db, "INSERT INTO llm_settings VALUES(?,?,?)", user, store.JSON(config), "")
		}
		return Object{"imported": counts, "message": "复制导入完成；来源数据保持不变，重复内容已跳过。"}
	})
	committed = true
	return result
}
