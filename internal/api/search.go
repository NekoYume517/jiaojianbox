package api

import (
	"context"
	"strings"
	"time"

	"github.com/NekoYume517/jiaojianbox/internal/store"
)

func searchSnippet(text, query string, limit int) string {
	text = strings.Join(strings.Fields(text), " ")
	if limit <= 0 {
		limit = 180
	}
	runes := []rune(text)
	if len(runes) <= limit {
		return text
	}
	lower := strings.ToLower(text)
	at := strings.Index(lower, strings.ToLower(query))
	if at < 0 {
		return string(runes[:limit]) + "…"
	}
	byteAt := len([]rune(text[:at]))
	start := byteAt - limit/3
	if start < 0 {
		start = 0
	}
	end := start + limit
	if end > len(runes) {
		end = len(runes)
		start = end - limit
		if start < 0 {
			start = 0
		}
	}
	return strings.TrimSpace(string(runes[start:end])) + "…"
}

func searchDateInRange(value string, from, to time.Time) bool {
	if value == "" {
		// Older attachments have no creation timestamp. A date filter should
		// not make those records disappear from an otherwise valid search.
		return true
	}
	at, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return from.IsZero() && to.IsZero()
	}
	return (from.IsZero() || !at.Before(from)) && (to.IsZero() || !at.After(to))
}

func parseSearchDate(value string, end bool) (time.Time, bool) {
	if strings.TrimSpace(value) == "" {
		return time.Time{}, true
	}
	if at, err := time.Parse(time.RFC3339Nano, value); err == nil {
		return at, true
	}
	if at, err := time.Parse("2006-01-02", value); err == nil {
		if end {
			return at.Add(24*time.Hour - time.Nanosecond), true
		}
		return at, true
	}
	return time.Time{}, false
}

func searchTypeAllowed(raw, kind string) bool {
	if raw == "" || raw == "all" {
		return true
	}
	for _, value := range strings.Split(raw, ",") {
		if strings.TrimSpace(value) == kind {
			return true
		}
	}
	return false
}

func searchStructuredText(value any) string {
	if value == nil {
		return ""
	}
	text := strings.TrimSpace(store.JSON(value))
	switch text {
	case "", "[]", "{}", "null", `""`:
		return ""
	default:
		return text
	}
}

func (s *Server) globalSearch(ctx context.Context, user, text, kinds, source, fromRaw, toRaw string, limit int) Object {
	queryText := strings.ToLower(strings.TrimSpace(text))
	if queryText == "" {
		return Object{"items": []Object{}, "query": ""}
	}
	from, okFrom := parseSearchDate(fromRaw, false)
	to, okTo := parseSearchDate(toRaw, true)
	if !okFrom || !okTo {
		fail(422, "搜索日期格式无效")
	}
	items := []Object{}
	appendIf := func(item Object, haystack, createdAt, itemSource string) {
		if len(items) >= limit || !searchTypeAllowed(kinds, str(item, "type")) {
			return
		}
		if source != "" && source != "all" && itemSource != source {
			return
		}
		if !searchDateInRange(createdAt, from, to) {
			return
		}
		if strings.Contains(strings.ToLower(haystack), queryText) {
			item["snippet"] = searchSnippet(haystack, text, 190)
			items = append(items, item)
		}
	}

	for _, row := range query(ctx, s.Store.DB, "SELECT payload,created_at FROM messages WHERE user_id=? AND deleted_at IS NULL ORDER BY rowid DESC LIMIT 5000", user) {
		payload := store.Payload(row)
		analysis := searchStructuredText(payload["analysis"])
		haystack := strings.Join([]string{str(payload, "text"), str(payload, "conversation_name"), str(payload, "sender_name"), analysis}, " ")
		appendIf(Object{
			"type": "message", "id": str(payload, "id"), "title": fallback(str(payload, "conversation_name"), "通知"),
			"source": str(payload, "source"), "created_at": str(payload, "sent_at"),
		}, haystack, str(payload, "sent_at"), str(payload, "source"))
	}
	for _, row := range query(ctx, s.Store.DB, "SELECT payload FROM tasks WHERE user_id=? AND deleted_at IS NULL ORDER BY rowid DESC", user) {
		payload := store.Payload(row)
		haystack := strings.Join([]string{str(payload, "title"), str(payload, "description"), searchStructuredText(payload["requirements"]), str(payload, "naming_hint"), str(payload, "submit_url")}, " ")
		appendIf(Object{
			"type": "task", "id": str(payload, "id"), "title": str(payload, "title"),
			"status": str(payload, "status"), "created_at": str(payload, "created_at"),
		}, haystack, str(payload, "created_at"), "task")
	}
	for _, row := range query(ctx, s.Store.DB, "SELECT id,task_id,name,size,kind,sha256,deleted_at FROM attachments WHERE user_id=? AND deleted_at IS NULL ORDER BY rowid DESC", user) {
		appendIf(Object{
			"type": "file", "id": str(row, "id"), "task_id": row["task_id"], "title": str(row, "name"),
			"size": row["size"], "kind": str(row, "kind"), "sha256": str(row, "sha256"),
		}, str(row, "name")+" "+str(row, "kind"), "", "file")
	}
	for _, row := range query(ctx, s.Store.DB, `SELECT s.id,s.task_id,s.payload,s.created_at AS share_created_at,
		m.id AS submission_id,m.name AS submitter,m.created_at AS submission_created_at,e.payload AS entry_payload
		FROM shares s
		LEFT JOIN share_submissions m ON m.share_id=s.id
		LEFT JOIN collection_entries e ON e.id=m.id
		WHERE s.user_id=? ORDER BY COALESCE(m.created_at,s.created_at) DESC LIMIT 3000`, user) {
		sharePayload := store.Payload(row)
		if str(sharePayload, "purpose") != "collect" {
			continue
		}
		haystack := strings.Join([]string{str(row, "submitter"), str(row, "entry_payload"), str(sharePayload, "task_title")}, " ")
		title := str(row, "submitter")
		if title == "" {
			title = fallback(str(sharePayload, "task_title"), "收集记录")
		}
		appendIf(Object{
			"type": "collection", "id": str(row, "submission_id"), "share_id": str(row, "id"),
			"task_id": row["task_id"], "title": title,
			"created_at": fallback(str(row, "submission_created_at"), str(row, "share_created_at")),
		}, haystack, fallback(str(row, "submission_created_at"), str(row, "share_created_at")), "collection")
	}
	for _, row := range query(ctx, s.Store.DB, `SELECT a.id,a.name,a.size,a.kind,m.id AS submission_id,s.id AS share_id,s.task_id,
		m.created_at AS submission_created_at
		FROM share_submission_files f
		JOIN attachments a ON a.id=f.attachment_id
		JOIN share_submissions m ON m.id=f.submission_id
		JOIN shares s ON s.id=m.share_id
		WHERE s.user_id=? AND a.deleted_at IS NULL LIMIT 3000`, user) {
		appendIf(Object{
			"type": "collection-file", "id": str(row, "id"), "share_id": str(row, "share_id"),
			"submission_id": str(row, "submission_id"), "task_id": row["task_id"],
			"title": str(row, "name"), "size": row["size"], "kind": str(row, "kind"),
			"created_at": str(row, "submission_created_at"),
		}, str(row, "name"), str(row, "submission_created_at"), "collection")
	}
	return Object{"items": items, "query": text, "count": len(items)}
}

func (s *Server) searchRoutes() {
	s.route("GET /api/search", "owner", func(r request) any {
		return s.globalSearch(
			r.Context(), r.User, r.URL.Query().Get("q"), r.URL.Query().Get("type"),
			fallback(r.URL.Query().Get("source"), "all"), r.URL.Query().Get("from"),
			r.URL.Query().Get("to"), r.integer("limit", 80, 1, 200),
		)
	})
}
