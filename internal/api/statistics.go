package api

import (
	"math"
	"sort"
	"time"
)

func average(values []float64) any {
	if len(values) == 0 {
		return nil
	}
	sum := float64(0)
	for _, v := range values {
		sum += v
	}
	return math.Round(sum / float64(len(values)))
}
func (s *Server) statisticsRoutes() {
	s.route("GET /api/statistics", "owner", func(r request) any {
		days := r.integer("days", 30, 1, 365)
		now := time.Now().In(zone)
		start := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, zone).AddDate(0, 0, 1-days)
		rows := query(r.Context(), s.Store.DB, "SELECT kind,model,status,started_at,duration_ms,CASE WHEN streamed=1 THEN first_token_ms ELSE NULL END AS first_token_ms,prompt_tokens,completion_tokens,total_tokens,http_status,usage_reported,streamed,managed FROM llm_calls WHERE user_id=? AND started_at>=? ORDER BY started_at DESC", r.User, start.UTC().Format(time.RFC3339Nano))
		source := r.URL.Query().Get("source")
		if source != "" && !choice(source, "managed", "custom") {
			fail(422, "统计来源无效")
		}
		if source != "" {
			filtered := []Object{}
			for _, row := range rows {
				if boolean(row, "managed") == (source == "managed") {
					filtered = append(filtered, row)
				}
			}
			rows = filtered
		}
		daily := []Object{}
		byDate := map[string]Object{}
		latencies := map[string][]float64{}
		firstTokens := map[string][]float64{}
		models := map[string]Object{}
		allLatencies := []float64{}
		for i := 0; i < days; i++ {
			day := start.AddDate(0, 0, i).Format(time.DateOnly)
			item := Object{"date": day, "calls": 0, "success": 0, "failed": 0, "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "unreported": 0, "managed_tokens": 0, "custom_tokens": 0}
			daily = append(daily, item)
			byDate[day] = item
		}
		for _, row := range rows {
			date, err := time.Parse(time.RFC3339Nano, str(row, "started_at"))
			if err != nil {
				continue
			}
			day := date.In(zone).Format(time.DateOnly)
			item := byDate[day]
			if item == nil {
				continue
			}
			item["calls"] = num(item, "calls") + 1
			status := "failed"
			if str(row, "status") == "success" {
				status = "success"
				latencies[day] = append(latencies[day], num(row, "duration_ms"))
				allLatencies = append(allLatencies, num(row, "duration_ms"))
				if row["first_token_ms"] != nil {
					firstTokens[day] = append(firstTokens[day], num(row, "first_token_ms"))
				}
			}
			item[status] = num(item, status) + 1
			for _, key := range []string{"prompt_tokens", "completion_tokens", "total_tokens"} {
				item[key] = num(item, key) + num(row, key)
			}
			if boolean(row, "managed") {
				item["managed_tokens"] = num(item, "managed_tokens") + num(row, "total_tokens")
			} else {
				item["custom_tokens"] = num(item, "custom_tokens") + num(row, "total_tokens")
			}
			if !boolean(row, "usage_reported") {
				item["unreported"] = num(item, "unreported") + 1
			}
			model := str(row, "model")
			if models[model] == nil {
				models[model] = Object{"model": model, "calls": 0, "total_tokens": 0, "unreported": 0}
			}
			m := models[model]
			m["calls"] = num(m, "calls") + 1
			m["total_tokens"] = num(m, "total_tokens") + num(row, "total_tokens")
			if !boolean(row, "usage_reported") {
				m["unreported"] = num(m, "unreported") + 1
			}
		}
		total := Object{"calls": 0, "success": 0, "failed": 0, "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "unreported": 0, "managed_tokens": 0, "custom_tokens": 0, "success_rate": nil, "average_ms": average(allLatencies)}
		for _, item := range daily {
			day := str(item, "date")
			values := latencies[day]
			sort.Float64s(values)
			item["average_ms"] = average(values)
			item["first_token_ms"] = average(firstTokens[day])
			item["p95_ms"] = nil
			if len(values) > 0 {
				item["p95_ms"] = math.Round(values[int(math.Ceil(float64(len(values))*.95))-1])
			}
			for _, key := range []string{"calls", "success", "failed", "prompt_tokens", "completion_tokens", "total_tokens", "unreported", "managed_tokens", "custom_tokens"} {
				total[key] = num(total, key) + num(item, key)
			}
		}
		if num(total, "calls") > 0 {
			total["success_rate"] = math.Round(num(total, "success")/num(total, "calls")*1000) / 10
		}
		modelList := []Object{}
		for _, m := range models {
			modelList = append(modelList, m)
		}
		sort.Slice(modelList, func(i, j int) bool { return num(modelList[i], "total_tokens") > num(modelList[j], "total_tokens") })
		if len(rows) > 30 {
			rows = rows[:30]
		}
		return Object{"days": days, "timezone": "Asia/Shanghai", "daily": daily, "total": total, "models": modelList, "recent": rows}
	})
}
