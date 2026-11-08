package gui

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/NekoYume517/jiaojianbox/internal/store"
	"github.com/coder/websocket"
)

var readActions = map[string]bool{"get_login_info": true, "get_group_list": true, "get_friend_list": true, "get_group_msg_history": true, "get_friend_msg_history": true, "get_msg": true, "get_status": true, "get_version_info": true}

type snowManager struct {
	d                               *Desktop
	mu, startMu, writeMu, gatewayMu sync.Mutex
	cmd                             *exec.Cmd
	stdin                           io.WriteCloser
	ready                           chan struct{}
	readyOnce                       sync.Once
	pending                         map[string]chan Object
	gateways                        map[string]*gateway
	runtime, version                string
	logs                            []Object
}
type gateway struct {
	server  *http.Server
	config  Object
	mu      sync.Mutex
	clients map[*websocket.Conn]bool
}

func newSnowManager(d *Desktop) *snowManager {
	return &snowManager{d: d, pending: map[string]chan Object{}, gateways: map[string]*gateway{}}
}
func (s *snowManager) locate(preferred string) (string, error) {
	paths := []string{preferred, filepath.Join(s.d.resources, "runtime", "snowluma"), filepath.Join(s.d.resources, "runtime-vendor", "snowluma"), os.Getenv("JJB_SNOWLUMA_HOME")}
	for _, path := range paths {
		if path == "" {
			continue
		}
		data, err := os.ReadFile(filepath.Join(path, "package.json"))
		if err != nil {
			continue
		}
		var pkg Object
		if json.Unmarshal(data, &pkg) == nil && getString(pkg, "name") == "@snowluma/runtime" {
			s.mu.Lock()
			s.runtime = path
			s.version = getString(pkg, "version")
			s.mu.Unlock()
			return path, nil
		}
	}
	return "", errors.New("未找到内置 QQ 采集组件，可重新安装完整版本或在高级设置中选择目录")
}
func (s *snowManager) consentInfo(preferred string) (Object, error) {
	s.startMu.Lock()
	defer s.startMu.Unlock()
	root, err := s.locate(preferred)
	if err != nil {
		return nil, err
	}
	hash := sha256.New()
	out := Object{}
	for _, item := range []struct{ key, file string }{{"eula", "EULA.md"}, {"privacy", "PRIVACY.md"}} {
		data, err := os.ReadFile(filepath.Join(root, item.file))
		if err != nil {
			return nil, err
		}
		hash.Write([]byte(item.key + "\x00"))
		hash.Write(data)
		hash.Write([]byte{0})
		out[item.key] = string(data)
	}
	out["version"] = hex.EncodeToString(hash.Sum(nil))[:16]
	return out, nil
}
func (s *snowManager) acceptConsent(preferred string) (any, error) {
	info, err := s.consentInfo(preferred)
	if err != nil {
		return nil, err
	}
	dir := filepath.Join(s.d.root, "qq-runtime", "config")
	if err = os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	err = os.WriteFile(filepath.Join(dir, "consent.json"), []byte(asJSON(Object{"version": info["version"], "acceptedAt": time.Now().Format(time.RFC3339Nano)})), 0600)
	return Object{"accepted": err == nil}, err
}
func (s *snowManager) start(preferred string) error {
	s.startMu.Lock()
	defer s.startMu.Unlock()
	s.mu.Lock()
	if s.cmd != nil {
		ready := s.ready
		s.mu.Unlock()
		select {
		case <-ready:
			return nil
		case <-time.After(30 * time.Second):
			return errors.New("QQ 组件启动超时")
		}
	}
	s.mu.Unlock()
	root, err := s.locate(preferred)
	if err != nil {
		return err
	}
	hash := sha256.New()
	for _, item := range []struct{ key, file string }{{"eula", "EULA.md"}, {"privacy", "PRIVACY.md"}} {
		data, err := os.ReadFile(filepath.Join(root, item.file))
		if err != nil {
			return err
		}
		hash.Write([]byte(item.key + "\x00"))
		hash.Write(data)
		hash.Write([]byte{0})
	}
	fingerprint := hex.EncodeToString(hash.Sum(nil))[:16]
	working := filepath.Join(s.d.root, "qq-runtime")
	accepted := false
	for _, file := range []string{filepath.Join(working, "config", "consent.json"), filepath.Join(root, "config", "consent.json")} {
		data, err := os.ReadFile(file)
		var record Object
		if err == nil && json.Unmarshal(data, &record) == nil && record["version"] == fingerprint {
			accepted = true
		}
	}
	if !accepted {
		return errors.New("CONSENT_REQUIRED：启用 QQ 采集前，请阅读并同意组件协议")
	}
	if err = os.MkdirAll(filepath.Join(working, "config"), 0700); err != nil {
		return err
	}
	if err = os.WriteFile(filepath.Join(working, "config", "runtime.json"), []byte(`{"hookAutoLoad":false,"webuiHost":"127.0.0.1"}`), 0600); err != nil {
		return err
	}
	node := filepath.Join(root, "node.exe")
	if runtime.GOOS != "windows" {
		node = "node"
	}
	loader := fileURL(s.d.bridge("snow-loader.mjs"))
	bridge := fileURL(s.d.bridge("snow-bridge.mjs"))
	cmd := exec.CommandContext(s.d.ctx, node, "--experimental-loader", loader, filepath.Join(root, "index.mjs"))
	hideProcess(cmd)
	cmd.Dir = working
	cmd.Env = append(os.Environ(), "JJB_MANAGED_SNOW=1", "JJB_SNOW_STDIO=1", "JJB_SNOW_ENTRY="+filepath.Join(root, "index.mjs"), "JJB_SNOW_BRIDGE="+bridge, "SNOWLUMA_UPDATE_ROOT="+root)
	cmd.Stderr = io.Discard
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err = cmd.Start(); err != nil {
		return err
	}
	s.mu.Lock()
	s.cmd = cmd
	s.stdin = stdin
	s.ready = make(chan struct{})
	s.readyOnce = sync.Once{}
	ready := s.ready
	s.mu.Unlock()
	s.record("starting", "正在启动 QQ 采集组件")
	go func() {
		scanEvents(stdout, s.receive)
		cmd.Wait()
		s.mu.Lock()
		if s.cmd == cmd {
			s.cmd = nil
		}
		for id, ch := range s.pending {
			select {
			case ch <- Object{"ok": false, "error": "QQ 采集组件已断开"}:
			default:
			}
			delete(s.pending, id)
		}
		s.mu.Unlock()
		s.record("error", "QQ 采集组件已退出，可重新检测恢复")
	}()
	select {
	case <-ready:
		s.record("connected", "QQ 采集组件已就绪")
		return nil
	case <-time.After(30 * time.Second):
		cmd.Process.Kill()
		return errors.New("QQ 采集组件启动超时")
	}
}
func (s *snowManager) receive(value Object) {
	s.mu.Lock()
	switch getString(value, "kind") {
	case "ready":
		s.readyOnce.Do(func() { close(s.ready) })
		s.mu.Unlock()
		return
	case "reply":
		ch := s.pending[getString(value, "id")]
		delete(s.pending, getString(value, "id"))
		s.mu.Unlock()
		if ch != nil {
			ch <- value
		}
		return
	case "event":
		g := s.gateways[identity(value["uin"])]
		s.mu.Unlock()
		if g != nil {
			g.mu.Lock()
			clients := []*websocket.Conn{}
			for c := range g.clients {
				clients = append(clients, c)
			}
			g.mu.Unlock()
			for _, c := range clients {
				ctx, cancel := context.WithTimeout(context.Background(), time.Second)
				c.Write(ctx, websocket.MessageText, []byte(asJSON(value["event"])))
				cancel()
			}
		}
		return
	}
	s.mu.Unlock()
}
func (s *snowManager) record(state, message string) {
	entry := Object{"state": state, "message": message, "at": time.Now().Format(time.RFC3339Nano), "source": "qq"}
	s.mu.Lock()
	s.logs = append(s.logs, entry)
	if len(s.logs) > 80 {
		s.logs = s.logs[len(s.logs)-80:]
	}
	s.mu.Unlock()
	s.d.publish(entry)
}
func (s *snowManager) call(method string, params Object) (any, error) {
	s.mu.Lock()
	if s.cmd == nil {
		s.mu.Unlock()
		return nil, errors.New("QQ 采集组件未连接")
	}
	id := store.ID()
	ch := make(chan Object, 1)
	s.pending[id] = ch
	stdin := s.stdin
	s.mu.Unlock()
	request := getObjectCopy(params)
	request["id"] = id
	request["method"] = method
	s.writeMu.Lock()
	_, err := io.WriteString(stdin, asJSON(request)+"\n")
	s.writeMu.Unlock()
	if err != nil {
		return nil, err
	}
	defer func() { s.mu.Lock(); delete(s.pending, id); s.mu.Unlock() }()
	select {
	case reply := <-ch:
		if !store.Bool(reply, "ok") {
			return nil, errors.New(getString(reply, "error"))
		}
		return reply["data"], nil
	case <-time.After(60 * time.Second):
		return nil, errors.New("QQ 读取超时，请稍后重试")
	}
}
func (s *snowManager) discover(preferred string) (any, error) {
	if err := s.start(preferred); err != nil {
		return nil, err
	}
	items, err := s.call("processes", Object{})
	if err != nil {
		return nil, err
	}
	return Object{"version": s.version, "instances": items}, nil
}
func (s *snowManager) connect(config Object) (any, error) {
	if err := s.start(getString(config, "home")); err != nil {
		return nil, err
	}
	data, err := s.call("attach", Object{"pid": config["pid"]})
	if err != nil {
		return nil, err
	}
	account := getObject(data)
	uin := identity(account["uin"])
	if _, err = s.gateway(uin); err != nil {
		return nil, err
	}
	contacts, err := s.contacts(uin)
	if err != nil {
		return nil, err
	}
	out := getObject(contacts)
	for k, v := range account {
		out[k] = v
	}
	return out, nil
}
func (s *snowManager) contacts(uin string) (any, error) {
	conversations := []Object{}
	for _, entry := range []struct{ action, prefix, id, name string }{{"get_group_list", "group:", "group_id", "group_name"}, {"get_friend_list", "private:", "user_id", "nickname"}} {
		data, err := s.call("action", Object{"uin": uin, "action": entry.action, "params": Object{}})
		if err != nil {
			return nil, err
		}
		result := getObject(data)
		if store.Number(result, "retcode") != 0 {
			return nil, errors.New("QQ 联系人暂不可读取")
		}
		list, _ := result["data"].([]any)
		for _, value := range list {
			o := getObject(value)
			id := identity(o[entry.id])
			name := getString(o, entry.name)
			if remark := getString(o, "remark"); remark != "" {
				name = remark
			}
			if name == "" {
				name = id
			}
			conversations = append(conversations, Object{"id": entry.prefix + id, "name": name, "source": "qq"})
		}
	}
	return Object{"account": uin, "conversations": conversations}, nil
}
func (s *snowManager) debug(config Object) (any, error) {
	action := getString(config, "action")
	if !readActions[action] {
		return nil, errors.New("高级调试仅支持读取动作")
	}
	return s.call("action", Object{"uin": config["uin"], "action": action, "params": config["params"]})
}
func (s *snowManager) gateway(uin string) (Object, error) {
	s.gatewayMu.Lock()
	defer s.gatewayMu.Unlock()
	s.mu.Lock()
	existing := s.gateways[uin]
	s.mu.Unlock()
	if existing != nil {
		return existing.config, nil
	}
	token := store.Token()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	g := &gateway{clients: map[*websocket.Conn]bool{}, config: Object{"qq_account": uin, "qq_http_url": "http://" + listener.Addr().String(), "qq_ws_url": "ws://" + listener.Addr().String(), "qq_token": token}}
	g.server = &http.Server{ReadHeaderTimeout: 10 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+token {
			http.Error(w, "unauthorized", 401)
			return
		}
		if strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
			if err != nil {
				return
			}
			g.mu.Lock()
			g.clients[conn] = true
			g.mu.Unlock()
			defer func() { g.mu.Lock(); delete(g.clients, conn); g.mu.Unlock(); conn.CloseNow() }()
			for {
				if _, _, err = conn.Read(r.Context()); err != nil {
					return
				}
			}
		}
		action := strings.TrimPrefix(r.URL.Path, "/")
		if r.Method != "POST" || !readActions[action] {
			http.NotFound(w, r)
			return
		}
		var params Object
		if json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&params) != nil {
			http.Error(w, "bad request", 400)
			return
		}
		result, err := s.call("action", Object{"uin": uin, "action": action, "params": params})
		w.Header().Set("Content-Type", "application/json")
		if err != nil {
			w.WriteHeader(502)
			json.NewEncoder(w).Encode(Object{"retcode": -1, "message": "QQ 读取暂不可用"})
		} else {
			json.NewEncoder(w).Encode(result)
		}
	})}
	s.mu.Lock()
	s.gateways[uin] = g
	s.mu.Unlock()
	go g.server.Serve(listener)
	return g.config, nil
}
func (s *snowManager) prepare(config Object) (Object, error) {
	chats, _ := config["qq_chats"].([]any)
	if getString(config, "qq_transport") != "managed" || len(chats) == 0 {
		return config, nil
	}
	data, err := s.discover(getString(config, "snowluma_home"))
	if err != nil {
		return nil, err
	}
	instances, _ := getObject(data)["instances"].([]any)
	var pid any
	for _, item := range instances {
		o := getObject(item)
		if identity(o["uin"]) == getString(config, "qq_account") || store.Number(o, "pid") == store.Number(config, "qq_pid") {
			pid = o["pid"]
			break
		}
	}
	if pid == nil {
		return nil, errors.New("未找到上次选择的 QQ 实例，请重新选择")
	}
	account, err := s.connect(Object{"pid": pid, "home": config["snowluma_home"]})
	if err != nil {
		return nil, err
	}
	gateway, err := s.gateway(identity(getObject(account)["uin"]))
	if err != nil {
		return nil, err
	}
	out := getObjectCopy(config)
	for k, v := range gateway {
		out[k] = v
	}
	out["qq_pid"] = pid
	return out, nil
}
func (s *snowManager) diagnostics() Object {
	s.mu.Lock()
	defer s.mu.Unlock()
	accounts := []string{}
	for uin := range s.gateways {
		accounts = append(accounts, uin)
	}
	return Object{"ready": s.cmd != nil, "runtime": Object{"root": s.runtime, "version": s.version}, "connected_accounts": accounts, "logs": append([]Object(nil), s.logs...)}
}
func (s *snowManager) close() {
	s.mu.Lock()
	cmd := s.cmd
	s.cmd = nil
	gateways := s.gateways
	s.gateways = map[string]*gateway{}
	s.mu.Unlock()
	if cmd != nil && cmd.Process != nil {
		cmd.Process.Kill()
	}
	for _, g := range gateways {
		g.mu.Lock()
		for c := range g.clients {
			c.CloseNow()
		}
		g.mu.Unlock()
		g.server.Close()
	}
}

func identity(value any) string {
	if n, ok := value.(float64); ok {
		return strconv.FormatFloat(n, 'f', -1, 64)
	}
	if text, ok := value.(string); ok {
		return text
	}
	return ""
}
func fileURL(path string) string {
	path, _ = filepath.Abs(path)
	path = filepath.ToSlash(path)
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	return (&url.URL{Scheme: "file", Path: path}).String()
}
