// Package setup implements the custom installer. It never opens the user's data directory.
package setup

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const Marker = ".jiaojianbox-install.json"
const footerMagic = "JJBSET01"

type Manifest struct {
	Version   string            `json:"version"`
	Files     map[string]string `json:"files"`
	Desktop   bool              `json:"desktop"`
	StartMenu bool              `json:"startMenu"`
}
type Payload struct {
	*zip.Reader
	File     *os.File
	Manifest Manifest
}

func OpenPayload(name string) (*Payload, error) {
	f, err := os.Open(name)
	if err != nil {
		return nil, err
	}
	good := false
	defer func() {
		if !good {
			f.Close()
		}
	}()
	stat, err := f.Stat()
	if err != nil || stat.Size() < 48 {
		return nil, errors.New("安装文件不完整，请重新下载")
	}
	footer := make([]byte, 48)
	if _, err = f.ReadAt(footer, stat.Size()-48); err != nil {
		return nil, err
	}
	size := int64(binary.LittleEndian.Uint64(footer[:8]))
	if string(footer[40:]) != footerMagic || size <= 0 || size > stat.Size()-48 {
		return nil, errors.New("安装文件无效")
	}
	start := stat.Size() - 48 - size
	hash := sha256.New()
	if _, err = io.Copy(hash, io.NewSectionReader(f, start, size)); err != nil {
		return nil, err
	}
	if hex.EncodeToString(hash.Sum(nil)) != hex.EncodeToString(footer[8:40]) {
		return nil, errors.New("安装文件校验失败，请重新下载")
	}
	reader, err := zip.NewReader(io.NewSectionReader(f, start, size), size)
	if err != nil {
		return nil, err
	}
	p := &Payload{Reader: reader, File: f}
	entry, err := reader.Open("manifest.json")
	if err != nil {
		return nil, err
	}
	defer entry.Close()
	if err = json.NewDecoder(io.LimitReader(entry, 1<<20)).Decode(&p.Manifest); err != nil || p.Manifest.Version == "" || len(p.Manifest.Files) == 0 {
		return nil, errors.New("安装清单无效")
	}
	good = true
	return p, nil
}
func safeRelative(name string) bool {
	if name == "" || strings.ContainsAny(name, "\\:\x00") || strings.HasPrefix(name, "/") {
		return false
	}
	for _, part := range strings.Split(name, "/") {
		if part == "" || part == "." || part == ".." || strings.HasSuffix(part, ".") || strings.HasSuffix(part, " ") {
			return false
		}
	}
	return filepath.IsLocal(filepath.FromSlash(name))
}
func safeTarget(target string) (string, error) {
	path, err := filepath.Abs(target)
	if err != nil {
		return "", err
	}
	path = filepath.Clean(path)
	if !filepath.IsAbs(target) || filepath.Dir(path) == path || len(filepath.Base(path)) < 2 {
		return "", errors.New("请选择独立的安装文件夹")
	}
	for _, protected := range []string{os.Getenv("USERPROFILE"), os.Getenv("LOCALAPPDATA"), os.Getenv("APPDATA"), os.Getenv("WINDIR"), os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)")} {
		if protected != "" {
			rel, e := filepath.Rel(protected, path)
			if e == nil && (rel == "." || filepath.IsLocal(rel) && strings.EqualFold(protected, os.Getenv("WINDIR"))) {
				return "", errors.New("此目录不能用作安装文件夹")
			}
		}
	}
	// Reparse points must not redirect writes outside the selected directory.
	for p := path; ; p = filepath.Dir(p) {
		if stat, e := os.Lstat(p); e == nil && stat.Mode()&os.ModeSymlink != 0 {
			return "", errors.New("安装路径不能包含符号链接")
		}
		if filepath.Dir(p) == p {
			break
		}
	}
	if entries, e := os.ReadDir(path); e == nil && len(entries) > 0 {
		if _, e = os.Stat(filepath.Join(path, Marker)); e != nil {
			if _, e = os.Stat(filepath.Join(path, "交件箱.exe")); e != nil {
				return "", errors.New("目录中已有其他文件，请选择空文件夹")
			}
		}
	}
	return path, nil
}

func isJiaojianboxInstallation(path string) bool {
	if _, err := os.Stat(filepath.Join(path, Marker)); err == nil {
		return true
	}
	_, err := os.Stat(filepath.Join(path, "交件箱.exe"))
	return err == nil
}

func directoryIsEmpty(path string) bool {
	entries, err := os.ReadDir(path)
	return err == nil && len(entries) == 0
}

// ResolveDirectory keeps an empty picked folder as the target, sends a folder
// the user has already filled into a dedicated jiaojianbox subfolder, and
// updates an existing installation in place.
func ResolveDirectory(requested string) (string, error) {
	requested = strings.TrimSpace(requested)
	if requested == "" {
		requested = DefaultDirectory()
	}
	if !filepath.IsAbs(requested) {
		return "", errors.New("请选择一个绝对路径")
	}
	path, err := filepath.Abs(requested)
	if err != nil {
		return "", err
	}
	path = filepath.Clean(path)
	if !filepath.IsAbs(path) {
		return "", errors.New("请选择一个绝对路径")
	}
	stat, err := os.Stat(path)
	if err != nil {
		if !os.IsNotExist(err) {
			return "", errors.New("无法读取选择的文件夹")
		}
		return safeTarget(path)
	}
	if !stat.IsDir() {
		return "", errors.New("选择的路径不是文件夹")
	}
	if directoryIsEmpty(path) || isJiaojianboxInstallation(path) {
		return safeTarget(path)
	}
	nested := filepath.Join(path, "jiaojianbox")
	if stat, err = os.Stat(nested); err == nil && !stat.IsDir() {
		return "", errors.New("jiaojianbox 子文件夹被其他文件占用")
	}
	if err != nil && !os.IsNotExist(err) {
		return "", errors.New("无法创建 jiaojianbox 子文件夹")
	}
	if os.IsNotExist(err) {
		return safeTarget(nested)
	}
	if directoryIsEmpty(nested) || isJiaojianboxInstallation(nested) {
		return safeTarget(nested)
	}
	return "", errors.New("所选文件夹和 jiaojianbox 子文件夹都已有内容")
}

func installedOptions(target string) (bool, bool, bool) {
	raw, err := os.ReadFile(filepath.Join(target, Marker))
	if err != nil {
		return false, true, true
	}
	var manifest Manifest
	if json.Unmarshal(raw, &manifest) != nil {
		return false, true, true
	}
	return true, manifest.Desktop, manifest.StartMenu
}

func rejectLinks(root, dir string) error {
	for p := dir; ; p = filepath.Dir(p) {
		if stat, err := os.Lstat(p); err == nil && stat.Mode()&os.ModeSymlink != 0 {
			return errors.New("安装目录不能包含符号链接")
		}
		if p == root {
			return nil
		}
		if filepath.Dir(p) == p {
			return errors.New("安装路径超出范围")
		}
	}
}

func extract(ctx context.Context, p *Payload, stage string, progress func(int, string)) error {
	seen := map[string]bool{}
	total := len(p.Manifest.Files)
	done := 0
	for _, f := range p.Reader.File {
		if f.Name == "manifest.json" || strings.HasPrefix(f.Name, "dependencies/") {
			continue
		}
		if !safeRelative(f.Name) || f.Mode()&os.ModeSymlink != 0 {
			return errors.New("安装包包含不安全路径")
		}
		expected, ok := p.Manifest.Files[f.Name]
		if !ok || seen[f.Name] {
			return errors.New("安装包清单不匹配")
		}
		seen[f.Name] = true
		if f.UncompressedSize64 > 1<<30 {
			return errors.New("安装文件尺寸异常")
		}
		target := filepath.Join(stage, filepath.FromSlash(f.Name))
		if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
			return err
		}
		src, err := f.Open()
		if err != nil {
			return err
		}
		dst, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0755)
		if err != nil {
			src.Close()
			return err
		}
		hash := sha256.New()
		_, err = io.Copy(io.MultiWriter(dst, hash), &contextReader{ctx: ctx, r: src})
		src.Close()
		closeErr := dst.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
		if hex.EncodeToString(hash.Sum(nil)) != expected {
			return fmt.Errorf("文件校验失败：%s", f.Name)
		}
		done++
		progress(done*80/total, "正在安装 "+filepath.Base(target))
	}
	if len(seen) != total {
		return errors.New("安装包缺少组件")
	}
	return nil
}

type contextReader struct {
	ctx context.Context
	r   io.Reader
}

func (r *contextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.r.Read(p)
}

// Install replaces only manifest-owned files, with rollback on every failed write.
// Existing unlisted files and all account/offline data remain untouched.
func Install(ctx context.Context, p *Payload, target string, desktop, startMenu bool, progress func(int, string)) (string, error) {
	target, err := safeTarget(target)
	if err != nil {
		return "", err
	}
	progress(1, "正在结束旧版本进程")
	if err = stopInstalledProcesses(target); err != nil {
		return "", err
	}
	parent := filepath.Dir(target)
	if err = os.MkdirAll(parent, 0755); err != nil {
		return "", err
	}
	stage, err := os.MkdirTemp(parent, ".jjb-stage-")
	if err != nil {
		return "", errors.New("没有安装权限，请选择当前用户的文件夹")
	}
	defer os.RemoveAll(stage)
	backup, err := os.MkdirTemp(parent, ".jjb-rollback-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(backup)
	if err = extract(ctx, p, stage, progress); err != nil {
		return "", err
	}
	manifest := p.Manifest
	manifest.Desktop = desktop
	manifest.StartMenu = startMenu
	data, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return "", err
	}
	if err = os.WriteFile(filepath.Join(stage, Marker), data, 0600); err != nil {
		return "", err
	}
	names := []string{}
	for name := range manifest.Files {
		names = append(names, name)
	}
	sort.Strings(names)
	names = append(names, Marker)
	installed := []string{}
	saved := []string{}
	committed := false
	defer func() {
		if !committed {
			for _, name := range installed {
				os.Remove(filepath.Join(target, filepath.FromSlash(name)))
			}
			for _, name := range saved {
				dst := filepath.Join(target, filepath.FromSlash(name))
				os.MkdirAll(filepath.Dir(dst), 0755)
				os.Rename(filepath.Join(backup, filepath.FromSlash(name)), dst)
			}
		}
	}()
	for _, name := range names {
		if err = ctx.Err(); err != nil {
			return "", err
		}
		dest := filepath.Join(target, filepath.FromSlash(name))
		if err = rejectLinks(target, filepath.Dir(dest)); err != nil {
			return "", err
		}
		src := filepath.Join(stage, filepath.FromSlash(name))
		if err = os.MkdirAll(filepath.Dir(dest), 0755); err != nil {
			return "", err
		}
		if stat, e := os.Lstat(dest); e == nil {
			if !stat.Mode().IsRegular() {
				return "", errors.New("安装目录包含不兼容文件")
			}
			old := filepath.Join(backup, filepath.FromSlash(name))
			os.MkdirAll(filepath.Dir(old), 0755)
			if err = os.Rename(dest, old); err != nil {
				return "", errors.New("请先在托盘中退出交件箱，然后重试安装")
			}
			saved = append(saved, name)
		}
		if err = os.Rename(src, dest); err != nil {
			return "", err
		}
		installed = append(installed, name)
	}
	committed = true
	progress(95, "正在创建快捷方式")
	return target, nil
}

// RemoveInstalled deletes only files named by this install's manifest.
func RemoveInstalled(target string) error {
	absolute, err := filepath.Abs(target)
	if err != nil {
		return err
	}
	raw, err := os.ReadFile(filepath.Join(absolute, Marker))
	if err != nil {
		return errors.New("未找到交件箱安装清单")
	}
	var manifest Manifest
	if json.Unmarshal(raw, &manifest) != nil || len(manifest.Files) == 0 {
		return errors.New("安装清单无效")
	}
	if err = stopInstalledProcesses(absolute); err != nil {
		return err
	}
	for name := range manifest.Files {
		if !safeRelative(name) {
			return errors.New("安装清单路径无效")
		}
		if err = rejectLinks(absolute, filepath.Dir(filepath.Join(absolute, filepath.FromSlash(name)))); err != nil {
			return err
		}
	}
	for name := range manifest.Files {
		full := filepath.Join(absolute, filepath.FromSlash(name))
		if err = os.Remove(full); err != nil && !os.IsNotExist(err) {
			return err
		}
		for dir := filepath.Dir(full); dir != absolute && filepath.IsLocal(mustRelative(absolute, dir)); dir = filepath.Dir(dir) {
			if os.Remove(dir) != nil {
				break
			}
		}
	}
	if err = os.Remove(filepath.Join(absolute, Marker)); err != nil {
		return err
	}
	os.Remove(absolute)
	return nil
}
func mustRelative(root, path string) string {
	r, err := filepath.Rel(root, path)
	if err != nil {
		return ".."
	}
	return r
}
