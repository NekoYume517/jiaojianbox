"""把微信数据库行和 OneBot 事件统一为通知，不执行消息内容。"""
import html
import re
from datetime import datetime, timezone
from xml.etree import ElementTree as ET


def timestamp(value):
    return datetime.fromtimestamp(float(value or 0), timezone.utc).isoformat()


def wechat(row, account, chat, chat_name="", sender_name=""):
    raw = row.get("content") or ""
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", errors="replace")
    raw = str(raw)
    sender = row.get("sender_username") or ""
    match = re.match(r"^([a-zA-Z][\w-]{4,80}):\r?\n", raw)
    if chat.endswith("@chatroom") and match:
        sender = sender or match[1]
        raw = raw[match.end():]
    text = raw
    message_type = str(row.get("type", "文本"))
    metadata = {}
    if raw.lstrip().startswith("<") and message_type != "文本":
        try:
            root = ET.fromstring(raw[:100000])
            title = root.findtext(".//appmsg/title") or root.findtext(".//title") or ""
            url = root.findtext(".//appmsg/url") or ""
            description = root.findtext(".//appmsg/des") or ""
            quote = root.find(".//refermsg")
            if quote is not None:
                metadata["quote"] = {"sender": quote.findtext("displayname") or "", "text": html.unescape(quote.findtext("content") or "")[:4000]}
                text = title
            elif title:
                text = "\n".join(x for x in (title, description, url) if x)
                metadata["card"] = {"title": title, "url": url,
                    "extension": root.findtext(".//fileext") or "", "size": root.findtext(".//totallen") or ""}
            else:
                text = "[" + message_type + "]"
        except ET.ParseError:
            text = "[" + message_type + "]"
    external = f"{row.get('shard', '')}:{row.get('local_id', 0)}:{row.get('sort_seq', 0)}"
    return {"source": "wechat", "account_id": str(account), "conversation_id": chat,
            "conversation_name": chat_name or chat, "external_id": external,
            "sender_id": sender, "sender_name": sender_name or sender,
            "text": text[:30000], "sent_at": timestamp(row.get("create_time")),
            "message_type": message_type, "metadata": metadata}


def qq(event, names=None):
    if event.get("post_type") not in ("message", "message_sent"):
        return None
    if event.get("message_id") is None or event.get("self_id") is None:
        return None
    sender = event.get("sender") or {}
    group = event.get("message_type") == "group"
    chat = ("group:" + str(event["group_id"])) if group else ("private:" + str(event.get("target_id") if event.get("post_type") == "message_sent" else event.get("user_id")))
    segments = event.get("message")
    parts, metadata = [], {"segments": []}
    if isinstance(segments, list):
        for segment in segments[:100]:
            kind, data = segment.get("type"), segment.get("data") or {}
            if kind == "text":
                parts.append(str(data.get("text", "")))
            elif kind == "at":
                parts.append("@" + str(data.get("qq", "")))
            elif kind == "reply":
                metadata["reply_id"] = str(data.get("id", ""))
            else:
                parts.append({"image": "[图片]", "record": "[语音]", "file": "[文件]", "video": "[视频]", "forward": "[合并转发]"}.get(kind, "[" + str(kind) + "]"))
                if len(metadata["segments"]) < 24:
                    metadata["segments"].append({"type": kind, "name": str(data.get("name") or data.get("file") or "")[:300]})
    else:
        parts = [str(event.get("raw_message") or segments or "")]
    return {"source": "qq", "account_id": str(event.get("self_id", "")), "conversation_id": chat,
            "conversation_name": (names or {}).get(chat, chat), "external_id": str(event.get("message_id", "")),
            "sender_id": str(event.get("user_id", "")), "sender_name": sender.get("card") or sender.get("nickname") or str(event.get("user_id", "")),
            "text": "".join(parts)[:30000], "sent_at": timestamp(event.get("time")), "message_type": "text", "metadata": metadata}
