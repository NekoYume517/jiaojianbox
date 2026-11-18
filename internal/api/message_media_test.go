package api

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/NekoYume517/jiaojianbox/internal/store"
)

func uploadMessageImage(t *testing.T, s *Server, token string, payload Object, imageData []byte) (int, Object) {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if err := writer.WriteField("payload", store.JSON(payload)); err != nil {
		t.Fatal(err)
	}
	part, err := writer.CreateFormFile("media", "image.png")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = part.Write(imageData); err != nil {
		t.Fatal(err)
	}
	writer.Close()
	req := httptest.NewRequest(http.MethodPost, "/api/messages", &body)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	response := httptest.NewRecorder()
	s.ServeHTTP(response, req)
	result := Object{}
	json.Unmarshal(response.Body.Bytes(), &result)
	return response.Code, result
}

func TestMessageMediaIsOwnedAndPurgedWithMessage(t *testing.T) {
	s := testServer(t)
	token, user := login(t, s, "media-owner")
	otherToken, _ := login(t, s, "media-other")
	var imageData bytes.Buffer
	if err := png.Encode(&imageData, image.NewRGBA(image.Rect(0, 0, 16, 12))); err != nil {
		t.Fatal(err)
	}
	code, message := uploadMessageImage(t, s, token, Object{
		"source": "wechat", "account_id": "wx-self", "conversation_id": "class",
		"external_id": "image-one", "sender_id": "wx-self", "direction": "self", "is_self": true,
		"text": "图片消息", "message_type": "image", "sent_at": "2026-11-17T12:00:00+08:00",
		"media": Object{"kind": "image", "status": "ready", "mime": "image/png", "tier": "h"},
	}, imageData.Bytes())
	if code != 201 || str(message, "direction") != "self" || !boolean(message, "is_self") {
		t.Fatal(code, message)
	}
	media := object(message["media"])
	mediaID := str(media, "id")
	if mediaID == "" || str(media, "mime") != "image/png" {
		t.Fatal("image was not saved as message media", message)
	}
	mediaPath := s.blob(mediaID)
	stored, err := os.ReadFile(mediaPath)
	if err != nil || !bytes.Equal(stored, imageData.Bytes()) {
		t.Fatal("stored media differs from uploaded image", err)
	}
	for _, tc := range []struct {
		name, token string
		want        int
	}{{"owner", token, 200}, {"other user", otherToken, 404}, {"anonymous", "", 401}} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/api/messages/"+str(message, "id")+"/media/"+mediaID, nil)
			if tc.token != "" {
				req.Header.Set("Authorization", "Bearer "+tc.token)
			}
			response := httptest.NewRecorder()
			s.ServeHTTP(response, req)
			if response.Code != tc.want {
				t.Fatalf("status %d != %d", response.Code, tc.want)
			}
			if tc.want == 200 {
				data, _ := io.ReadAll(response.Body)
				if response.Header().Get("Content-Type") != "image/png" || !bytes.Equal(data, imageData.Bytes()) {
					t.Fatal("wrong media response")
				}
			}
		})
	}
	if code, _ := call(t, s, "DELETE", "/api/messages/"+str(message, "id"), token, nil); code != 200 {
		t.Fatal("could not recycle message", code)
	}
	paths := s.permanentDelete(context.Background(), s.Store.DB, user, "message", str(message, "id"))
	if len(paths) != 1 || paths[0] != mediaPath {
		t.Fatal("media was not included in permanent deletion", paths)
	}
	for _, path := range paths {
		os.Remove(path)
	}
	if _, err = os.Stat(mediaPath); !os.IsNotExist(err) {
		t.Fatal("media file remains after permanent deletion", err)
	}
}
