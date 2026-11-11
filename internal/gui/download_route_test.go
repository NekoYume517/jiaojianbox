package gui

import "testing"

func TestDownloadPatternAllowsExports(t *testing.T) {
	allowed := []string{
		"/api/files/8f14e45f-ceea-467a-9bc4-6b1c8b7a1c3d",
		"/api/tasks/8f14e45f-ceea-467a-9bc4-6b1c8b7a1c3d/package",
		"/api/shares/8f14e45f-ceea-467a-9bc4-6b1c8b7a1c3d/export",
		"/api/shares/8f14e45f-ceea-467a-9bc4-6b1c8b7a1c3d/export?kind=files",
		"/api/shares/8f14e45f-ceea-467a-9bc4-6b1c8b7a1c3d/export?kind=sheet",
		"/api/workspace/export",
	}
	for _, route := range allowed {
		if !downloadPattern.MatchString(route) {
			t.Fatalf("expected %q to be downloadable", route)
		}
	}
	blocked := []string{
		"/api/shares/8f14e45f-ceea-467a-9bc4-6b1c8b7a1c3d",
		"/api/shares/8f14e45f-ceea-467a-9bc4-6b1c8b7a1c3d/export/../keys",
		"/api/shares/not-a-uuid/export",
		"/api/files/8f14e45f-ceea-467a-9bc4-6b1c8b7a1c3d?path=../../etc/passwd",
		"http://127.0.0.1:1/api/files/8f14e45f-ceea-467a-9bc4-6b1c8b7a1c3d",
		"/api/workspace/import",
		"/api/keys",
	}
	for _, route := range blocked {
		if downloadPattern.MatchString(route) {
			t.Fatalf("expected %q to be rejected", route)
		}
	}
}

func TestDropContentType(t *testing.T) {
	cases := map[string]string{
		"名单.CSV":      "text/csv",
		"截图.PNG":      "image/png",
		"任务.xlsx":     "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		"unknown.bin": "application/octet-stream",
		"noext":       "application/octet-stream",
	}
	for name, want := range cases {
		if got := dropContentType(name); got != want {
			t.Fatalf("dropContentType(%q) = %q, want %q", name, got, want)
		}
	}
}
