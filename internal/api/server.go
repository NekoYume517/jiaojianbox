// Package api owns the shared HTTP contract for the desktop and cloud service.
package api

import (
	"compress/gzip"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/NekoYume517/jiaojianbox/internal/store"
)

type Object = store.Object
type failure struct {
	Status int
	Detail any
}

func (e failure) Error() string   { return fmt.Sprint(e.Detail) }
func fail(status int, detail any) { panic(failure{status, detail}) }
func check(err error) {
	if err != nil {
		panic(err)
	}
}
func attempt(fn func() any) (result any, err error) {
	defer func() {
		if p := recover(); p != nil {
			if e, ok := p.(error); ok {
				err = e
			} else {
				err = fmt.Errorf("request failed")
			}
		}
	}()
	return fn(), nil
}
func object(value any) Object {
	if v, ok := value.(map[string]any); ok && v != nil {
		return v
	}
	return Object{}
}
func str(o Object, k string) string   { return store.Str(o, k) }
func num(o Object, k string) float64  { return store.Number(o, k) }
func boolean(o Object, k string) bool { return store.Bool(o, k) }
func list(o Object, k string) []any   { return store.List(o, k) }
func fallback(value, other string) string {
	if value == "" {
		return other
	}
	return value
}
func env(key, value string) string { return fallback(os.Getenv(key), value) }
func fmtValue(value any) string {
	if value == nil {
		return ""
	}
	return fmt.Sprint(value)
}
func decodeObject(text string) Object {
	var out Object
	check(json.Unmarshal([]byte(text), &out))
	if out == nil {
		fail(502, "模型未返回有效对象")
	}
	return out
}
func first[T any](a []T) (z T) {
	if len(a) > 0 {
		return a[0]
	}
	return
}
func query(ctx context.Context, db store.SQL, q string, args ...any) []Object {
	r, e := store.Query(ctx, db, q, args...)
	check(e)
	return r
}
func one(ctx context.Context, db store.SQL, q string, args ...any) Object {
	v, err := store.One(ctx, db, q, args...)
	if errors.Is(err, sql.ErrNoRows) {
		fail(404, "内容不存在")
	}
	check(err)
	return v
}
func exec(ctx context.Context, db store.SQL, q string, args ...any) sql.Result {
	r, e := db.ExecContext(ctx, q, args...)
	check(e)
	return r
}
func changed(result sql.Result) int64 { n, e := result.RowsAffected(); check(e); return n }
func clip(s string, limit int) string {
	r := []rune(s)
	if len(r) > limit {
		return string(r[:limit])
	}
	return s
}
func choice(value string, allowed ...string) bool {
	for _, s := range allowed {
		if value == s {
			return true
		}
	}
	return false
}

type Server struct {
	Store        *store.Store
	Mux          *http.ServeMux
	Assets       fs.FS
	cancel       context.CancelFunc
	workers      sync.WaitGroup
	limits       sync.Map
	analysis     sync.Map
	sessionTurns sync.Map
	runCancels   sync.Map
	MaxUpload    int64
	Version      string
}
type request struct {
	*http.Request
	W    http.ResponseWriter
	S    *Server
	User string
}

func (r request) body() Object {
	defer r.Body.Close()
	dec := json.NewDecoder(http.MaxBytesReader(r.W, r.Body, 20<<20))
	var value Object
	if dec.Decode(&value) != nil || value == nil {
		fail(422, "请求内容必须是有效 JSON 对象")
	}
	if dec.Decode(new(any)) != io.EOF {
		fail(422, "请求内容无效")
	}
	return value
}
func (r request) integer(key string, def, min, max int) int {
	value := r.URL.Query().Get(key)
	if value == "" {
		return def
	}
	n, e := strconv.Atoi(value)
	if e != nil || n < min || n > max {
		fail(422, "参数范围无效："+key)
	}
	return n
}
func (s *Server) transaction(ctx context.Context, fn func(store.SQL) any) any {
	var value any
	check(s.Store.Tx(ctx, func(tx *sql.Tx) error { value = fn(tx); return nil }))
	return value
}
func event(ctx context.Context, db store.SQL, user, kind, id string) {
	check(store.Event(ctx, db, user, kind, id))
	if kind == "task.upsert" {
		row := first(query(ctx, db, "SELECT version FROM tasks WHERE id=? AND user_id=?", id, user))
		if row != nil && num(row, "version") == 1 && len(query(ctx, db, "SELECT seq FROM events WHERE user_id=? AND kind='task.created' AND entity_id=? LIMIT 1", user, id)) == 0 {
			event(ctx, db, user, "task.created", id)
		}
	}
}

func New(database *store.Store, assets fs.FS, version string) (*Server, error) {
	if err := database.BackupVersion(context.Background(), version); err != nil {
		log.Printf("升级备份失败，继续使用已通过完整性检查的工作区: %v", err)
	}
	s := &Server{Store: database, Assets: assets, Version: version, Mux: http.NewServeMux(), MaxUpload: 50 << 20}
	if n, e := strconv.Atoi(os.Getenv("JJB_MAX_UPLOAD_MB")); e == nil && n > 0 {
		s.MaxUpload = int64(n) << 20
	}
	_, err := attempt(func() any {
		s.bootstrap()
		s.authRoutes()
		s.messageRoutes()
		s.taskRoutes()
		s.reminderRoutes()
		s.fileRoutes()
		s.aiRoutes()
		s.digestRoutes()
		s.aiCreditRoutes()
		s.accountRoutes()
		s.transferRoutes()
		s.statisticsRoutes()
		s.shareRoutes()
		s.templateRoutes()
		s.recycleRoutes()
		s.searchRoutes()
		s.previewRoutes()
		s.collectionStatusRoutes()
		s.agentRoutes()
		s.route("GET /health", "", func(r request) any { return Object{"status": "ok", "version": s.Version, "runtime": "go"} })
		s.Mux.HandleFunc("GET /authorize", func(w http.ResponseWriter, r *http.Request) {
			asset, err := s.Assets.Open("authorize.html")
			if err != nil {
				http.NotFound(w, r)
				return
			}
			defer asset.Close()
			stat, err := asset.Stat()
			if err != nil {
				http.NotFound(w, r)
				return
			}
			http.ServeContent(w, r, "authorize.html", stat.ModTime(), asset.(io.ReadSeeker))
		})
		s.Mux.HandleFunc("GET /s/{token}", func(w http.ResponseWriter, r *http.Request) {
			asset, err := s.Assets.Open("share.html")
			if err != nil {
				http.NotFound(w, r)
				return
			}
			defer asset.Close()
			stat, err := asset.Stat()
			if err != nil {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Cache-Control", "no-store")
			http.ServeContent(w, r, "share.html", stat.ModTime(), asset.(io.ReadSeeker))
		})
		s.Mux.Handle("GET /", http.FileServerFS(s.Assets))
		exec(context.Background(), s.Store.DB, "UPDATE analysis_jobs SET state='queued' WHERE state='running'")
		s.transaction(context.Background(), func(db store.SQL) any {
			ctx := context.Background()
			if first(query(ctx, db, "SELECT key FROM site_settings WHERE key='migration.agent-full-default-v1'")) == nil {
				exec(ctx, db, "UPDATE agent_sessions SET permission='full'")
				exec(ctx, db, "UPDATE agent_state SET permission='full'")
				exec(ctx, db, "INSERT INTO site_settings(key,value) VALUES('migration.agent-full-default-v1','done')")
			}
			return nil
		})
		exec(context.Background(), s.Store.DB, "UPDATE agent_runs SET state='interrupted' WHERE state IN ('queued','running')")
		exec(context.Background(), s.Store.DB, "UPDATE agent_runs SET state='queued' WHERE source_message_id IN (SELECT message_id FROM analysis_jobs WHERE state='queued') AND state IN ('interrupted','cancelled')")
		s.purgeExpiredRecycle(context.Background(), s.Store.DB, "")
		return nil
	})
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.cancel = cancel
	s.startWorker(ctx, "analysis", s.analyzeWorker)
	s.startWorker(ctx, "triage", s.triageWorker)
	s.startWorker(ctx, "recycle", s.recycleWorker)
	return s, nil
}
func (s *Server) startWorker(ctx context.Context, name string, run func(context.Context)) {
	s.workers.Add(1)
	go func() {
		defer s.workers.Done()
		for ctx.Err() == nil {
			panicked := false
			func() {
				defer func() {
					if recovered := recover(); recovered != nil {
						panicked = true
						log.Printf("%s worker panic: %v\n%s", name, recovered, debug.Stack())
					}
				}()
				run(ctx)
			}()
			if ctx.Err() != nil {
				return
			}
			if !panicked {
				log.Printf("%s worker exited unexpectedly; restarting", name)
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(time.Second):
			}
		}
	}()
}
func (s *Server) Close() {
	if s.cancel != nil {
		s.cancel()
	}
	s.workers.Wait()
}
func (s *Server) route(pattern, access string, fn func(request) any) {
	s.Mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
		value, err := attempt(func() any {
			user := ""
			if access != "" {
				user = s.owner(r.Context(), r.Header.Get("Authorization"))
				if access == "admin" && !s.isAdmin(r.Context(), s.Store.DB, user) {
					fail(403, "仅管理员可操作")
				}
			}
			return fn(request{r, w, s, user})
		})
		if err != nil {
			status := 500
			detail := any("操作未完成，请重试")
			var f failure
			if errors.As(err, &f) {
				status = f.Status
				detail = f.Detail
			} else {
				log.Printf("request failed: %s %s: %v", r.Method, r.URL.Path, err)
			}
			writeJSON(w, status, Object{"detail": detail})
			return
		}
		if value != nil {
			status := 200
			if r.Method == "POST" && (r.URL.Path == "/api/auth/register" || r.URL.Path == "/api/messages" || r.URL.Path == "/api/tasks" || r.URL.Path == "/api/shelf" || r.URL.Path == "/api/admin/invitations" || strings.HasSuffix(r.URL.Path, "/files")) {
				status = 201
			}
			writeJSON(w, status, value)
		}
	})
}
func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(value)
}

func (s *Server) allowedOrigin(r *http.Request, origin string) bool {
	if origin == "" {
		return false
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return false
	}
	if strings.EqualFold(parsed.Host, r.Host) || strings.EqualFold(parsed.Host, "wails.localhost") {
		return true
	}
	requestHost := r.Host
	if host, _, err := net.SplitHostPort(r.Host); err == nil {
		requestHost = strings.Trim(host, "[]")
	}
	originHost := parsed.Hostname()
	originIP := net.ParseIP(originHost)
	requestIP := net.ParseIP(requestHost)
	if strings.EqualFold(originHost, requestHost) &&
		(strings.EqualFold(originHost, "localhost") || originIP != nil && originIP.IsLoopback()) &&
		(requestIP == nil || requestIP.IsLoopback() || strings.EqualFold(requestHost, "localhost")) {
		// Desktop development and native Wails can bridge through a separate
		// loopback port. A public hostname still requires an exact env entry.
		return true
	}
	if public, err := url.Parse(env("JJB_PUBLIC_URL", "")); err == nil && public.Host != "" && strings.EqualFold(parsed.Host, public.Host) {
		return true
	}
	for _, allowed := range strings.Split(env("JJB_ALLOWED_ORIGINS", ""), ",") {
		candidate, err := url.Parse(strings.TrimSpace(allowed))
		if err == nil && candidate.Scheme != "" && strings.EqualFold(candidate.Scheme+"://"+candidate.Host, origin) {
			return true
		}
	}
	return false
}

func staticCacheControl(name string) string {
	if name == "" || strings.HasSuffix(name, "/") {
		return "no-cache"
	}
	switch strings.ToLower(path.Ext(name)) {
	case ".html":
		return "no-cache"
	case ".woff", ".woff2", ".ttf":
		return "public, max-age=31536000, immutable"
	default:
		return "public, max-age=300, must-revalidate"
	}
}

func gzipEligible(r *http.Request) bool {
	if r.Method != http.MethodGet || r.Header.Get("Range") != "" || !strings.Contains(strings.ToLower(r.Header.Get("Accept-Encoding")), "gzip") {
		return false
	}
	if r.URL.Path == "" || strings.HasSuffix(r.URL.Path, "/") {
		return true
	}
	switch strings.ToLower(path.Ext(r.URL.Path)) {
	case ".html", ".css", ".js", ".mjs", ".json", ".svg", ".txt", ".xml":
		return true
	default:
		return false
	}
}

type gzipResponseWriter struct {
	http.ResponseWriter
	writer *gzip.Writer
}

func (w *gzipResponseWriter) WriteHeader(status int) {
	w.Header().Del("Content-Length")
	w.ResponseWriter.WriteHeader(status)
}

func (w *gzipResponseWriter) Write(data []byte) (int, error) {
	w.Header().Del("Content-Length")
	return w.writer.Write(data)
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "same-origin")
	w.Header().Set("X-Frame-Options", "SAMEORIGIN")
	apiRequest := strings.HasPrefix(r.URL.Path, "/api/")
	if apiRequest {
		w.Header().Set("Cache-Control", "no-store")
		origin := r.Header.Get("Origin")
		if origin != "" && !s.allowedOrigin(r, origin) {
			http.Error(w, "origin not allowed", http.StatusForbidden)
			return
		}
		if origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Add("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		}
	} else if r.Method == http.MethodGet || r.Method == http.MethodHead {
		w.Header().Set("Cache-Control", staticCacheControl(r.URL.Path))
	}
	if r.Method == "OPTIONS" {
		w.WriteHeader(204)
		return
	}
	throttled := choice(r.URL.Path, "/api/auth/login", "/api/auth/register", "/api/auth/device/start", "/api/auth/forgot-password", "/api/auth/mail/confirm", "/api/account/email") || strings.HasPrefix(r.URL.Path, "/api/shared/")
	if r.Method == "POST" && throttled && !s.allowAuth(r.RemoteAddr) {
		writeJSON(w, 429, Object{"detail": "操作过于频繁，请稍后再试"})
		return
	}
	if apiRequest {
		s.Mux.ServeHTTP(w, r)
		return
	}
	if strings.HasSuffix(r.URL.Path, ".go") {
		http.NotFound(w, r)
		return
	}
	if gzipEligible(r) {
		w.Header().Set("Vary", "Accept-Encoding")
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Del("Content-Length")
		compressed := &gzipResponseWriter{ResponseWriter: w, writer: gzip.NewWriter(w)}
		s.Mux.ServeHTTP(compressed, r)
		_ = compressed.writer.Close()
		return
	}
	s.Mux.ServeHTTP(w, r)
}

type limit struct {
	mu      sync.Mutex
	entries []time.Time
}

func (s *Server) allowAuth(address string) bool {
	host, _, _ := net.SplitHostPort(address)
	value, _ := s.limits.LoadOrStore(host, &limit{})
	l := value.(*limit)
	l.mu.Lock()
	defer l.mu.Unlock()
	cut := time.Now().Add(-time.Minute)
	i := 0
	for i < len(l.entries) && l.entries[i].Before(cut) {
		i++
	}
	l.entries = l.entries[i:]
	if len(l.entries) >= 30 {
		return false
	}
	l.entries = append(l.entries, time.Now())
	return true
}
