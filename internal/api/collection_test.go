package api

import (
	"bytes"
	"encoding/json"
	"github.com/NekoYume517/jiaojianbox/internal/store"
	"mime/multipart"
	"net/http/httptest"
	"testing"
)

func TestCollectionBuilderRules(t *testing.T) {
	s := testServer(t)
	owner, _ := login(t, s, "builder-owner")
	_, task := call(t, s, "POST", "/api/tasks", owner, Object{"title": "班级收集"})
	_, share := call(t, s, "POST", "/api/shares", owner, Object{"task_id": task["id"], "purpose": "collect", "form": Object{"builder": Object{"fields": []any{Object{"id": "name", "label": "姓名", "type": "text", "required": true}, Object{"id": "student", "label": "学号", "type": "text", "required": true, "length": 12, "unique": true, "pattern": "^[0-9]{12}$"}}, "roster_fields": []any{"name", "student"}, "roster": []any{Object{"name": "张三", "student": "202601010001"}}, "allow_edit": true, "once": true, "duplicate": "reject"}}})
	token := shareTokenFromURL(str(share, "url"))
	if token == "" {
		t.Fatal(share)
	}
	base := "/api/shared/" + token
	submit := func(values Object, key, edit string) (int, Object) {
		var buf bytes.Buffer
		w := multipart.NewWriter(&buf)
		w.WriteField("values", store.JSON(values))
		w.WriteField("browser_key", key)
		w.WriteField("edit_id", edit)
		w.Close()
		r := httptest.NewRequest("POST", base+"/submit", &buf)
		r.Header.Set("Content-Type", w.FormDataContentType())
		res := httptest.NewRecorder()
		s.ServeHTTP(res, r)
		var out Object
		json.Unmarshal(res.Body.Bytes(), &out)
		return res.Code, out
	}
	browser := "fixture-browser-very-long-key"
	if code, _ := submit(Object{"name": "张三", "student": "123"}, browser, ""); code != 422 {
		t.Fatal("length accepted", code)
	}
	if code, _ := submit(Object{"name": "李四", "student": "202601010001"}, browser, ""); code != 422 {
		t.Fatal("roster mismatch accepted", code)
	}
	code, result := submit(Object{"name": "张三", "student": "202601010001"}, browser, "")
	if code != 200 {
		t.Fatal(code, result)
	}
	id := str(result, "submission_id")
	if code, _ := submit(Object{"name": "张三", "student": "202601010001"}, browser, ""); code != 409 {
		t.Fatal("duplicate accepted", code)
	}
	if code, _ := submit(Object{"name": "张三", "student": "202601010001"}, browser, id); code != 200 {
		t.Fatal("edit rejected", code)
	}
	if code, _ := submit(Object{"name": "张三", "student": "202601010001"}, "different-browser-very-long-key", id); code != 403 {
		t.Fatal("foreign edit accepted", code)
	}
	_, out := call(t, s, "GET", base, "", nil)
	builder := object(object(object(out["share"])["form"])["builder"])
	if builder["roster"] != nil {
		t.Fatal("roster leaked")
	}
	call(t, s, "PUT", "/api/shares/"+str(share, "id"), owner, Object{"form": Object{"builder": Object{"fields": []any{Object{"id": "name", "label": "姓名", "type": "text", "unique": true}}, "duplicate": "overwrite"}}})
	if code, _ := submit(Object{"name": "张三"}, browser, ""); code != 200 {
		t.Fatal("overwrite failed", code)
	}
	code, out = call(t, s, "GET", "/api/shares/"+str(share, "id")+"/submissions", owner, nil)
	if code != 200 || len(objects(out["submissions"])) != 1 {
		t.Fatal("overwrite created duplicate", out)
	}
}
