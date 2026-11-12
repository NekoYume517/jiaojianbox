package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"strings"

	"github.com/NekoYume517/jiaojianbox/internal/store"
)

func rosterIdentity(fields []string, values Object) string {
	parts := make([]string, 0, len(fields))
	hasValue := false
	for _, field := range fields {
		value := strings.ToLower(strings.TrimSpace(fmtValue(values[field])))
		if value != "" {
			hasValue = true
		}
		parts = append(parts, field+"="+value)
	}
	if !hasValue {
		return ""
	}
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x1f")))
	return hex.EncodeToString(sum[:])
}

func rosterLabel(fields []string, values Object) string {
	parts := []string{}
	for _, field := range fields {
		if value := strings.TrimSpace(fmtValue(values[field])); value != "" {
			parts = append(parts, value)
		}
	}
	return fallback(strings.Join(parts, " · "), "未命名提交者")
}

func (s *Server) collectionStatus(ctx context.Context, user, shareID string) Object {
	row := one(ctx, s.Store.DB, "SELECT * FROM shares WHERE id=? AND user_id=?", shareID, user)
	payload := sharePayloadFor(row)
	if str(payload, "purpose") != "collect" {
		fail(400, "只有收集表单包含提交状态")
	}
	builder := object(shareForm(payload)["builder"])
	fields := []string{}
	for _, value := range list(builder, "roster_fields") {
		if text, ok := value.(string); ok && text != "" {
			fields = append(fields, text)
		}
	}
	sort.Strings(fields)
	roster := objects(builder["roster"])
	hasRoster := len(roster) > 0 && len(fields) > 0
	submissions := query(ctx, s.Store.DB, `SELECT m.id,m.name,m.contact,m.created_at,e.payload
		FROM share_submissions m LEFT JOIN collection_entries e ON e.id=m.id
		WHERE m.share_id=? ORDER BY m.created_at`, shareID)
	exemptions := map[string]Object{}
	for _, item := range query(ctx, s.Store.DB, "SELECT identity_key,reason,created_at FROM collection_exemptions WHERE share_id=? AND user_id=?", shareID, user) {
		exemptions[str(item, "identity_key")] = item
	}
	byIdentity := map[string][]Object{}
	unmatched := []Object{}
	for _, submission := range submissions {
		if !hasRoster {
			continue
		}
		values := store.Payload(submission)
		key := rosterIdentity(fields, values)
		if key != "" {
			byIdentity[key] = append(byIdentity[key], Object{
				"id": str(submission, "id"), "name": submission["name"], "created_at": submission["created_at"],
			})
			continue
		}
		unmatched = append(unmatched, Object{
			"id": str(submission, "id"), "name": submission["name"], "created_at": submission["created_at"],
		})
	}
	people := make([]Object, 0, len(roster))
	missing := []string{}
	submittedCount, exemptCount := 0, 0
	if hasRoster {
		for _, person := range roster {
			key := rosterIdentity(fields, person)
			matches := byIdentity[key]
			exemption := exemptions[key]
			exempt := exemption != nil
			status := "missing"
			if len(matches) > 0 {
				status = "submitted"
				submittedCount++
			} else if exempt {
				status = "exempt"
				exemptCount++
			} else {
				missing = append(missing, rosterLabel(fields, person))
			}
			people = append(people, Object{
				"identity_key": key, "fields": person, "label": rosterLabel(fields, person),
				"status": status, "submissions": matches, "duplicate_count": maxInt(0, len(matches)-1),
				"exemption_reason": fallback(str(exemption, "reason"), ""),
			})
		}
	} else {
		submittedCount = len(submissions)
	}
	duplicates := 0
	for _, matches := range byIdentity {
		if len(matches) > 1 {
			duplicates += len(matches) - 1
		}
	}
	expected := len(roster)
	if !hasRoster {
		expected = len(submissions)
	}
	report := "尚无可用于核对的名单，配置名单后可以生成催交名单。\n"
	if hasRoster {
		report = "请尚未提交的同学尽快完成：\n"
		if len(missing) > 0 {
			for index, name := range missing {
				report += fmtValue(index+1) + ". " + name + "\n"
			}
		} else {
			report = "名单内成员均已提交，无需催交。\n"
		}
	}
	return Object{
		"share_id": shareID, "task_id": row["task_id"], "expected": expected,
		"submitted": submittedCount, "missing_count": len(missing), "exempt": exemptCount,
		"duplicate_count": duplicates, "unmatched_count": len(unmatched),
		"people": people, "unmatched": unmatched, "reminder_text": report,
		"roster_fields": fields, "has_roster": hasRoster,
	}
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func (s *Server) collectionStatusRoutes() {
	s.route("GET /api/shares/{share_id}/collection-status", "owner", func(r request) any {
		return s.collectionStatus(r.Context(), r.User, r.PathValue("share_id"))
	})
	s.route("POST /api/shares/{share_id}/exemptions", "owner", func(r request) any {
		input := r.body()
		shareID, identity := r.PathValue("share_id"), str(input, "identity_key")
		status := s.collectionStatus(r.Context(), r.User, shareID)
		found := false
		for _, person := range objects(status["people"]) {
			if str(person, "identity_key") == identity {
				found = true
				break
			}
		}
		if !found {
			fail(422, "名单成员不存在")
		}
		if boolean(input, "exempt") {
			exec(r.Context(), s.Store.DB, `INSERT INTO collection_exemptions(share_id,user_id,identity_key,reason,created_at)
				VALUES(?,?,?,?,?) ON CONFLICT(share_id,identity_key) DO UPDATE SET reason=excluded.reason,created_at=excluded.created_at`,
				shareID, r.User, identity, clip(str(input, "reason"), 200), store.Now())
		} else {
			exec(r.Context(), s.Store.DB, "DELETE FROM collection_exemptions WHERE share_id=? AND user_id=? AND identity_key=?", shareID, r.User, identity)
		}
		event(r.Context(), s.Store.DB, r.User, "share.upsert", shareID)
		return s.collectionStatus(r.Context(), r.User, shareID)
	})
}
