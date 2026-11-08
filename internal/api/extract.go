package api

import (
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var zone = time.FixedZone("Asia/Shanghai", 8*3600)
var extensionPattern = regexp.MustCompile(`^[a-zA-Z0-9]{1,10}$`)
var extensionsInText = regexp.MustCompile(`(?i)\b(pdf|docx?|xlsx?|pptx?|zip|rar|7z|py|cpp)\b`)
var sizeInText = regexp.MustCompile(`(?i)(?:不超过|小于|上限|≤|<)\s*(\d+(?:\.\d+)?)\s*(MB|GB|KB|M|G|K)`)
var nameInText = regexp.MustCompile("(?:文件名|命名)(?:称)?\\s*(?:为|是|[:：])?\\s*[“\"「]?([^\\n。；;”\"」]{2,60})")
var urlInText = regexp.MustCompile("https?://[^\\s<>\"，。；）)]+")
var dateInText = regexp.MustCompile(`(?:(\d{4})[-年/])?(\d{1,2})[-月/](\d{1,2})日?`)
var dayInText = regexp.MustCompile(`今天|明天|后天`)
var weekdayInText = regexp.MustCompile(`(下周|本周|这周|周|星期)([一二三四五六日天])`)
var clockInText = regexp.MustCompile(`(?:(上午|下午|晚上|中午)\s*)?(\d{1,2})[:：点时](\d{1,2})?`)
var candidateInText = regexp.MustCompile(`提交|截止|报名|交作业|上交|交齐|交材料|报告`)

func draftTitle(text string) string {
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || (len([]rune(line)) <= 16 && (strings.HasSuffix(line, "：") || strings.HasSuffix(line, ":"))) {
			continue
		}
		return clip(line, 100)
	}
	return "新建待办"
}
func extract(text string, sent time.Time) Object {
	base := sent.In(zone)
	requirements := []any{}
	seen := map[string]bool{}
	for _, value := range extensionsInText.FindAllString(text, -1) {
		value = strings.ToLower(value)
		if !seen[value] {
			requirements = append(requirements, Object{"label": strings.ToUpper(value) + " 文件", "extensions": []any{value}, "min_count": 1})
			seen[value] = true
		}
	}
	var size any
	if match := sizeInText.FindStringSubmatch(text); match != nil {
		n, _ := strconv.ParseFloat(match[1], 64)
		factor := map[byte]float64{'k': 1024, 'm': 1024 * 1024, 'g': 1024 * 1024 * 1024}[strings.ToLower(match[2])[0]]
		size = int64(n * factor)
	}
	naming := ""
	if match := nameInText.FindStringSubmatch(text); match != nil {
		naming = strings.TrimSpace(match[1])
	}
	url := first(urlInText.FindAllString(text, -1))
	notes := []any{"规则提取草稿，请核对截止时间、材料数量和命名要求。"}
	var due any
	var target time.Time
	if match := dateInText.FindStringSubmatch(text); match != nil {
		year := base.Year()
		if match[1] != "" {
			year, _ = strconv.Atoi(match[1])
		}
		month, _ := strconv.Atoi(match[2])
		day, _ := strconv.Atoi(match[3])
		target = time.Date(year, time.Month(month), day, 0, 0, 0, 0, zone)
		if int(target.Month()) != month || target.Day() != day {
			target = time.Time{}
			notes = append(notes, "日期无效，请手动填写。")
		}
	} else if match := dayInText.FindString(text); match != "" {
		target = base.AddDate(0, 0, map[string]int{"今天": 0, "明天": 1, "后天": 2}[match])
	} else if match := weekdayInText.FindStringSubmatch(text); match != nil {
		day := strings.Index("一二三四五六日", strings.ReplaceAll(match[2], "天", "日")) / 3
		today := (int(base.Weekday()) + 6) % 7
		offset := day - today
		if match[1] == "下周" {
			offset += 7
		} else if choice(match[1], "周", "星期") && offset < 0 {
			offset += 7
		}
		target = base.AddDate(0, 0, offset)
		notes = append(notes, "星期按通知发送日期推算，请确认。")
	}
	if !target.IsZero() {
		hour, minute := 23, 59
		if match := clockInText.FindStringSubmatch(text); match != nil {
			hour, _ = strconv.Atoi(match[2])
			minute, _ = strconv.Atoi(match[3])
			if choice(match[1], "下午", "晚上") && hour < 12 {
				hour += 12
			}
		} else {
			notes = append(notes, "未注明具体时刻，暂填当天 23:59，请确认。")
		}
		if hour >= 0 && hour < 24 && minute >= 0 && minute < 60 {
			due = time.Date(target.Year(), target.Month(), target.Day(), hour, minute, 0, 0, zone).Format(time.RFC3339)
		}
	}
	return Object{"title": draftTitle(text), "description": text, "due_at": due, "requirements": requirements, "max_total_bytes": size, "naming_hint": naming, "submit_url": url, "notes": notes, "candidate": candidateInText.MatchString(text)}
}

func iso(value any) any {
	valueString, ok := value.(string)
	if !ok || strings.TrimSpace(valueString) == "" {
		return nil
	}
	valueString = strings.TrimSpace(valueString)
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05", "2006-01-02 15:04:05", "2006-01-02T15:04", "2006-01-02"} {
		parsed, err := time.ParseInLocation(layout, valueString, zone)
		if err == nil {
			return parsed.Format(time.RFC3339Nano)
		}
	}
	return nil
}
func confidence(value any) float64 {
	text := strings.TrimSpace(fmtValue(value))
	percent := strings.HasSuffix(text, "%") || strings.HasSuffix(text, "％")
	n, err := strconv.ParseFloat(strings.TrimRight(text, "%％"), 64)
	if err != nil || math.IsNaN(n) || math.IsInf(n, 0) {
		return .5
	}
	if percent || (n > 1 && n <= 100) {
		n /= 100
	}
	return math.Max(0, math.Min(1, n))
}
