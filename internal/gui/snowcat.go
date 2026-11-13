package gui

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/NekoYume517/jiaojianbox/internal/store"
)

// qqConnector keeps both QQ access implementations behind the same small
// surface so the collector and the UI never have to know which one is active.
type qqConnector interface {
	discover(string) (any, error)
	connect(Object) (any, error)
	contacts(string) (any, error)
	debug(Object) (any, error)
	prepare(Object) (Object, error)
	diagnostics() Object
	close()
}

type qqConsent interface {
	consentInfo(string) (Object, error)
	acceptConsent(string) (any, error)
}

type snowcatFileState struct {
	Existed bool   `json:"existed"`
	Backup  string `json:"backup,omitempty"`
	Source  string `json:"source,omitempty"`
	Hash    string `json:"hash,omitempty"`
}

type snowcatRecord struct {
	Home       string                      `json:"home"`
	QQVersion  string                      `json:"qq_version"`
	DeployedAt string                      `json:"deployed_at"`
	Files      map[string]snowcatFileState `json:"files"`
	HTTPPort   int                         `json:"http_port"`
	WSPort     int                         `json:"ws_port"`
	Token      string                      `json:"token"`
	ConfigDir  string                      `json:"config_dir"`
}

type snowcatManager struct {
	d                *Desktop
	mu, startMu      sync.Mutex
	runtime, version string
	home, qqVersion  string
	deployment       *snowcatRecord
	logs             []Object
	started          bool
}

func newSnowCatManager(d *Desktop) *snowcatManager {
	return &snowcatManager{d: d}
}

func (s *snowcatManager) record(state, message string) {
	entry := Object{"state": state, "message": message, "at": time.Now().Format(time.RFC3339Nano), "source": "qq", "connector": "snowcat"}
	s.mu.Lock()
	s.logs = append(s.logs, entry)
	if len(s.logs) > 80 {
		s.logs = s.logs[len(s.logs)-80:]
	}
	s.mu.Unlock()
	s.d.publish(entry)
}

func (s *snowcatManager) recordPath() string {
	return filepath.Join(s.d.root, "qq-snowcat", "deploy.json")
}

func (s *snowcatManager) backupDir() string {
	return filepath.Join(s.d.root, "qq-snowcat", "backup")
}

func (s *snowcatManager) consentPath() string {
	return filepath.Join(s.d.root, "qq-snowcat", "config", "consent.json")
}

func (s *snowcatManager) locateRuntime(preferred string) (string, error) {
	paths := []string{preferred, filepath.Join(s.d.resources, "runtime", "snowcat"), filepath.Join(s.d.resources, "runtime-vendor", "snowcat"), os.Getenv("JJB_SNOWCAT_HOME")}
	for _, root := range paths {
		if root == "" {
			continue
		}
		if _, err := os.Stat(filepath.Join(root, "napcat.mjs")); err == nil {
			if _, err = os.Stat(filepath.Join(root, "winmm-v8.dll")); err == nil {
				if _, err = os.Stat(filepath.Join(root, "snowcat-boot.js")); err == nil {
					s.mu.Lock()
					s.runtime = root
					s.version = snowcatRuntimeVersion(root)
					s.mu.Unlock()
					return root, nil
				}
			}
		}
	}
	return "", errors.New("未找到内置 SnowCat 运行时，可重新安装完整版本")
}

func snowcatRuntimeVersion(root string) string {
	// The bundled runtime keeps its upstream version in a file we ship with it.
	if data, err := os.ReadFile(filepath.Join(root, "version.txt")); err == nil {
		if value := strings.TrimSpace(string(data)); value != "" {
			return value
		}
	}
	return "4.18.28"
}

func (s *snowcatManager) locateQQ(preferred string) (string, string, error) {
	paths := []string{preferred, os.Getenv("JJB_QQ_HOME"), filepath.Join(os.Getenv("ProgramFiles"), "Tencent", "QQNT"), filepath.Join(os.Getenv("ProgramFiles(x86)"), "Tencent", "QQNT"), filepath.Join(os.Getenv("LOCALAPPDATA"), "Tencent", "QQ"), `D:\software\qq`}
	for _, home := range paths {
		if home == "" {
			continue
		}
		version, err := snowcatQQVersion(home)
		if err == nil {
			s.mu.Lock()
			s.home = home
			s.qqVersion = version
			s.mu.Unlock()
			return home, version, nil
		}
	}
	return "", "", errors.New("未找到 QQ 安装目录，请确认 QQ 已安装或在高级设置中指定目录")
}

func snowcatQQVersion(home string) (string, error) {
	versionDir := filepath.Join(home, "versions")
	entries, err := os.ReadDir(versionDir)
	if err != nil {
		return "", err
	}
	names := []string{}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		pkg := filepath.Join(versionDir, entry.Name(), "resources", "app", "package.json")
		if _, err := os.Stat(pkg); err == nil {
			names = append(names, entry.Name())
		}
	}
	if len(names) == 0 {
		return "", errors.New("QQ 版本目录中没有 resources/app/package.json")
	}
	sort.Slice(names, func(i, j int) bool {
		return compareQQVersion(names[i], names[j]) > 0
	})
	if _, err := os.Stat(filepath.Join(home, "QQ.exe")); err != nil {
		return "", errors.New("QQ 安装目录中缺少 QQ.exe")
	}
	return names[0], nil
}

func compareQQVersion(a, b string) int {
	as := strings.FieldsFunc(a, func(r rune) bool { return r == '.' || r == '-' })
	bs := strings.FieldsFunc(b, func(r rune) bool { return r == '.' || r == '-' })
	for i := 0; i < len(as) && i < len(bs); i++ {
		an, aerr := strconv.Atoi(as[i])
		bn, berr := strconv.Atoi(bs[i])
		if aerr == nil && berr == nil && an != bn {
			if an < bn {
				return -1
			}
			return 1
		}
	}
	return len(as) - len(bs)
}

func (s *snowcatManager) consentInfo(preferred string) (Object, error) {
	root, err := s.locateRuntime(preferred)
	if err != nil {
		return nil, err
	}
	hash := sha256.New()
	license, err := os.ReadFile(filepath.Join(root, "LICENSE"))
	if err != nil {
		return nil, err
	}
	hash.Write([]byte("snowcat\x00"))
	hash.Write(license)
	hash.Write([]byte{0})
	return Object{
		"eula":    string(license),
		"privacy": "SnowCat 仅在本机 QQ 进程内运行，消息与联系人数据不会离开当前电脑；切回 SnowLuma 或结束交件箱主进程时，交件箱会先请求 QQ 正常退出，再恢复其原有文件。",
		"version": hex.EncodeToString(hash.Sum(nil))[:16],
	}, nil
}

func (s *snowcatManager) acceptConsent(preferred string) (any, error) {
	info, err := s.consentInfo(preferred)
	if err != nil {
		return nil, err
	}
	if err = os.MkdirAll(filepath.Dir(s.consentPath()), 0700); err != nil {
		return nil, err
	}
	err = os.WriteFile(s.consentPath(), []byte(asJSON(Object{"version": info["version"], "acceptedAt": time.Now().Format(time.RFC3339Nano)})), 0600)
	return Object{"accepted": err == nil}, err
}

func (s *snowcatManager) consentAccepted() bool {
	data, err := os.ReadFile(s.consentPath())
	if err != nil {
		return false
	}
	var record Object
	return json.Unmarshal(data, &record) == nil && record["version"] != nil
}

func (s *snowcatManager) loadRecord() *snowcatRecord {
	data, err := os.ReadFile(s.recordPath())
	if err != nil {
		return nil
	}
	var record snowcatRecord
	if json.Unmarshal(data, &record) != nil {
		return nil
	}
	return &record
}

func (s *snowcatManager) saveRecord(record *snowcatRecord) error {
	if err := os.MkdirAll(filepath.Dir(s.recordPath()), 0700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(record, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.recordPath(), data, 0600)
}

func (s *snowcatManager) reservePort() (int, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	return port, nil
}

func (s *snowcatManager) backupFile(record *snowcatRecord, target, source string) error {
	key := filepath.ToSlash(target)
	existing := record.Files[key]
	if existing.Hash != "" {
		// Already recorded and backed up on an earlier deployment.
		return nil
	}
	hash := sha256.New()
	data, err := os.ReadFile(target)
	existed := err == nil
	if existed {
		hash.Write(data)
		existing = snowcatFileState{Existed: true, Hash: hex.EncodeToString(hash.Sum(nil)), Source: source}
		if err = os.MkdirAll(s.backupDir(), 0700); err != nil {
			return err
		}
		// Never derive a backup path directly from the absolute QQ file path:
		// on Windows a drive letter becomes an invalid colon inside a filename.
		targetDigest := sha256.Sum256([]byte(key))
		backupName := hex.EncodeToString(targetDigest[:8]) + "-" + filepath.Base(target) + "-" + strconv.FormatInt(time.Now().UnixNano(), 10) + ".bak"
		backup := filepath.Join(s.backupDir(), backupName)
		if err = os.WriteFile(backup, data, 0600); err != nil {
			return err
		}
		existing.Backup = backup
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	record.Files[key] = existing
	return nil
}

func (s *snowcatManager) deployFile(record *snowcatRecord, source, target string) error {
	if err := s.backupFile(record, target, source); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
		return err
	}
	data, err := os.ReadFile(source)
	if err != nil {
		return err
	}
	temp := target + ".jjb-tmp"
	if err = os.WriteFile(temp, data, 0644); err != nil {
		return err
	}
	return os.Rename(temp, target)
}

func (s *snowcatManager) appDir(home, version string) string {
	return filepath.Join(home, "versions", version, "resources", "app")
}

func (s *snowcatManager) deploy(preferred string) (*snowcatRecord, error) {
	root, err := s.locateRuntime(preferred)
	if err != nil {
		return nil, err
	}
	home, version, err := s.locateQQ(getString(s.lastConfig(), "snowcat_qq_home"))
	if err != nil {
		return nil, err
	}
	if !s.consentAccepted() {
		return nil, errors.New("CONSENT_REQUIRED：启用 SnowCat 前，请阅读并同意其许可协议")
	}
	s.startMu.Lock()
	defer s.startMu.Unlock()
	record := s.loadRecord()
	if record == nil || record.Home != home {
		record = &snowcatRecord{Home: home, QQVersion: version, Files: map[string]snowcatFileState{}}
	}
	record.Home = home
	record.QQVersion = version
	record.DeployedAt = time.Now().Format(time.RFC3339Nano)
	targets := []struct{ source, name string }{
		{filepath.Join(root, "napcat.mjs"), "napcat.mjs"},
		{filepath.Join(root, "snowcat-boot.js"), "snowcat-boot.js"},
		{filepath.Join(root, "winmm-v8.dll"), "winmm.dll"},
	}
	for _, item := range targets {
		if err = s.deployFile(record, item.source, filepath.Join(home, item.name)); err != nil {
			return nil, err
		}
	}
	// SnowCat's own launcher disables two broken debug DLLs in the app folder;
	// keep the same fix but always preserve the original files for restore.
	app := s.appDir(home, version)
	for _, name := range []string{"dbghelp.dll", "dbgeng.dll"} {
		original := filepath.Join(app, name)
		disabled := filepath.Join(app, name+".disabled")
		if _, statErr := os.Stat(original); statErr == nil {
			if err = s.backupFile(record, original, filepath.Join(root, name)); err != nil {
				return nil, err
			}
			if _, statErr = os.Stat(disabled); errors.Is(statErr, os.ErrNotExist) {
				if err = os.Rename(original, disabled); err != nil {
					return nil, err
				}
			}
		}
	}
	if record.HTTPPort == 0 || record.WSPort == 0 {
		httpPort, portErr := s.reservePort()
		if portErr != nil {
			return nil, portErr
		}
		wsPort, portErr := s.reservePort()
		if portErr != nil {
			return nil, portErr
		}
		record.HTTPPort = httpPort
		record.WSPort = wsPort
		record.Token = store.Token()
	}
	record.ConfigDir = filepath.Join(home, "config")
	for _, name := range []string{"onebot11.json", "webui.json"} {
		if err = s.backupFile(record, filepath.Join(record.ConfigDir, name), ""); err != nil {
			return nil, err
		}
	}
	if err = s.backupFile(record, filepath.Join(home, "nc-boot.log"), ""); err != nil {
		return nil, err
	}
	if err = s.writeConfig(record); err != nil {
		return nil, err
	}
	s.mu.Lock()
	s.deployment = record
	s.started = true
	s.mu.Unlock()
	if err = s.saveRecord(record); err != nil {
		return nil, err
	}
	s.record("connected", fmt.Sprintf("SnowCat 已部署到 %s（QQ %s），重启 QQ 后生效", home, version))
	return record, nil
}

func (s *snowcatManager) writeConfig(record *snowcatRecord) error {
	if err := os.MkdirAll(record.ConfigDir, 0755); err != nil {
		return err
	}
	onebot := Object{
		"network": Object{
			"httpServers":      []Object{{"name": "jjb-http", "protocol": "v11", "enable": true, "host": "127.0.0.1", "port": float64(record.HTTPPort), "enableCors": false, "enableWebsocket": false, "messagePostFormat": "array", "token": record.Token, "debug": false}},
			"httpSseServers":   []Object{},
			"httpClients":      []Object{},
			"websocketServers": []Object{{"name": "jjb-ws", "protocol": "v11", "enable": true, "host": "127.0.0.1", "port": float64(record.WSPort), "messagePostFormat": "array", "reportSelfMessage": false, "token": record.Token, "enableForcePushEvent": true, "debug": false, "heartInterval": 30000}},
			"websocketClients": []Object{},
			"mcpServers":       []Object{},
			"plugins":          []Object{},
		},
		"musicSignUrl":        "",
		"enableLocalFile2Url": false,
		"parseMultMsg":        false,
		"imageDownloadProxy":  "",
		"timeout":             Object{"baseTimeout": 10000, "uploadSpeedKBps": 256, "downloadSpeedKBps": 256, "maxTimeout": 1800000},
	}
	webui := Object{"host": "127.0.0.1", "port": 0, "token": record.Token, "loginRate": 10, "disableWebUI": true, "accessControlMode": "none", "ipWhitelist": []any{}, "ipBlacklist": []any{}, "enableXForwardedFor": false, "allowOrigins": []any{}, "enable2FA": false, "totpSecret": ""}
	for name, value := range map[string]Object{"onebot11.json": onebot, "webui.json": webui} {
		data, err := json.MarshalIndent(value, "", "  ")
		if err != nil {
			return err
		}
		if err = os.WriteFile(filepath.Join(record.ConfigDir, name), data, 0644); err != nil {
			return err
		}
	}
	return nil
}

func (s *snowcatManager) lastConfig() Object {
	// UI normally sends snowcat_qq_home through connect/discover; keep a small
	// copy here so deployment after a restart does not lose the chosen path.
	value, err := s.d.vault.get("snowcat-config")
	if err == nil {
		return getObject(value)
	}
	return Object{}
}

func (s *snowcatManager) saveLastConfig(config Object) {
	_ = s.d.vault.set("snowcat-config", Object{"snowcat_qq_home": getString(config, "snowcat_qq_home")})
}

func (s *snowcatManager) qqRunningForHome(home string) ([]int, bool, error) {
	pids, err := qqProcessIDs(home)
	if err != nil {
		return nil, false, err
	}
	return pids, len(pids) > 0, nil
}

func (s *snowcatManager) ready() bool {
	record := s.deployment
	if record == nil {
		record = s.loadRecord()
	}
	if record == nil || record.HTTPPort == 0 {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, fmt.Sprintf("http://127.0.0.1:%d/get_login_info", record.HTTPPort), bytes.NewBufferString("{}"))
	if err != nil {
		return false
	}
	request.Header.Set("Authorization", "Bearer "+record.Token)
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	return response.StatusCode == 200
}

func (s *snowcatManager) call(action string, params Object) (any, error) {
	if !readActions[action] {
		return nil, errors.New("高级调试仅支持读取动作")
	}
	record := s.deployment
	if record == nil {
		record = s.loadRecord()
	}
	if record == nil || record.HTTPPort == 0 {
		return nil, errors.New("SnowCat 尚未连接，请先启用并重启 QQ")
	}
	payload, err := json.Marshal(params)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, fmt.Sprintf("http://127.0.0.1:%d/%s", record.HTTPPort, action), bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+record.Token)
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return nil, errors.New("SnowCat 尚未就绪，请重启 QQ 后重试")
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 8<<20))
	if err != nil {
		return nil, err
	}
	if response.StatusCode != 200 {
		return nil, errors.New("SnowCat 读取失败（HTTP " + strconv.Itoa(response.StatusCode) + "）")
	}
	var result Object
	if json.Unmarshal(data, &result) != nil {
		return nil, errors.New("SnowCat 返回了无效数据")
	}
	if store.Number(result, "retcode") != 0 {
		return nil, errors.New(getString(result, "message") + "（retcode " + strconv.FormatFloat(store.Number(result, "retcode"), 'f', -1, 64) + "）")
	}
	return result["data"], nil
}

func (s *snowcatManager) loginInfo() (Object, error) {
	data, err := s.call("get_login_info", Object{})
	if err != nil {
		return nil, err
	}
	info := getObject(data)
	if info["uin"] == nil {
		return nil, errors.New("SnowCat 已就绪但 QQ 尚未登录")
	}
	return info, nil
}

func (s *snowcatManager) contacts(uin string) (any, error) {
	if uin == "" {
		info, err := s.loginInfo()
		if err != nil {
			return nil, err
		}
		uin = identity(info["uin"])
	}
	conversations := []Object{}
	for _, entry := range []struct{ action, prefix, id, name string }{{"get_group_list", "group:", "group_id", "group_name"}, {"get_friend_list", "private:", "user_id", "nickname"}} {
		data, err := s.call(entry.action, Object{})
		if err != nil {
			return nil, err
		}
		list, _ := data.([]any)
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

func (s *snowcatManager) discover(preferred string) (any, error) {
	root, err := s.locateRuntime(preferred)
	if err != nil {
		return nil, err
	}
	home, version, err := s.locateQQ(getString(s.lastConfig(), "snowcat_qq_home"))
	if err != nil {
		return nil, err
	}
	s.saveLastConfig(Object{"snowcat_qq_home": home})
	pids, running, err := s.qqRunningForHome(home)
	if err != nil {
		return nil, err
	}
	record := s.loadRecord()
	deployed := record != nil && record.Home == home
	online := s.ready()
	instance := Object{"pid": 0, "uin": "", "nickname": "QQ（SnowCat）", "status": "detected", "path": filepath.Join(home, "QQ.exe")}
	if running {
		instance["pid"] = pids[0]
		instance["status"] = "running"
	}
	state := "ready"
	message := "SnowCat 已就绪"
	if !running {
		state = "stopped"
		message = "QQ 未运行，启用后会自动启动"
	} else if deployed && !online {
		state = "restart_required"
		message = "已部署，重启 QQ 后生效"
	} else if !deployed {
		state = "needs_deploy"
		message = "需要启用 SnowCat 并重启 QQ"
	}
	return Object{
		"connector":  "snowcat",
		"version":    s.version,
		"runtime":    Object{"root": root, "version": s.version},
		"qq_home":    home,
		"qq_version": version,
		"state":      state,
		"message":    message,
		"deployed":   deployed,
		"running":    running,
		"ready":      online,
		"instances":  []Object{instance},
	}, nil
}

func (s *snowcatManager) connect(config Object) (any, error) {
	preferred := getString(config, "snowcat_home")
	if preferred == "" {
		preferred = ""
	}
	if home := getString(config, "snowcat_qq_home"); home != "" {
		s.saveLastConfig(Object{"snowcat_qq_home": home})
	}
	record, err := s.deploy(preferred)
	if err != nil {
		return nil, err
	}
	pids, running, err := s.qqRunningForHome(record.Home)
	if err != nil {
		return nil, err
	}
	if !running {
		// The user clicked connect; SnowCat needs QQ launched through the
		// injected shell, so start it from the QQ installation directory.
		cmd := exec.Command(filepath.Join(record.Home, "QQ.exe"))
		hideProcess(cmd)
		cmd.Dir = record.Home
		if err = cmd.Start(); err != nil {
			return nil, errors.New("无法启动 QQ：" + err.Error())
		}
		pids = []int{cmd.Process.Pid}
		running = true
	}
	if !s.ready() {
		return Object{
			"account": "", "uin": "", "qq_pid": 0, "conversations": []Object{},
			"restart_required": true, "running": running, "pid": firstPID(pids),
			"message": "SnowCat 文件已就位，QQ 需要重启后才能开始读取。现在可关闭 QQ 再重新打开，或稍后回到这里重新连接。",
		}, nil
	}
	info, err := s.loginInfo()
	if err != nil {
		return nil, err
	}
	uin := identity(info["uin"])
	contacts, err := s.contacts(uin)
	if err != nil {
		return nil, err
	}
	out := getObject(contacts)
	out["account"] = uin
	out["uin"] = uin
	out["qq_pid"] = firstPID(pids)
	out["qq_account"] = uin
	out["qq_http_url"] = fmt.Sprintf("http://127.0.0.1:%d", record.HTTPPort)
	out["qq_ws_url"] = fmt.Sprintf("ws://127.0.0.1:%d", record.WSPort)
	out["qq_token"] = record.Token
	out["connector"] = "snowcat"
	out["restart_required"] = false
	return out, nil
}

func firstPID(pids []int) float64 {
	if len(pids) > 0 {
		return float64(pids[0])
	}
	return 0
}

func (s *snowcatManager) debug(config Object) (any, error) {
	return s.call(getString(config, "action"), getObject(config["params"]))
}

func (s *snowcatManager) prepare(config Object) (Object, error) {
	if home := getString(config, "snowcat_qq_home"); home != "" {
		s.saveLastConfig(Object{"snowcat_qq_home": home})
	}
	record, err := s.deploy(getString(config, "snowcat_home"))
	if err != nil {
		return nil, err
	}
	if !s.ready() {
		return nil, errors.New("SnowCat 需要重启 QQ 后才能读取，请重启 QQ 后重试")
	}
	info, err := s.loginInfo()
	if err != nil {
		return nil, err
	}
	uin := identity(info["uin"])
	out := getObjectCopy(config)
	out["qq_account"] = uin
	out["qq_http_url"] = fmt.Sprintf("http://127.0.0.1:%d", record.HTTPPort)
	out["qq_ws_url"] = fmt.Sprintf("ws://127.0.0.1:%d", record.WSPort)
	out["qq_token"] = record.Token
	out["connector"] = "snowcat"
	return out, nil
}

func (s *snowcatManager) diagnostics() Object {
	s.mu.Lock()
	root, version := s.runtime, s.version
	logs := append([]Object(nil), s.logs...)
	s.mu.Unlock()
	record := s.loadRecord()
	out := Object{"ready": s.ready(), "runtime": Object{"root": root, "version": version}, "connected_accounts": []string{}, "logs": logs, "connector": "snowcat"}
	if record != nil {
		out["qq_home"] = record.Home
		out["qq_version"] = record.QQVersion
		out["http_port"] = float64(record.HTTPPort)
		out["ws_port"] = float64(record.WSPort)
		out["deployed"] = true
	}
	return out
}

func (s *snowcatManager) close() {
	// Shutdown restoration is explicit so callers can observe and log failures.
}

func (s *snowcatManager) shutdown() error {
	s.startMu.Lock()
	defer s.startMu.Unlock()
	record := s.loadRecord()
	if record == nil {
		return nil
	}
	pids, running, err := s.qqRunningForHome(record.Home)
	if err != nil {
		return err
	}
	if running {
		requestGracefulQQClose(pids)
		deadline := time.Now().Add(12 * time.Second)
		for running && time.Now().Before(deadline) {
			time.Sleep(200 * time.Millisecond)
			pids, running, err = s.qqRunningForHome(record.Home)
			if err != nil {
				return err
			}
			if running && len(pids) > 0 {
				requestGracefulQQClose(pids)
			}
		}
		if running {
			return errors.New("QQ 未能在退出时正常关闭，SnowCat 文件保留到下次启动后继续恢复")
		}
	}
	return s.restoreRecord(record)
}

func (s *snowcatManager) restore() error {
	s.startMu.Lock()
	defer s.startMu.Unlock()
	record := s.loadRecord()
	if record == nil {
		return nil
	}
	if _, running, err := s.qqRunningForHome(record.Home); err != nil {
		return err
	} else if running {
		return errors.New("QQ 正在运行，无法恢复 QQ 原有文件；请退出 QQ 后重试")
	}
	return s.restoreRecord(record)
}

func (s *snowcatManager) restoreRecord(record *snowcatRecord) error {
	for name, state := range record.Files {
		target := filepath.FromSlash(name)
		if state.Backup != "" {
			data, err := os.ReadFile(state.Backup)
			if err != nil {
				return fmt.Errorf("恢复 QQ 文件 %s 失败：%w", target, err)
			}
			if err = os.MkdirAll(filepath.Dir(target), 0755); err != nil {
				return err
			}
			if err = os.WriteFile(target, data, 0644); err != nil {
				return fmt.Errorf("写回 QQ 文件 %s 失败：%w", target, err)
			}
		} else if !state.Existed {
			if err := os.Remove(target); err != nil && !errors.Is(err, os.ErrNotExist) {
				return fmt.Errorf("删除 SnowCat 文件 %s 失败：%w", target, err)
			}
		}
	}
	app := s.appDir(record.Home, record.QQVersion)
	for _, name := range []string{"dbghelp.dll", "dbgeng.dll"} {
		disabled := filepath.Join(app, name+".disabled")
		if err := os.Remove(disabled); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("清理 %s 失败：%w", disabled, err)
		}
	}
	if err := os.Remove(s.recordPath()); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	_ = os.RemoveAll(s.backupDir())
	_ = os.Remove(record.ConfigDir)
	s.mu.Lock()
	s.deployment = nil
	s.started = false
	s.mu.Unlock()
	s.record("stopped", "已恢复 QQ 原有文件，可正常使用 SnowLuma")
	return nil
}

func normalizeQQConnector(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "snowcat":
		return "snowcat"
	case "snowluma", "":
		return "snowluma"
	default:
		return ""
	}
}

func (d *Desktop) activeQQConnector(requested string) (qqConnector, string, error) {
	d.mu.Lock()
	name := normalizeQQConnector(requested)
	if name == "" {
		name = normalizeQQConnector(d.qqConnector)
	}
	d.mu.Unlock()
	if name == "" {
		name = "snowluma"
	}
	if name == "snowcat" {
		if d.snowcat == nil {
			return nil, name, errors.New("SnowCat 连接器尚未初始化")
		}
		return d.snowcat, name, nil
	}
	if d.snowcat != nil && d.snowcat.loadRecord() != nil {
		record := d.snowcat.loadRecord()
		if _, running, err := d.snowcat.qqRunningForHome(record.Home); err != nil {
			return nil, name, err
		} else if running {
			return nil, name, errors.New("SnowCat 仍随当前 QQ 运行。请先退出 QQ，再切回 SnowLuma 和恢复 QQ 原生文件")
		}
		if err := d.snowcat.restore(); err != nil {
			return nil, name, err
		}
	}
	if d.qq == nil {
		return nil, name, errors.New("SnowLuma 连接器尚未初始化")
	}
	return d.qq, name, nil
}

func (d *Desktop) qqConnectorState(name string) Object {
	name = normalizeQQConnector(name)
	if name == "" {
		name = "snowluma"
	}
	out := Object{"name": name}
	if name == "snowcat" {
		if d.snowcat == nil {
			return out
		}
		runtimeRoot := ""
		runtimeVersion := ""
		if root, err := d.snowcat.locateRuntime(""); err == nil {
			runtimeRoot, runtimeVersion = root, d.snowcat.version
		}
		record := d.snowcat.loadRecord()
		out["runtime"] = Object{"root": runtimeRoot, "version": runtimeVersion}
		out["deployed"] = record != nil
		out["ready"] = d.snowcat.ready()
		if record != nil {
			out["qq_home"] = record.Home
			out["qq_version"] = record.QQVersion
		}
	} else {
		if d.qq == nil {
			return out
		}
		out["runtime"] = Object{"root": d.qq.runtime, "version": d.qq.version}
	}
	return out
}

func (d *Desktop) setQQConnector(value Object) (any, error) {
	name := normalizeQQConnector(getString(value, "name"))
	if name == "" {
		return nil, errors.New("QQ 连接器无效")
	}
	result := Object{"name": name, "restartRequired": false}
	if name == "snowluma" && d.snowcat != nil && d.snowcat.loadRecord() != nil {
		record := d.snowcat.loadRecord()
		if _, running, err := d.snowcat.qqRunningForHome(record.Home); err != nil {
			return nil, err
		} else if running {
			result["restartRequired"] = true
			result["message"] = "选择已保存。退出 QQ 后再切换到 SnowLuma，交件箱会恢复 QQ 原生文件。"
		} else if err := d.snowcat.restore(); err != nil {
			return nil, err
		}
	}
	d.mu.Lock()
	d.qqConnector = name
	d.mu.Unlock()
	if err := d.vault.set("qq-connector", Object{"name": name}); err != nil {
		return nil, err
	}
	result["state"] = d.qqConnectorState(name)
	return result, nil
}

func (d *Desktop) discoverQQ(preferred, requested string) (any, error) {
	manager, name, err := d.activeQQConnector(requested)
	if err != nil {
		return nil, err
	}
	result, err := manager.discover(preferred)
	if err != nil {
		return nil, err
	}
	if out := getObject(result); out != nil {
		out["connector"] = name
	}
	return result, nil
}

func (d *Desktop) connectQQ(config Object) (any, error) {
	manager, name, err := d.activeQQConnector(getString(config, "qq_connector"))
	if err != nil {
		return nil, err
	}
	result, err := manager.connect(config)
	if err != nil {
		return nil, err
	}
	if out := getObject(result); out != nil {
		out["connector"] = name
	}
	return result, nil
}

func (d *Desktop) debugQQ(config Object) (any, error) {
	manager, _, err := d.activeQQConnector(getString(config, "qq_connector"))
	if err != nil {
		return nil, err
	}
	return manager.debug(config)
}

func (d *Desktop) qqConsent(preferred, requested string) (any, error) {
	manager, name, err := d.activeQQConnector(requested)
	if err != nil {
		return nil, err
	}
	consent, ok := manager.(qqConsent)
	if !ok {
		return nil, errors.New("当前 QQ 连接器不需要协议确认")
	}
	info, err := consent.consentInfo(preferred)
	if err != nil {
		return nil, err
	}
	info["connector"] = name
	return info, nil
}

func (d *Desktop) acceptQQConsent(preferred, requested string) (any, error) {
	manager, _, err := d.activeQQConnector(requested)
	if err != nil {
		return nil, err
	}
	consent, ok := manager.(qqConsent)
	if !ok {
		return Object{"accepted": true}, nil
	}
	return consent.acceptConsent(preferred)
}
