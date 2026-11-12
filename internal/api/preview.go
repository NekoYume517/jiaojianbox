package api

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"
)

const (
	previewTextLimit  = 2 << 20
	previewZipLimit   = 30 << 20
	previewExtractMax = 6 << 20
)

var previewImage = map[string]string{
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
	".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
}

var previewAudio = map[string]string{
	".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
	".m4a": "audio/mp4", ".flac": "audio/flac",
}

var previewVideo = map[string]string{
	".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
	".m4v": "video/mp4",
}

var previewText = map[string]bool{
	".txt": true, ".md": true, ".markdown": true, ".json": true, ".jsonl": true,
	".csv": true, ".tsv": true, ".xml": true, ".yaml": true, ".yml": true,
	".log": true, ".ini": true, ".toml": true, ".go": true, ".js": true,
	".ts": true, ".css": true, ".html": true, ".sql": true,
}

func officePreview(path, ext string) (string, error) {
	zr, err := zip.OpenReader(path)
	if err != nil {
		return "", err
	}
	defer zr.Close()
	type target struct {
		name  string
		order int
	}
	targets := []target{}
	for _, f := range zr.File {
		name := filepath.ToSlash(f.Name)
		include := false
		switch ext {
		case ".docx":
			include = name == "word/document.xml"
		case ".pptx":
			include = strings.HasPrefix(name, "ppt/slides/slide") && strings.HasSuffix(name, ".xml")
		case ".xlsx":
			include = name == "xl/sharedStrings.xml" || strings.HasPrefix(name, "xl/worksheets/sheet") && strings.HasSuffix(name, ".xml")
		}
		if include {
			targets = append(targets, target{name: name, order: len(targets)})
		}
	}
	sort.Slice(targets, func(i, j int) bool {
		if ext == ".pptx" {
			return targets[i].name < targets[j].name
		}
		return targets[i].order < targets[j].order
	})
	var out strings.Builder
	remaining := previewExtractMax
	for _, item := range targets {
		if remaining <= 0 {
			break
		}
		file := zr.File[0]
		for _, candidate := range zr.File {
			if filepath.ToSlash(candidate.Name) == item.name {
				file = candidate
				break
			}
		}
		if file.UncompressedSize64 > uint64(remaining) {
			continue
		}
		src, openErr := file.Open()
		if openErr != nil {
			return "", openErr
		}
		decoder := xml.NewDecoder(io.LimitReader(src, int64(remaining)))
		inValue := false
		for {
			token, tokenErr := decoder.Token()
			if tokenErr == io.EOF {
				break
			}
			if tokenErr != nil {
				src.Close()
				return "", tokenErr
			}
			switch value := token.(type) {
			case xml.StartElement:
				inValue = value.Name.Local == "t" || value.Name.Local == "v"
				if ext == ".pptx" && value.Name.Local == "p" && out.Len() > 0 {
					out.WriteByte('\n')
				}
			case xml.EndElement:
				if value.Name.Local == "t" || value.Name.Local == "v" {
					inValue = false
					out.WriteByte(' ')
				}
			case xml.CharData:
				if inValue {
					text := strings.Join(strings.Fields(string(value)), " ")
					if text != "" {
						out.WriteString(text)
						remaining -= len(text)
					}
				}
			}
		}
		src.Close()
		out.WriteString("\n\n")
	}
	text := strings.TrimSpace(out.String())
	if text == "" {
		text = "文件中没有可提取的文本。可以下载后用 Office 打开。"
	}
	return text, nil
}

func (s *Server) filePreview(r request) any {
	file := one(r.Context(), s.Store.DB, "SELECT * FROM attachments WHERE id=? AND user_id=? AND deleted_at IS NULL", r.PathValue("file_id"), r.User)
	path := s.blob(str(file, "id"))
	info, err := os.Stat(path)
	if err != nil {
		fail(404, "文件不存在")
	}
	ext := strings.ToLower(filepath.Ext(str(file, "name")))
	if contentType, ok := previewImage[ext]; ok {
		r.W.Header().Set("Content-Type", contentType)
		r.W.Header().Set("Content-Disposition", "inline")
		http.ServeFile(r.W, r.Request, path)
		return nil
	}
	if contentType, ok := previewAudio[ext]; ok {
		r.W.Header().Set("Content-Type", contentType)
		r.W.Header().Set("Content-Disposition", "inline")
		http.ServeFile(r.W, r.Request, path)
		return nil
	}
	if contentType, ok := previewVideo[ext]; ok {
		r.W.Header().Set("Content-Type", contentType)
		r.W.Header().Set("Content-Disposition", "inline")
		http.ServeFile(r.W, r.Request, path)
		return nil
	}
	if ext == ".pdf" {
		r.W.Header().Set("Content-Type", "application/pdf")
		r.W.Header().Set("Content-Disposition", "inline")
		http.ServeFile(r.W, r.Request, path)
		return nil
	}
	if previewText[ext] {
		if info.Size() > previewTextLimit {
			fail(413, "文本文件超过 2 MB，请下载后查看")
		}
		data, readErr := os.ReadFile(path)
		check(readErr)
		if !utf8.Valid(data) || bytes.IndexByte(data, 0) >= 0 {
			fail(415, "此文本文件不是 UTF-8，请下载后查看")
		}
		r.W.Header().Set("Content-Type", "text/plain; charset=utf-8")
		r.W.Header().Set("Content-Disposition", "inline")
		r.W.Write(data)
		return nil
	}
	if ext == ".docx" || ext == ".xlsx" || ext == ".pptx" {
		if info.Size() > previewZipLimit {
			fail(413, "Office 文件超过 30 MB，请下载后查看")
		}
		text, extractErr := officePreview(path, ext)
		if extractErr != nil {
			fail(415, "Office 文件内容无法安全预览，请下载后查看")
		}
		return Object{"kind": "office", "format": strings.TrimPrefix(ext, "."), "text": text, "name": str(file, "name")}
	}
	contentType := mime.TypeByExtension(ext)
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	fail(415, Object{"message": "此文件类型暂不支持预览，请下载后打开", "content_type": contentType})
	return nil
}

func (s *Server) previewRoutes() {
	s.route("GET /api/files/{file_id}/preview", "owner", s.filePreview)
}
