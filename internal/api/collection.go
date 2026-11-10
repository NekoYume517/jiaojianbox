package api

import (
	"archive/zip"
	"bytes"
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
		config, key := s.resolveLLM(r.Context(), r.User)
		started := time.Now()
		call := s.chat(r.Context(), config, key, []Object{{"role": "system", "content": `你是中文表单设计师。只输出 JSON 对象，字段 fields 数组，每项 id(英文标识)、label、type(text/textarea/number/email/date/select/file)、required、length(精确字数，可选)、pattern(Go兼容正则，可选)、unique、options(字符串数组)、accept(文件扩展名逗号分隔)。表单属性 once,allow_edit,duplicate(reject/overwrite),export_name(如 {student_id}-{name}),javascript(可选函数体，参数values和files，返回空串表示通过，返回中文错误表示失败)。不要生成HTML，不能联网。根据已有表单修改，保留字段id。`}, {"role": "user", "content": store.JSON(input)}}, nil, nil)
		s.recordLLM(r.Context(), r.User, "collection_form", config, started, call.Metrics, true)
		return Object{"builder": validateBuilder(robustJSON(call.Text))}
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
