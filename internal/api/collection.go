package api

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"github.com/NekoYume517/jiaojianbox/internal/store"
	"io"
	"os"
	"regexp"
	"strings"
	"time"
)

func decodeValues(raw string) Object {
	if raw == "" {
		return Object{}
	}
	var v Object
	if len(raw) > 100000 || json.Unmarshal([]byte(raw), &v) != nil {
		fail(422, "表单内容无效")
	}
	return v
}
func validateBuilder(b Object) Object {
	if len(objects(b["fields"])) > 80 || len(objects(b["roster"])) > 10000 || len(str(b, "javascript")) > 30000 {
		fail(422, "表单超出大小限制")
	}
	seen := map[string]bool{}
	for _, f := range objects(b["fields"]) {
		id := str(f, "id")
		if !regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9_]{0,63}$`).MatchString(id) || seen[id] {
			fail(422, "字段标识重复或无效")
		}
		seen[id] = true
		if !choice(str(f, "type"), "text", "textarea", "number", "email", "date", "select", "file") {
			fail(422, "字段类型无效")
		}
		if str(f, "label") == "" {
			fail(422, "请填写字段名称")
		}
		if num(f, "length") < 0 || num(f, "length") > 10000 {
			fail(422, "长度规则无效")
		}
		if p := str(f, "pattern"); p != "" {
			if len(p) > 500 {
				fail(422, "规则过长")
			}
			if _, e := regexp.Compile(p); e != nil {
				fail(422, "正则表达式无效")
			}
		}
	}
	if str(b, "duplicate") != "" && !choice(str(b, "duplicate"), "reject", "overwrite") {
		fail(422, "重复规则无效")
	}
	return b
}
func (s *Server) validateEntry(r request, db store.SQL, row, form, values Object, browser string, uploads []Object) string {
	b := object(form["builder"])
	if len(browser) < 20 || len(browser) > 200 {
		if len(objects(b["fields"])) == 0 && !boolean(b, "once") && !boolean(b, "allow_edit") {
			return ""
		}
		fail(422, "浏览器提交标识无效，请刷新")
	}
	for _, f := range objects(b["fields"]) {
		id := str(f, "id")
		v := strings.TrimSpace(fmtValue(values[id]))
		if len([]rune(v)) > 10000 {
			fail(422, "字段内容过长")
		}
		values[id] = v
		if str(f, "type") == "file" {
			count := 0
			for _, u := range uploads {
				if str(u, "field") == id {
					count++
					accept := str(f, "accept")
					if accept != "" {
						ok := false
						for _, ext := range strings.Split(accept, ",") {
							if strings.HasSuffix(strings.ToLower(str(u, "name")), strings.ToLower(strings.TrimSpace(ext))) {
								ok = true
							}
						}
						if !ok {
							fail(422, str(f, "label")+"文件格式不符合要求")
						}
					}
				}
			}
			if boolean(f, "required") && count == 0 && r.FormValue("edit_id") == "" {
				fail(422, "请上传"+str(f, "label"))
			}
			continue
		}
		if boolean(f, "required") && v == "" {
			fail(422, "请填写"+str(f, "label"))
		}
		if v == "" {
			continue
		}
		if n := num(f, "length"); n > 0 && float64(len([]rune(v))) != n {
			fail(422, str(f, "label")+"长度不符合要求")
		}
		if p := str(f, "pattern"); p != "" && !regexp.MustCompile(p).MatchString(v) {
			fail(422, str(f, "label")+"格式不正确")
		}
		if str(f, "type") == "number" {
			var n float64
			if _, e := fmt.Sscan(v, &n); e != nil {
				fail(422, str(f, "label")+"应为数字")
			}
			if f["min"] != nil && n < num(f, "min") || f["max"] != nil && n > num(f, "max") {
				fail(422, str(f, "label")+"超出范围")
			}
		}
		if str(f, "type") == "select" {
			ok := false
			for _, o := range list(f, "options") {
				if fmtValue(o) == v {
					ok = true
				}
			}
			if !ok {
				fail(422, str(f, "label")+"选项无效")
			}
		}
	}
	roster := objects(b["roster"])
	if len(roster) > 0 {
		keys := list(b, "roster_fields")
		if len(keys) == 0 {
			fail(422, "收集者尚未配置名单字段")
		}
		matched := false
		for _, person := range roster {
			ok := true
			for _, k := range keys {
				key := fmtValue(k)
				if strings.TrimSpace(fmtValue(person[key])) != strings.TrimSpace(fmtValue(values[key])) {
					ok = false
				}
			}
			if ok {
				matched = true
				break
			}
		}
		if !matched {
			fail(422, "信息与允许提交的名单不匹配，请核对姓名和学号")
		}
	}
	edit := r.FormValue("edit_id")
	target := ""
	rows := query(r.Context(), db, "SELECT * FROM collection_entries WHERE share_id=?", row["id"])
	for _, entry := range rows {
		same := store.Equal(str(entry, "browser_hash"), store.Hash(browser))
		if str(entry, "id") == edit {
			if !same || !boolean(b, "allow_edit") {
				fail(403, "不允许修改此提交")
			}
			target = edit
			continue
		}
		duplicate := boolean(b, "once") && same
		previous := store.Payload(entry)
		for _, f := range objects(b["fields"]) {
			if boolean(f, "unique") && fmtValue(values[str(f, "id")]) != "" && fmtValue(values[str(f, "id")]) == fmtValue(previous[str(f, "id")]) {
				duplicate = true
			}
		}
		if duplicate {
			if str(b, "duplicate") != "overwrite" {
				fail(409, "已提交或唯一字段重复，不能再次提交")
			}
			if target != "" && target != str(entry, "id") {
				fail(409, "信息与多份记录冲突，请联系收集者")
			}
			target = str(entry, "id")
		}
	}
	if edit != "" && target == "" {
		fail(404, "原提交不存在")
	}
	return target
}
func (s *Server) collectionRoutes() {
	s.route("GET /api/shared/{token}/history", "", func(r request) any {
		row, p, _ := s.shared(r, "")
		if str(p, "purpose") != "collect" {
			fail(400, "不是收集表单")
		}
		key := r.Header.Get("X-Collection-Key")
		if len(key) < 20 {
			return Object{"entries": []any{}}
		}
		entries := query(r.Context(), s.Store.DB, "SELECT e.id,e.payload,e.updated_at,s.created_at FROM collection_entries e JOIN share_submissions s ON s.id=e.id WHERE e.share_id=? AND e.browser_hash=? ORDER BY s.created_at DESC", row["id"], store.Hash(key))
		for _, e := range entries {
			e["values"] = store.Payload(e)
			delete(e, "payload")
		}
		return Object{"entries": entries}
	})
	s.route("POST /api/shared/{token}/roster", "", func(r request) any {
		row, p, _ := s.shared(r, "")
		_ = row
		b := object(shareForm(p)["builder"])
		input := r.body()
		key := str(input, "field")
		value := str(input, "value")
		if len([]rune(value)) < 2 {
			return Object{"matches": []any{}}
		}
		results := []Object{}
		for _, person := range objects(b["roster"]) {
			if fmtValue(person[key]) == value {
				out := Object{}
				for _, k := range list(b, "roster_fields") {
					out[fmtValue(k)] = person[fmtValue(k)]
				}
				results = append(results, out)
			}
		}
		if len(results) > 10 {
			results = results[:10]
		}
		return Object{"matches": results}
	})
	s.route("POST /api/collection/ai", "owner", func(r request) any {
		input := r.body()
		if r.URL.Query().Get("stream") == "true" {
			return s.stream(r, func(ctx context.Context, p progress) any { return s.designCollection(ctx, r.User, input, p) })
		}
		return s.designCollection(r.Context(), r.User, input, nil)
	})

	s.route("GET /api/shares/{share_id}/export", "owner", func(r request) any {
		row := one(r.Context(), s.Store.DB, "SELECT * FROM shares WHERE id=? AND user_id=?", r.PathValue("share_id"), r.User)
		b := object(shareForm(sharePayloadFor(row))["builder"])
		entries := query(r.Context(), s.Store.DB, "SELECT s.*,e.payload,e.updated_at FROM share_submissions s LEFT JOIN collection_entries e ON e.id=s.id WHERE s.share_id=? ORDER BY s.created_at", row["id"])
		var buf bytes.Buffer
		z := zip.NewWriter(&buf)
		if r.URL.Query().Get("kind") == "files" {
			used := map[string]int{}
			for _, entry := range entries {
				v := store.Payload(entry)
				name := str(b, "export_name")
				if name == "" {
					name = "{name}"
				}
				for k, x := range v {
					name = strings.ReplaceAll(name, "{"+k+"}", fmtValue(x))
				}
				name = strings.ReplaceAll(name, "{name}", str(entry, "name"))
				name = safeName(name)
				files := query(r.Context(), s.Store.DB, "SELECT a.* FROM attachments a JOIN share_submission_files m ON m.attachment_id=a.id WHERE m.submission_id=?", entry["id"])
				for _, file := range files {
					filename := str(file, "name")
					ext := ""
					if i := strings.LastIndex(filename, "."); i >= 0 {
						ext = filename[i:]
					}
					base := name + ext
					used[base]++
					if used[base] > 1 {
						base = fmt.Sprintf("%s-%d%s", name, used[base], ext)
					}
					src, e := os.Open(s.blob(str(file, "id")))
					if e != nil {
						continue
					}
					dst, e := z.Create(base)
					check(e)
					_, e = io.Copy(dst, src)
					src.Close()
					check(e)
				}
			}
		} else {
			headers := []string{"提交人", "提交时间", "修改时间"}
			fields := objects(b["fields"])
			for _, f := range fields {
				headers = append(headers, str(f, "label"))
			}
			headers = append(headers, "备注")
			rows := [][]string{headers}
			for _, e := range entries {
				cells := []string{str(e, "name"), str(e, "created_at"), str(e, "updated_at")}
				v := store.Payload(e)
				for _, f := range fields {
					cells = append(cells, fmtValue(v[str(f, "id")]))
				}
				cells = append(cells, str(e, "note"))
				rows = append(rows, cells)
			}
			writeXLSX(z, rows)
		}
		check(z.Close())
		filename := "收集记录.xlsx"
		if r.URL.Query().Get("kind") == "files" {
			filename = "收集附件.zip"
		}
		r.W.Header().Set("Content-Type", "application/octet-stream")
		r.W.Header().Set("Content-Disposition", "attachment; filename*=UTF-8''"+urlEscape(filename))
		r.W.Write(buf.Bytes())
		return nil
	})
}
func collectionToolSchema() []Object {
	objectSchema := func(properties Object, required []any) Object {
		return Object{"type": "object", "properties": properties, "required": required}
	}
	fieldProperties := Object{
		"id":       Object{"type": "string", "description": "Stable English field id; keep an existing id when editing."},
		"label":    Object{"type": "string"},
		"type":     Object{"type": "string", "enum": []any{"text", "textarea", "number", "email", "date", "select", "file"}},
		"required": Object{"type": "boolean"},
		"unique":   Object{"type": "boolean", "description": "Reject duplicate values across submissions."},
		"length":   Object{"type": "number", "description": "Exact character count, for example 12."},
		"pattern":  Object{"type": "string", "description": "Go-compatible regular expression."},
		"min":      Object{"type": "number"},
		"max":      Object{"type": "number"},
		"options":  Object{"type": "array", "items": Object{"type": "string"}},
		"accept":   Object{"type": "string", "description": "Comma separated file extensions, for example .png,.jpg"},
	}
	return []Object{
		{"type": "function", "function": Object{"name": "read_task", "description": "Read the task requirements, deadline, naming rules, materials and current form.", "parameters": objectSchema(Object{}, []any{})}},
		{"type": "function", "function": Object{"name": "add_field", "description": "Add one form field.", "parameters": objectSchema(fieldProperties, []any{"label", "type"})}},
		{"type": "function", "function": Object{"name": "update_field", "description": "Update one existing field by id.", "parameters": objectSchema(Object{"field_id": Object{"type": "string"}, "patch": fieldProperties}, []any{"field_id", "patch"})}},
		{"type": "function", "function": Object{"name": "remove_field", "description": "Remove one field by id.", "parameters": objectSchema(Object{"field_id": Object{"type": "string"}}, []any{"field_id"})}},
		{"type": "function", "function": Object{"name": "reorder_fields", "description": "Set the display order using all field ids.", "parameters": objectSchema(Object{"ids": Object{"type": "array", "items": Object{"type": "string"}}}, []any{"ids"})}},
		{"type": "function", "function": Object{"name": "set_rules", "description": "Set submission, duplicate, export naming and JavaScript rules.", "parameters": objectSchema(Object{"once": Object{"type": "boolean"}, "allow_edit": Object{"type": "boolean"}, "duplicate": Object{"type": "string", "enum": []any{"reject", "overwrite"}}, "export_name": Object{"type": "string"}, "javascript": Object{"type": "string"}, "roster_fields": Object{"type": "array", "items": Object{"type": "string"}}}, []any{})}},
	}
}

func collectionFieldID(label string, fields []Object) string {
	base := "field_"
	for _, r := range strings.ToLower(label) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			base += string(r)
		}
		if len(base) >= 28 {
			break
		}
	}
	if base == "field_" {
		base += "item"
	}
	id := base
	for i := 2; ; i++ {
		used := false
		for _, field := range fields {
			if str(field, "id") == id {
				used = true
			}
		}
		if !used {
			return id
		}
		id = fmt.Sprintf("%s_%d", base, i)
	}
}

func collectionField(raw Object, existing Object, fields []Object) Object {
	source := Object{}
	for k, v := range existing {
		source[k] = v
	}
	for k, v := range raw {
		if _, ok := source[k]; ok || v != nil {
			source[k] = v
		}
	}
	if existing == nil {
		source["required"] = boolean(source, "required")
		source["unique"] = boolean(source, "unique")
	}
	source["id"] = strings.TrimSpace(str(source, "id"))
	if source["id"] == "" {
		source["id"] = collectionFieldID(str(source, "label"), fields)
	}
	if !regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9_]{0,63}$`).MatchString(str(source, "id")) {
		fail(422, "字段标识无效，只能使用英文、数字和下划线")
	}
	source["label"] = strings.TrimSpace(str(source, "label"))
	label := str(source, "label")
	if label == "" || len([]rune(label)) > 120 {
		fail(422, "字段名称必须为 1 至 120 个字符")
	}
	fieldType := strings.ToLower(strings.TrimSpace(str(source, "type")))
	if fieldType == "" {
		source["type"] = "text"
	} else {
		if !choice(fieldType, "text", "textarea", "number", "email", "date", "select", "file") {
			fail(422, "字段类型无效")
		}
		source["type"] = fieldType
	}
	if n := num(source, "length"); n < 0 || n > 10000 {
		fail(422, "字段长度规则无效")
	}
	if p := str(source, "pattern"); p != "" {
		if len(p) > 500 {
			fail(422, "字段正则过长")
		}
		if _, err := regexp.Compile(p); err != nil {
			fail(422, "字段正则无效："+p)
		}
	}
	options := []any{}
	for _, option := range asList(source["options"], 200) {
		value := strings.TrimSpace(fmtValue(option))
		if value != "" && len([]rune(value)) <= 200 {
			options = append(options, value)
		}
	}
	source["options"] = options
	parts := []string{}
	for _, part := range strings.Split(str(source, "accept"), ",") {
		value := strings.TrimSpace(strings.ToLower(part))
		if value == "" {
			continue
		}
		if !strings.HasPrefix(value, ".") {
			value = "." + value
		}
		if len(value) <= 16 {
			parts = append(parts, value)
		}
	}
	source["accept"] = strings.Join(parts, ",")
	if source["type"] == "number" {
		for _, key := range []string{"min", "max"} {
			if source[key] != nil && source[key] != "" {
				if _, ok := source[key].(float64); !ok {
					fail(422, "数字范围无效")
				}
			}
		}
	} else {
		delete(source, "min")
		delete(source, "max")
	}
	if source["type"] != "select" {
		source["options"] = []any{}
	}
	if source["type"] != "file" {
		delete(source, "accept")
	}
	return source
}

func findCollectionField(fields []Object, id string) (int, Object) {
	for i, field := range fields {
		if str(field, "id") == id {
			return i, field
		}
	}
	fail(404, "字段不存在："+id)
	return 0, nil
}

func notifyCollectionChange(p progress, b Object, operation string, detail Object) {
	value := Object{"stage": "builder", "operation": operation, "fields": objects(b["fields"])}
	for k, v := range detail {
		value[k] = v
	}
	notify(p, value)
}

func (s *Server) applyCollectionTool(ctx context.Context, user string, b Object, name string, args Object, p progress) Object {
	_, _ = user, ctx
	fields := objects(b["fields"])
	b["fields"] = fields
	switch name {
	case "read_task":
		return Object{"ok": true}
	case "add_field":
		field := collectionField(args, nil, fields)
		if len(fields) >= 80 {
			fail(422, "表单最多 80 个字段")
		}
		fieldID := str(field, "id")
		for _, old := range fields {
			if str(old, "id") == fieldID {
				fail(409, "字段标识已存在："+fieldID)
			}
		}
		fields = append(fields, field)
		b["fields"] = fields
		notifyCollectionChange(p, b, "add_field", Object{"field": field})
		return Object{"ok": true, "field": field}
	case "update_field":
		id := str(args, "field_id")
		index, old := findCollectionField(fields, id)
		patch, ok := args["patch"].(map[string]any)
		if !ok {
			fail(422, "字段更新内容无效")
		}
		patch["id"] = id
		field := collectionField(patch, old, fields)
		fields[index] = field
		b["fields"] = fields
		notifyCollectionChange(p, b, "update_field", Object{"field": field})
		return Object{"ok": true, "field": field}
	case "remove_field":
		index, old := findCollectionField(fields, str(args, "field_id"))
		fields = append(fields[:index], fields[index+1:]...)
		b["fields"] = fields
		notifyCollectionChange(p, b, "remove_field", Object{"field_id": str(old, "id"), "field_label": str(old, "label")})
		return Object{"ok": true}
	case "reorder_fields":
		ids := list(args, "ids")
		if len(ids) == 0 || len(ids) > len(fields) {
			fail(422, "字段排序无效")
		}
		ordered := []Object{}
		seen := map[string]bool{}
		for _, item := range ids {
			id := fmtValue(item)
			_, field := findCollectionField(fields, id)
			if seen[id] {
				fail(422, "字段排序重复")
			}
			seen[id] = true
			ordered = append(ordered, field)
		}
		for _, field := range fields {
			if !seen[str(field, "id")] {
				ordered = append(ordered, field)
			}
		}
		fields = ordered
		b["fields"] = fields
		notifyCollectionChange(p, b, "reorder_fields", Object{})
		return Object{"ok": true}
	case "set_rules":
		if _, ok := args["once"]; ok {
			b["once"] = boolean(args, "once")
		}
		if _, ok := args["allow_edit"]; ok {
			b["allow_edit"] = boolean(args, "allow_edit")
		}
		if _, ok := args["duplicate"]; ok {
			value := str(args, "duplicate")
			if !choice(value, "reject", "overwrite") {
				fail(422, "重复处理规则无效")
			}
			b["duplicate"] = value
		}
		if _, ok := args["export_name"]; ok {
			value := strings.TrimSpace(str(args, "export_name"))
			if len([]rune(value)) > 200 {
				fail(422, "导出命名过长")
			}
			b["export_name"] = value
		}
		if _, ok := args["javascript"]; ok {
			value := str(args, "javascript")
			if len([]rune(value)) > 30000 {
				fail(422, "JavaScript 规则过长")
			}
			b["javascript"] = value
		}
		if _, ok := args["roster_fields"]; ok {
			keys := []any{}
			for _, item := range list(args, "roster_fields") {
				id := fmtValue(item)
				if _, field := findCollectionField(fields, id); field != nil {
					keys = append(keys, id)
				}
			}
			b["roster_fields"] = keys
		}
		notifyCollectionChange(p, b, "set_rules", Object{"rules": Object{"once": boolean(b, "once"), "allow_edit": boolean(b, "allow_edit"), "duplicate": str(b, "duplicate"), "export_name": str(b, "export_name"), "javascript": str(b, "javascript"), "roster_fields": list(b, "roster_fields")}})
		return Object{"ok": true}
	}
	return Object{"error": "未知工具"}
}

func (s *Server) designCollection(ctx context.Context, user string, input Object, p progress) any {
	shareID := str(input, "share_id")
	row := one(ctx, s.Store.DB, "SELECT * FROM shares WHERE id=? AND user_id=?", shareID, user)
	payload := sharePayloadFor(row)
	task := s.task(ctx, s.Store.DB, user, str(row, "task_id"))
	b := object(input["builder"])
	if b["fields"] == nil {
		b = object(shareForm(payload)["builder"])
	}
	saved := object(shareForm(payload)["builder"])
	if b["roster"] == nil {
		b["roster"] = saved["roster"]
	}
	if b["roster_fields"] == nil {
		b["roster_fields"] = saved["roster_fields"]
	}
	config, key := s.resolveLLM(ctx, user)
	if str(config, "base_url") == "" || str(config, "model") == "" {
		fail(400, "请先配置 AI，再使用表单设计")
	}
	notify(p, Object{"stage": "context", "task_characters": len([]rune(str(task, "description"))), "field_count": len(objects(b["fields"]))})
	publicForm := Object{}
	for k, v := range b {
		if k != "roster" {
			publicForm[k] = v
		}
	}
	payloadData := Object{"TASK": task, "CURRENT_FORM": publicForm, "INSTRUCTION": str(input, "instruction")}
	conversation := []Object{
		{"role": "system", "content": "你是中文收集表单设计师。先调用 read_task 理解任务，再用工具逐项修改表单；每个具体变化都单独调用工具。不要生成 HTML。字段标识使用稳定英文 id，保留用户已有字段，除非用户明确要求删除。规则必须是服务端可复核的 length、pattern、unique、select 或 JavaScript。完成后简短总结。"},
		{"role": "user", "content": store.JSON(payloadData)},
	}
	metrics := Object{}
	started := time.Now()
	success := false
	defer func() {
		safe, stop := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer stop()
		attempt(func() any { s.recordLLM(safe, user, "collection_form", config, started, metrics, success); return nil })
	}()
	applied := false
	for round := 0; round < 4; round++ {
		call := s.chat(ctx, config, key, conversation, collectionToolSchema(), p, func(part Object) { metrics = mergeMetrics(metrics, part) })
		if len(call.Calls) > 0 {
			conversation = append(conversation, Object{"role": "assistant", "content": nil, "tool_calls": call.Calls})
			for _, item := range call.Calls {
				fn := object(item["function"])
				var args Object
				if err := json.Unmarshal([]byte(str(fn, "arguments")), &args); err != nil {
					fail(502, "模型工具参数无效")
				}
				out := s.applyCollectionTool(ctx, user, b, str(fn, "name"), args, p)
				applied = true
				conversation = append(conversation, Object{"role": "tool", "tool_call_id": str(item, "id"), "content": store.JSON(out)})
			}
			continue
		}
		raw := robustJSON(call.Text)
		candidate := object(raw["builder"])
		if candidate["fields"] == nil {
			candidate = raw
		}
		if candidate["fields"] != nil {
			for _, key := range []string{"fields", "once", "allow_edit", "duplicate", "export_name", "javascript", "roster_fields"} {
				if value, ok := candidate[key]; ok {
					b[key] = value
				}
			}
		} else if !applied {
			fail(502, "AI 未生成表单修改，请补充要求后重试")
		}
		break
	}
	if len(objects(b["fields"])) == 0 {
		fail(502, "AI 未生成表单字段，请补充要求后重试")
	}
	notify(p, Object{"stage": "validating"})
	b = validateBuilder(b)
	success = true
	return Object{"builder": b, "performance": metrics, "model": config["model"]}
}

func urlEscape(s string) string {
	var b strings.Builder
	for _, c := range []byte(s) {
		fmt.Fprintf(&b, "%%%02X", c)
	}
	return b.String()
}
func writeXLSX(z *zip.Writer, rows [][]string) {
	files := map[string]string{"[Content_Types].xml": `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`, "_rels/.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`, "xl/workbook.xml": `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="收集记录" sheetId="1" r:id="rId1"/></sheets></workbook>`, "xl/_rels/workbook.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`}
	var sheet strings.Builder
	sheet.WriteString(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`)
	for i, row := range rows {
		fmt.Fprintf(&sheet, `<row r="%d">`, i+1)
		for _, v := range row {
			var escaped bytes.Buffer
			xml.EscapeText(&escaped, []byte(v))
			sheet.WriteString(`<c t="inlineStr"><is><t xml:space="preserve">` + escaped.String() + `</t></is></c>`)
		}
		sheet.WriteString(`</row>`)
	}
	sheet.WriteString(`</sheetData></worksheet>`)
	files["xl/worksheets/sheet1.xml"] = sheet.String()
	for name, data := range files {
		w, e := z.Create(name)
		check(e)
		_, e = io.WriteString(w, data)
		check(e)
	}
}
