package api

import (
	"context"
	"strings"
	"time"

	"github.com/NekoYume517/jiaojianbox/internal/store"
)

// aiServiceConfig is the site-wide managed ("免配置") AI service: users without
// their own API key run analysis through this upstream and pay with credits.
type aiServiceConfig struct {
	Enabled         bool
	DefaultCredits  float64
	TokensPerCredit float64
	CheckinEnabled  bool
	CheckinCredits  float64
	UpstreamURL     string
	UpstreamModel   string
	UpstreamKey     string
}

func defaultAIService() aiServiceConfig {
	return aiServiceConfig{DefaultCredits: 10, TokensPerCredit: 1000000, CheckinCredits: 1}
}

func (s *Server) aiService(ctx context.Context) aiServiceConfig {
	out := defaultAIService()
	row := first(query(ctx, s.Store.DB, "SELECT value AS payload FROM site_settings WHERE key='ai_service'"))
	if row == nil {
		return out
	}
	v := store.Payload(row)
	out.Enabled = boolean(v, "enabled")
	out.CheckinEnabled = boolean(v, "checkin_enabled")
	out.DefaultCredits = positiveOr(v, "default_credits", out.DefaultCredits)
	out.TokensPerCredit = positiveOr(v, "tokens_per_credit", out.TokensPerCredit)
	out.CheckinCredits = positiveOr(v, "checkin_credits", out.CheckinCredits)
	out.UpstreamURL = strings.TrimSpace(str(v, "upstream_url"))
	out.UpstreamModel = strings.TrimSpace(str(v, "upstream_model"))
	if secret := str(v, "upstream_key_encrypted"); secret != "" {
		key, err := s.Store.Decrypt(secret)
		check(err)
		out.UpstreamKey = key
	}
	return out
}

func positiveOr(v Object, key string, fallback float64) float64 {
	if value := num(v, key); value > 0 {
		return value
	}
	return fallback
}

// aiBalance lazily initialises the per-user credit balance and returns it.
func (s *Server) aiBalance(ctx context.Context, user string) (float64, aiServiceConfig) {
	svc := s.aiService(ctx)
	exec(ctx, s.Store.DB, "INSERT OR IGNORE INTO ai_credits(user_id,balance,updated_at) VALUES(?,?,?)", user, svc.DefaultCredits, store.Now())
	row := first(query(ctx, s.Store.DB, "SELECT balance FROM ai_credits WHERE user_id=?", user))
	return num(row, "balance"), svc
}

// aiSpend converts tokens into credits and deducts them from the balance.
func (s *Server) aiSpend(ctx context.Context, user string, tokens float64) {
	if tokens <= 0 {
		return
	}
	_, svc := s.aiBalance(ctx, user)
	per := svc.TokensPerCredit
	if per <= 0 {
		per = 1000000
	}
	exec(ctx, s.Store.DB, "UPDATE ai_credits SET balance=MAX(0,balance-?),updated_at=? WHERE user_id=?", tokens/per, store.Now(), user)
}

// resolveLLM returns the chat configuration for a user: their own endpoint when
// configured, otherwise the managed service when the admin enabled it.
func (s *Server) resolveLLM(ctx context.Context, user string) (Object, string) {
	config, key := s.llmConfig(ctx, user)
	if str(config, "base_url") != "" && str(config, "model") != "" {
		return config, key
	}
	svc := s.aiService(ctx)
	if !svc.Enabled || svc.UpstreamURL == "" || svc.UpstreamModel == "" || svc.UpstreamKey == "" {
		return config, key
	}
	balance, _ := s.aiBalance(ctx, user)
	if balance <= 0 {
		fail(402, "免配置 AI 积分已用完，可在统计页签到领取，或联系管理员调整额度")
	}
	managed := Object{}
	for k, v := range config {
		managed[k] = v
	}
	managed["base_url"] = svc.UpstreamURL
	managed["model"] = svc.UpstreamModel
	managed["managed"] = true
	return managed, svc.UpstreamKey
}

func (s *Server) aiCreditRoutes() {
	s.route("GET /api/ai/credit", "owner", func(r request) any {
		balance, svc := s.aiBalance(r.Context(), r.User)
		day := time.Now().In(zone).Format(time.DateOnly)
		checked := first(query(r.Context(), s.Store.DB, "SELECT 1 AS ok FROM ai_checkins WHERE user_id=? AND day=?", r.User, day)) != nil
		return Object{"enabled": svc.Enabled, "balance": balance, "tokens_per_credit": svc.TokensPerCredit, "checked_today": checked, "checkin_enabled": svc.CheckinEnabled, "checkin_credits": svc.CheckinCredits}
	})
	s.route("POST /api/ai/credit/checkin", "owner", func(r request) any {
		balance, svc := s.aiBalance(r.Context(), r.User)
		if !svc.Enabled {
			fail(404, "服务器未启用免配置 AI 服务")
		}
		if !svc.CheckinEnabled {
			fail(403, "服务器未开启每日签到")
		}
		day := time.Now().In(zone).Format(time.DateOnly)
		if first(query(r.Context(), s.Store.DB, "SELECT 1 AS ok FROM ai_checkins WHERE user_id=? AND day=?", r.User, day)) != nil {
			fail(409, "今天已经签到过了")
		}
		exec(r.Context(), s.Store.DB, "INSERT INTO ai_checkins(user_id,day,credits,at) VALUES(?,?,?,?)", r.User, day, svc.CheckinCredits, store.Now())
		exec(r.Context(), s.Store.DB, "UPDATE ai_credits SET balance=balance+?,updated_at=? WHERE user_id=?", svc.CheckinCredits, store.Now(), r.User)
		return Object{"balance": balance + svc.CheckinCredits, "credits": svc.CheckinCredits}
	})
	s.route("GET /api/admin/ai-service", "admin", func(r request) any {
		svc := s.aiService(r.Context())
		return Object{"enabled": svc.Enabled, "default_credits": svc.DefaultCredits, "tokens_per_credit": svc.TokensPerCredit, "checkin_enabled": svc.CheckinEnabled, "checkin_credits": svc.CheckinCredits, "upstream_url": svc.UpstreamURL, "upstream_model": svc.UpstreamModel, "has_key": svc.UpstreamKey != ""}
	})
	s.route("PUT /api/admin/ai-service", "admin", func(r request) any {
		b := r.body()
		svc := s.aiService(r.Context())
		for _, key := range []string{"enabled", "checkin_enabled"} {
			if b[key] == nil {
				continue
			}
			value, ok := b[key].(bool)
			if !ok {
				fail(422, "开关类型无效："+key)
			}
			if key == "enabled" {
				svc.Enabled = value
			} else {
				svc.CheckinEnabled = value
			}
		}
		for _, item := range []struct {
			key string
			max float64
		}{{"default_credits", 1000000}, {"tokens_per_credit", 1e12}, {"checkin_credits", 1000000}} {
			if b[item.key] == nil {
				continue
			}
			value := num(b, item.key)
			if value < 1 || value > item.max {
				fail(422, "积分数值无效："+item.key)
			}
			switch item.key {
			case "default_credits":
				svc.DefaultCredits = value
			case "tokens_per_credit":
				svc.TokensPerCredit = value
			case "checkin_credits":
				svc.CheckinCredits = value
			}
		}
		for _, key := range []string{"upstream_url", "upstream_model"} {
			if b[key] == nil {
				continue
			}
			value := strings.TrimSpace(str(b, key))
			if len(value) > 500 {
				fail(422, "配置内容过长："+key)
			}
			if key == "upstream_url" {
				svc.UpstreamURL = value
			} else {
				svc.UpstreamModel = value
			}
		}
		if b["upstream_key"] != nil {
			key := strings.TrimSpace(str(b, "upstream_key"))
			if len(key) > 2000 {
				fail(422, "API Key 过长")
			}
			svc.UpstreamKey = key
		}
		payload := Object{"enabled": svc.Enabled, "default_credits": svc.DefaultCredits, "tokens_per_credit": svc.TokensPerCredit, "checkin_enabled": svc.CheckinEnabled, "checkin_credits": svc.CheckinCredits, "upstream_url": svc.UpstreamURL, "upstream_model": svc.UpstreamModel}
		if svc.UpstreamKey != "" {
			encrypted, err := s.Store.Encrypt(svc.UpstreamKey)
			check(err)
			payload["upstream_key_encrypted"] = encrypted
		}
		exec(r.Context(), s.Store.DB, "INSERT OR REPLACE INTO site_settings VALUES('ai_service',?)", store.JSON(payload))
		return Object{"enabled": svc.Enabled, "default_credits": svc.DefaultCredits, "tokens_per_credit": svc.TokensPerCredit, "checkin_enabled": svc.CheckinEnabled, "checkin_credits": svc.CheckinCredits, "upstream_url": svc.UpstreamURL, "upstream_model": svc.UpstreamModel, "has_key": svc.UpstreamKey != ""}
	})
}
