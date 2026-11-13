package api

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/NekoYume517/jiaojianbox/internal/store"
)

type progress func(Object)

const defaultModelContextWindow = 262144

func endpoint(base, action string) string {
	base = serverURL(base)
	base = strings.TrimSuffix(base, "/chat/completions")
	return base + "/" + action
}
func defaultLLM() Object {
	return Object{"service_mode": "", "base_url": "", "model": "", "context_count": 12, "context_window_tokens": defaultModelContextWindow, "auto_analyze": false, "vision_enabled": false, "batch_triage": true, "local_triage": true, "include_keywords": "", "exclude_keywords": "", "instruction": ""}
}
func (s *Server) llmConfig(ctx context.Context, user string) (Object, string) {
	config := defaultLLM()
	row := first(query(ctx, s.Store.DB, "SELECT payload,secret FROM llm_settings WHERE user_id=?", user))
	if row == nil {
		return config, ""
	}
	for k, v := range store.Payload(row) {
		config[k] = v
	}
	delete(config, "auto_task")
	key, err := s.Store.Decrypt(str(row, "secret"))
	check(err)
	return config, key
}
func llmInput(ctx context.Context, body Object) Object {
	out := defaultLLM()
	for k := range out {
		if v, ok := body[k]; ok {
			out[k] = v
		}
	}
	if !choice(str(out, "service_mode"), "", "managed", "custom") {
		fail(422, "AI 服务类型无效")
	}
	for _, key := range []string{"service_mode", "base_url", "model", "include_keywords", "exclude_keywords", "instruction"} {
		if _, ok := out[key].(string); !ok {
			fail(422, "AI 配置类型无效："+key)
		}
	}
	for _, key := range []string{"auto_analyze", "vision_enabled", "batch_triage", "local_triage"} {
		if _, ok := out[key].(bool); !ok {
			fail(422, "AI 开关类型无效："+key)
		}
	}
	if n := num(out, "context_count"); n != float64(int(n)) {
		fail(422, "上下文条数须为整数")
	}
	if str(out, "base_url") != "" {
		url := endpoint(str(out, "base_url"), "chat/completions")
		if err := validateStoredOutboundURL(url); err != nil {
			fail(422, err.Error())
		}
	}
	if num(out, "context_count") < 0 || num(out, "context_count") > 50 {
		fail(422, "上下文条数应为 0 至 50")
	}
	if n := num(out, "context_window_tokens"); n != float64(int(n)) || n < 8192 || n > 2_000_000 {
		fail(422, "模型上下文窗口应为 8,192 至 2,000,000 tokens")
	}
	for k, max := range map[string]int{"base_url": 2000, "model": 150, "include_keywords": 1000, "exclude_keywords": 1000, "instruction": 4000} {
		if len([]rune(str(out, k))) > max {
			fail(422, "AI 配置字段过长："+k)
		}
	}
	return out
}
func notify(p progress, value Object) {
	if p != nil {
		p(value)
	}
}
func compactMessage(m Object) Object {
	out := Object{}
	for _, k := range []string{"id", "source", "conversation_name", "sender_name", "sent_at", "text"} {
		out[k] = m[k]
	}
	if q := object(m["metadata"])["quote"]; q != nil {
		out["quote"] = q
	}
	return out
}
func compactTasks(tasks []Object) []Object {
	out := []Object{}
	for _, task := range tasks {
		item := Object{}
		for _, k := range []string{"id", "title", "status", "due_at", "urgency", "created_at", "conversation"} {
			item[k] = task[k]
		}
		out = append(out, item)
	}
	return out
}

func robustJSON(text string) Object {
	start := strings.IndexByte(text, '{')
	if start < 0 {
		fail(502, "模型没有返回分类结果")
	}
	depth := 0
	quoted, escape := false, false
	end := -1
	for i := start; i < len(text); i++ {
		c := text[i]
		if quoted {
			if escape {
				escape = false
			} else if c == '\\' {
				escape = true
			} else if c == '"' {
				quoted = false
			}
		} else {
			switch c {
			case '"':
				quoted = true
			case '{':
				depth++
			case '}':
				depth--
				if depth == 0 {
					end = i + 1
				}
			}
		}
		if end >= 0 {
			break
		}
	}
	if end < 0 {
		fail(502, "模型输出被截断，请重试或调整模型输出长度")
	}
	candidate := text[start:end]
	var obj Object
	if json.Unmarshal([]byte(candidate), &obj) == nil && obj != nil {
		return obj
	}
	var cleaned strings.Builder
	quoted = false
	escape = false
	for i := 0; i < len(candidate); i++ {
		c := candidate[i]
		if !quoted && c == ',' {
			rest := strings.TrimSpace(candidate[i+1:])
			if strings.HasPrefix(rest, "}") || strings.HasPrefix(rest, "]") {
				continue
			}
		}
		cleaned.WriteByte(c)
		if quoted {
			if escape {
				escape = false
			} else if c == '\\' {
				escape = true
			} else if c == '"' {
				quoted = false
			}
		} else if c == '"' {
			quoted = true
		}
	}
	if json.Unmarshal([]byte(cleaned.String()), &obj) != nil || obj == nil {
		fail(502, "模型输出格式不完整，请重试")
	}
	return obj
}
func unwrap(raw Object, file bool) Object {
	for range 3 {
		if raw["classification"] != nil || file && (raw["category"] != nil || raw["task_id"] != nil) {
			return raw
		}
		nested := []Object{}
		for _, v := range raw {
			if m, ok := v.(map[string]any); ok {
				nested = append(nested, m)
			}
		}
		if len(nested) != 1 {
			break
		}
		raw = nested[0]
	}
	fail(502, "模型未返回可识别的分类")
	return nil
}
func asList(value any, limit int) []any {
	var out []any
	switch v := value.(type) {
	case []any:
		out = v
	case string:
		out = []any{v}
	case map[string]any:
		out = []any{v}
	default:
		return []any{}
	}
	if len(out) > limit {
		return out[:limit]
	}
	return out
}
func textList(value any, limit, width int) []any {
	out := []any{}
	for _, v := range asList(value, limit) {
		out = append(out, clip(fmtValue(v), width))
	}
	return out
}
func normalizeAnalysis(raw Object) Object {
	raw = unwrap(raw, false)
	aliases := map[string]string{"actionable": "actionable", "action": "actionable", "task": "actionable", "todo": "actionable", "assignment": "actionable", "submission": "actionable", "任务": "actionable", "待办": "actionable", "交件通知": "actionable", "chatting": "chatting", "chat": "chatting", "conversation": "chatting", "normal": "chatting", "普通聊天": "chatting", "闲聊": "chatting", "聊天": "chatting", "irrelevant": "irrelevant", "spam": "irrelevant", "ad": "irrelevant", "system": "irrelevant", "无关": "irrelevant", "无关信息": "irrelevant", "其他信息": "irrelevant", "广告": "irrelevant"}
	classification := aliases[strings.ToLower(strings.TrimSpace(str(raw, "classification")))]
	if classification == "" {
		fail(502, "模型返回了无法识别的分类")
	}
	out := Object{"classification": classification, "confidence": confidence(raw["confidence"]), "due_at": iso(raw["due_at"]), "urgency": "normal", "reminder_suggestions": []any{}, "requirements": []any{}, "max_total_bytes": nil, "duplicate": false, "duplicate_of": nil}
	for key, width := range map[string]int{"reason": 2000, "summary": 4000, "title": 200, "naming_hint": 300, "submit_url": 2000} {
		out[key] = clip(fmtValue(raw[key]), width)
	}
	urgency := strings.ToLower(str(raw, "urgency"))
	if choice(urgency, "high", "urgent", "紧急", "高") {
		out["urgency"] = "high"
	} else if choice(urgency, "low", "低", "不急") {
		out["urgency"] = "low"
	}
	suggestions := []any{}
	seen := map[string]bool{}
	for _, v := range asList(raw["reminder_suggestions"], 20) {
		if date := iso(v); date != nil && !seen[date.(string)] {
			seen[date.(string)] = true
			suggestions = append(suggestions, date)
		}
		if len(suggestions) == 3 {
			break
		}
	}
	out["reminder_suggestions"] = suggestions
	requirements := []any{}
	for _, value := range asList(raw["requirements"], 50) {
		req := object(value)
		if label, ok := value.(string); ok {
			req = Object{"label": label}
		}
		label := strings.TrimSpace(clip(fmtValue(req["label"]), 100))
		if label == "" {
			continue
		}
		count, _ := strconv.Atoi(fmtValue(req["min_count"]))
		if count < 1 {
			count = 1
		}
		if count > 50 {
			count = 50
		}
		extensions := asList(req["extensions"], 30)
		if text, ok := req["extensions"].(string); ok {
			extensions = []any{}
			for _, part := range strings.FieldsFunc(text, func(r rune) bool { return strings.ContainsRune(",，、;； /\t", r) }) {
				extensions = append(extensions, part)
			}
		}
		normalized := []any{}
		seen := map[string]bool{}
		for _, v := range extensions {
			ext := strings.TrimLeft(strings.ToLower(strings.TrimSpace(fmtValue(v))), "*.")
			if extensionPattern.MatchString(ext) && !seen[ext] && len(normalized) < 12 {
				normalized = append(normalized, ext)
				seen[ext] = true
			}
		}
		requirements = append(requirements, Object{"label": label, "extensions": normalized, "min_count": count})
	}
	out["requirements"] = requirements
	if size, err := strconv.ParseInt(fmtValue(raw["max_total_bytes"]), 10, 64); err == nil && size > 0 && size <= 1e12 {
		out["max_total_bytes"] = size
	}
	if u := str(out, "submit_url"); !strings.HasPrefix(u, "http://") && !strings.HasPrefix(u, "https://") {
		out["submit_url"] = ""
	}
	out["evidence"] = textList(raw["evidence"], 6, 500)
	out["notes"] = textList(raw["notes"], 20, 400)
	out["duplicate"] = choice(strings.ToLower(fmtValue(raw["duplicate"])), "true", "1", "yes", "是")
	if id := str(raw, "duplicate_of"); id != "" {
		out["duplicate_of"] = id
	}
	return out
}

type chatCall struct {
	Text    string
	Calls   []Object
	Metrics Object
}

func (s *Server) chat(ctx context.Context, config Object, key string, messages []Object, tools []Object, p progress, observe func(Object), options ...Object) chatCall {
	started := time.Now()
	out := chatCall{Metrics: Object{"streamed": false, "usage_reported": false, "http_status": 200, "first_token_ms": nil, "prompt_tokens": nil, "completion_tokens": nil, "total_tokens": nil}}
	defer func() {
		out.Metrics["elapsed_ms"] = time.Since(started).Milliseconds()
		if observe != nil {
			observe(out.Metrics)
		}
	}()
	option := Object{}
	if len(options) > 0 {
		option = options[0]
	}
	jsonMode := true
	if value, ok := option["json_mode"].(bool); ok {
		jsonMode = value
	}
	maxTokens := int(num(option, "max_tokens"))
	if maxTokens < 256 {
		maxTokens = 6000
	}
	if maxTokens > 32000 {
		maxTokens = 32000
	}
	body := Object{"model": config["model"], "messages": messages, "stream": true, "temperature": .1, "max_tokens": maxTokens, "stream_options": Object{"include_usage": true}}
	if jsonMode {
		body["response_format"] = Object{"type": "json_object"}
	}
	if len(tools) > 0 {
		body["tools"] = tools
	}
	out.Metrics["input_chars"] = len([]rune(store.JSON(messages)))
	notify(p, Object{"stage": "request", "input_chars": out.Metrics["input_chars"]})
	for retries := 0; retries < 4; retries++ {
		req, err := outboundRequest(ctx, "POST", endpoint(str(config, "base_url"), "chat/completions"), strings.NewReader(store.JSON(body)))
		if err != nil {
			fail(502, err.Error())
		}
		req.Header.Set("Content-Type", "application/json")
		if key != "" {
			req.Header.Set("Authorization", "Bearer "+key)
		}
		client := outboundClient(180 * time.Second)
		resp, err := client.Do(req)
		if err != nil {
			fail(502, "AI 连接失败或超时，请检查模型接口")
		}
		out.Metrics["http_status"] = resp.StatusCode
		if resp.StatusCode == 400 {
			raw, _ := io.ReadAll(io.LimitReader(resp.Body, 65536))
			resp.Body.Close()
			text := strings.ToLower(string(raw))
			retry := false
			if _, ok := body["stream_options"]; ok && (strings.Contains(text, "stream_options") || strings.Contains(text, "include_usage")) {
				delete(body, "stream_options")
				retry = true
			} else if _, ok := body["response_format"]; ok && (strings.Contains(text, "response_format") || strings.Contains(text, "json_object") || strings.Contains(text, "json mode")) {
				delete(body, "response_format")
				retry = true
			} else if _, ok := body["tools"]; ok && strings.Contains(text, "tool") && (strings.Contains(text, "unsupported") || strings.Contains(text, "not support") || strings.Contains(text, "unknown")) {
				delete(body, "tools")
				retry = true
			}
			if retry {
				continue
			}
			fail(502, "AI 接口返回 HTTP 400，请检查模型配置")
		}
		if resp.StatusCode >= 300 {
			resp.Body.Close()
			fail(502, fmt.Sprintf("AI 接口返回 HTTP %d", resp.StatusCode))
		}
		if strings.Contains(resp.Header.Get("Content-Type"), "text/event-stream") {
			out.Metrics["streamed"] = true
			calls := map[int]Object{}
			scanner := bufio.NewScanner(resp.Body)
			scanner.Buffer(make([]byte, 4096), 1<<20)
			for scanner.Scan() {
				line := scanner.Text()
				if !strings.HasPrefix(line, "data:") {
					continue
				}
				data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
				if data == "[DONE]" {
					break
				}
				if data == "" {
					continue
				}
				packet := decodeObject(data)
				if packet["error"] != nil {
					resp.Body.Close()
					fail(502, "模型流式响应失败")
				}
				usage(out.Metrics, object(packet["usage"]))
				choices := objects(packet["choices"])
				if len(choices) == 0 {
					continue
				}
				delta := object(choices[0]["delta"])
				for _, piece := range objects(delta["tool_calls"]) {
					index := int(num(piece, "index"))
					slot := calls[index]
					if slot == nil {
						slot = Object{"id": "call-" + fmt.Sprint(index), "name": "", "arguments": ""}
						calls[index] = slot
					}
					if str(piece, "id") != "" {
						slot["id"] = piece["id"]
					}
					fn := object(piece["function"])
					if str(fn, "name") != "" {
						slot["name"] = fn["name"]
					}
					slot["arguments"] = str(slot, "arguments") + str(fn, "arguments")
				}
				if content := str(delta, "content"); content != "" {
					if out.Metrics["first_token_ms"] == nil {
						out.Metrics["first_token_ms"] = time.Since(started).Milliseconds()
					}
					out.Text += content
					if len(out.Text) > 1<<20 {
						resp.Body.Close()
						fail(502, "模型响应过大")
					}
					notify(p, Object{"stage": "receiving", "delta": content, "received_chars": len([]rune(out.Text)), "elapsed_ms": time.Since(started).Milliseconds()})
				}
			}
			err = scanner.Err()
			resp.Body.Close()
			check(err)
			indexes := []int{}
			for i := range calls {
				indexes = append(indexes, i)
			}
			sort.Ints(indexes)
			for _, i := range indexes {
				slot := calls[i]
				out.Calls = append(out.Calls, Object{"id": slot["id"], "type": "function", "function": Object{"name": slot["name"], "arguments": fallback(str(slot, "arguments"), "{}")}})
			}
		} else {
			raw, err := io.ReadAll(io.LimitReader(resp.Body, (1<<20)+1))
			resp.Body.Close()
			check(err)
			if len(raw) > 1<<20 {
				fail(502, "模型响应过大")
			}
			packet := decodeObject(string(raw))
			usage(out.Metrics, object(packet["usage"]))
			choices := objects(packet["choices"])
			if len(choices) == 0 {
				fail(502, "模型未返回结果")
			}
			message := object(choices[0]["message"])
			out.Text = str(message, "content")
			out.Calls = objects(message["tool_calls"])
			notify(p, Object{"stage": "receiving", "delta": out.Text, "received_chars": len([]rune(out.Text))})
		}
		out.Metrics["elapsed_ms"] = time.Since(started).Milliseconds()
		out.Metrics["output_chars"] = len([]rune(out.Text))
		return out
	}
	fail(502, "模型接口不支持当前请求格式")
	return out
}
func usage(metrics, usage Object) {
	for _, k := range []string{"prompt_tokens", "completion_tokens", "total_tokens"} {
		if value, ok := usage[k]; ok {
			metrics[k] = value
		}
	}
	if metrics["total_tokens"] == nil && metrics["prompt_tokens"] != nil && metrics["completion_tokens"] != nil {
		metrics["total_tokens"] = num(metrics, "prompt_tokens") + num(metrics, "completion_tokens")
	}
	metrics["usage_reported"] = metrics["total_tokens"] != nil
}
func (s *Server) tools(ctx context.Context, user, messageID, name string, args Object) Object {
	switch name {
	case "get_now":
		return Object{"now": time.Now().In(zone).Format(time.RFC3339Nano), "timezone": "Asia/Shanghai", "weekday": time.Now().In(zone).Weekday().String()}
	case "list_recent_tasks":
		tasks := []Object{}
		limit := int(num(args, "limit"))
		if limit < 1 {
			limit = 30
		}
		if limit > 100 {
			limit = 100
		}
		for _, row := range query(ctx, s.Store.DB, "SELECT payload FROM tasks WHERE user_id=? ORDER BY rowid DESC LIMIT ?", user, limit) {
			tasks = append(tasks, store.Payload(row))
		}
		return Object{"tasks": compactTasks(tasks)}
	case "get_task_detail":
		rows := query(ctx, s.Store.DB, "SELECT payload FROM tasks WHERE user_id=? AND id=?", user, str(args, "task_id"))
		if len(rows) == 0 {
			return Object{"error": "待办不存在"}
		}
		return store.Payload(rows[0])
	case "get_recent_messages":
		limit := int(num(args, "limit"))
		if limit < 1 {
			limit = 10
		}
		if limit > 30 {
			limit = 30
		}
		messages := []Object{}
		for _, row := range query(ctx, s.Store.DB, "SELECT payload FROM messages WHERE user_id=? AND (json_extract(payload,'$.conversation_id')=? OR json_extract(payload,'$.conversation_name')=?) ORDER BY rowid DESC LIMIT ?", user, str(args, "conversation"), str(args, "conversation"), limit) {
			m := store.Payload(row)
			messages = append(messages, compactMessage(m))
		}
		return Object{"messages": messages}
	case "append_to_task":
		taskID := str(args, "task_id")
		if taskID == "" {
			return Object{"error": "缺少待办 ID"}
		}
		result := s.transaction(ctx, func(db store.SQL) any {
			return s.appendToTask(ctx, db, user, messageID, taskID, args)
		})
		return object(result)
	}
	return Object{"error": "未知工具"}
}
func mergeMetrics(previous, current Object) Object {
	out := Object{}
	for k, v := range current {
		out[k] = v
	}
	if len(previous) == 0 {
		return out
	}
	out["elapsed_ms"] = num(previous, "elapsed_ms") + num(current, "elapsed_ms")
	out["input_chars"] = num(previous, "input_chars") + num(current, "input_chars")
	for _, k := range []string{"prompt_tokens", "completion_tokens", "total_tokens"} {
		if previous[k] != nil && current[k] != nil {
			out[k] = num(previous, k) + num(current, k)
		} else {
			out[k] = nil
		}
	}
	out["usage_reported"] = out["total_tokens"] != nil
	if previous["first_token_ms"] != nil {
		out["first_token_ms"] = previous["first_token_ms"]
	} else if current["first_token_ms"] != nil {
		out["first_token_ms"] = num(previous, "elapsed_ms") + num(current, "first_token_ms")
	}
	out["streamed"] = boolean(previous, "streamed") || boolean(current, "streamed")
	return out
}

func (s *Server) recordLLM(ctx context.Context, user, kind string, config Object, started time.Time, metrics Object, success bool) {
	if metrics == nil {
		metrics = Object{}
	}
	status := "failed"
	if success {
		status = "success"
	}
	duration := metrics["elapsed_ms"]
	if duration == nil {
		duration = time.Since(started).Milliseconds()
	}
	exec(ctx, s.Store.DB, "INSERT INTO llm_calls(id,user_id,kind,model,status,started_at,duration_ms,first_token_ms,prompt_tokens,completion_tokens,total_tokens,http_status,usage_reported,streamed,managed) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", store.ID(), user, kind, str(config, "model"), status, started.UTC().Format(time.RFC3339Nano), duration, metrics["first_token_ms"], metrics["prompt_tokens"], metrics["completion_tokens"], metrics["total_tokens"], metrics["http_status"], boolean(metrics, "usage_reported"), boolean(metrics, "streamed"), boolean(config, "managed"))
	if success && boolean(config, "managed") && boolean(metrics, "usage_reported") {
		s.aiSpend(ctx, user, num(metrics, "total_tokens"))
	}
}

func (s *Server) stream(r request, work func(context.Context, progress) any) any {
	return s.streamWithTimeout(r, 3*time.Minute, work)
}

func (s *Server) streamWithTimeout(r request, timeout time.Duration, work func(context.Context, progress) any) any {
	return s.streamRequest(r, timeout, false, work)
}

// streamDetachedWithTimeout keeps server work alive after the browser closes
// the event stream. Agent runs use this so navigating away only detaches the
// view; an explicit stop request remains the way to cancel the run.
func (s *Server) streamDetachedWithTimeout(r request, timeout time.Duration, work func(context.Context, progress) any) any {
	return s.streamRequest(r, timeout, true, work)
}

func (s *Server) streamRequest(r request, timeout time.Duration, detach bool, work func(context.Context, progress) any) any {
	clientDone := r.Context().Done()
	base := r.Context()
	if detach {
		base = context.WithoutCancel(base)
	}
	ctx, cancel := context.WithTimeout(base, timeout)
	r.Request = r.WithContext(ctx)
	r.W.Header().Set("Content-Type", "text/event-stream")
	r.W.Header().Set("X-Accel-Buffering", "no")
	r.W.Header().Set("Cache-Control", "no-cache")
	flusher, ok := r.W.(http.Flusher)
	if !ok {
		fail(500, "流式输出不可用")
	}
	emit := func(kind string, value any) bool {
		http.NewResponseController(r.W).SetWriteDeadline(time.Now().Add(10 * time.Second))
		_, err := fmt.Fprintf(r.W, "event: %s\ndata: %s\n\n", kind, store.JSON(value))
		if err != nil {
			if !detach {
				cancel()
			}
			return false
		}
		flusher.Flush()
		return true
	}
	defer http.NewResponseController(r.W).SetWriteDeadline(time.Time{})
	if !emit("progress", Object{"stage": "waiting"}) {
		return nil
	}
	type outcome struct {
		result any
		err    error
	}
	updates := make(chan Object, 16)
	done := make(chan outcome, 1)
	go func() {
		result, err := attempt(func() any {
			return work(ctx, func(value Object) {
				select {
				case updates <- value:
				case <-clientDone:
				default:
				}
			})
		})
		done <- outcome{result, err}
	}()
	ticker := time.NewTicker(12 * time.Second)
	defer ticker.Stop()
	var result any
	var err error
loop:
	for {
		select {
		case <-clientDone:
			if !detach {
				cancel()
			}
			return nil
		case <-ctx.Done():
			return nil
		case value := <-updates:
			if !emit("progress", value) {
				return nil
			}
		case <-ticker.C:
			if !emit("progress", Object{"stage": "waiting"}) {
				return nil
			}
		case end := <-done:
			result, err = end.result, end.err
			for len(updates) > 0 {
				if !emit("progress", <-updates) {
					return nil
				}
			}
			break loop
		}
	}
	if err != nil {
		message := "分析未完成，请检查连接后重试"
		status := 502
		var f failure
		if e, ok := err.(failure); ok {
			f = e
			message = fmt.Sprint(f.Detail)
			status = f.Status
		}
		emit("error", Object{"message": message, "status": status})
	} else {
		emit("result", result)
	}
	cancel()
	return nil
}
