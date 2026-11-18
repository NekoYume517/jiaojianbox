import base64
import hashlib
import json
import threading

import httpx

from collector.agent import Queue, uploader
from collector.normalize import analysis_eligible, qq, wechat
from collector.wechat_media import LocalImageReader


def row(content="通知", kind="文本", sender="wxid_friend", **extra):
    return {"content": content, "type": kind, "sender_username": sender,
            "local_id": 1, "sort_seq": 1, "create_time": 1794000000, **extra}


def test_wechat_direction_uses_resolved_username_not_numeric_sender_id():
    own = wechat(row(sender="wxid_me", real_sender_id=4), "wxid_me_abcd", "group@chatroom", self_id="wxid_me")
    other = wechat(row(sender="wxid_friend", real_sender_id=4), "wxid_me_abcd", "group@chatroom", self_id="wxid_me")
    system = wechat(row("<sysmsg><revokemsg><content>有人撤回了一条消息</content></revokemsg></sysmsg>", "系统消息", ""), "wxid_me_abcd", "group@chatroom")
    unknown = wechat(row(sender=""), "wxid_me_abcd", "group@chatroom")
    assert (own["direction"], own["is_self"]) == ("self", True)
    assert (other["direction"], other["is_self"]) == ("other", False)
    assert system["direction"] == "system" and system["is_self"] is None
    assert system["text"] == "有人撤回了一条消息"
    assert unknown["direction"] == "unknown" and unknown["is_self"] is None


def test_reaction_filter_does_not_drop_images_or_expressive_text():
    def normalized(content="通知", kind="文本"):
        return wechat(row(content, kind), "wxid_me_abcd", "group@chatroom")
    assert not analysis_eligible(normalized("[动画表情]"))
    assert not analysis_eligible(normalized("[微笑]"))
    assert not analysis_eligible(normalized("[奸笑]"))
    assert analysis_eligible(normalized("这样的[奸笑]emoji"))
    assert analysis_eligible(normalized("[微笑]请周五前提交作业"))
    assert not analysis_eligible(normalized("<msg></msg>", "动画表情"))
    image = wechat(row("<msg></msg>", "图片"), "wxid_me_abcd", "group@chatroom", media={"kind": "image", "status": "not_downloaded"})
    assert image["message_type"] == "image" and analysis_eligible(image)
    assert image["text"] == "图片消息" and "<msg>" not in image["text"]


def test_qq_self_echo_direction_and_reaction_contract():
    event = {"post_type": "message_sent", "self_id": 101, "user_id": 101,
             "target_id": 201, "message_type": "private", "message_id": 401,
             "time": 1794000000, "message": [{"type": "text", "data": {"text": "我补充的提交链接"}}]}
    own = qq(event)
    assert own["direction"] == "self" and own["is_self"] is True
    assert own["conversation_id"] == "private:201"
    duplicate_echo = qq({**event, "post_type": "message", "user_id": 201, "echo": True})
    assert duplicate_echo is None
    assert not analysis_eligible(qq({**event, "message": [{"type": "text", "data": {"text": "[奸笑]"}}]}))
    assert analysis_eligible(qq({**event, "message": [{"type": "text", "data": {"text": "这样的[奸笑]emoji"}}]}))
    picture = qq({**event, "message": [{"type": "image", "data": {"file": "picture.jpg"}}]})
    assert picture["text"] == "[图片]" and analysis_eligible(picture)


def test_local_image_reader_v1_uses_month_path_and_returns_only_image(tmp_path):
    class DB:
        account_dir = str(tmp_path)
        cfg_dword = 0x1234
    chat = "group@chatroom"
    md5 = "ab" * 16
    image = b"\xff\xd8\xff" + b"fixture" + b"\xff\xd9"
    key = 0x1234 & 0xff
    encrypted = b"\x07\x08\x05\x56\x02\x05" + bytes(16) + bytes(value ^ key for value in image)
    folder = tmp_path / "msg" / "attach" / hashlib.md5(chat.encode()).hexdigest() / "2026-11" / "Img"
    folder.mkdir(parents=True)
    (folder / (md5 + ".dat")).write_bytes(encrypted)
    result = LocalImageReader(DB(), tmp_path / "private-cache").read(
        row("<msg></msg>", "图片", packed_info=md5.encode(), create_time=1794000000), chat)
    assert result["status"] == "ready" and result["mime"] == "image/jpeg"
    assert base64.b64decode(result["data"]) == image
    assert not (tmp_path / "private-cache" / "image-key.json").exists()


def test_multipart_upload_contains_image_not_base64_or_key(tmp_path, monkeypatch):
    queue = Queue(tmp_path)
    image = b"fixture-image"
    queue.add({"source": "wechat", "account_id": "wx", "conversation_id": "chat",
               "external_id": "1", "text": "图片消息", "sent_at": "2026-11-17T00:00:00+00:00",
               "media": {"kind": "image", "status": "ready", "mime": "image/jpeg",
                         "extension": "jpg", "data": base64.b64encode(image).decode()}})
    requests = []
    def upstream(request):
        requests.append(request)
        return httpx.Response(201, json={"ok": True})
    original = httpx.AsyncClient
    monkeypatch.setattr("collector.agent.httpx.AsyncClient", lambda **kwargs: original(transport=httpx.MockTransport(upstream), **kwargs))
    stopped = threading.Event()
    stopped.set()
    # Let the first pending batch upload, then stop on the next iteration.
    stopped.clear()
    async def exercise():
        task = __import__("asyncio").create_task(uploader({"server_url": "http://fixture.test", "server_token": "fixture"}, queue, stopped))
        for _ in range(100):
            if requests:
                break
            await __import__("asyncio").sleep(.01)
        stopped.set()
        await task
    __import__("asyncio").run(exercise())
    assert requests and queue.pending_count() == 0
    body = requests[0].content
    assert image in body and base64.b64encode(image) not in body
    assert b"image-key" not in body and b"cfg_dword" not in body
    payload = json.loads(body.split(b'name="payload"\r\n\r\n', 1)[1].split(b"\r\n--", 1)[0])
    assert "data" not in payload["media"]
