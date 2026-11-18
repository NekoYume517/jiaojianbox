"""把微信数据库行和 OneBot 事件统一为通知，不执行消息内容。"""
import html
import re
from datetime import datetime, timezone
from xml.etree import ElementTree as ET


TYPE_NAMES = {"文本": "text", "图片": "image", "语音": "voice", "视频": "video",
              "动画表情": "sticker", "位置": "location", "文件/链接/卡片": "link",
              "音视频通话": "voip", "系统消息": "system", "红包": "red_packet"}

PURE_REACTION = re.compile(r"^\s*(?:\[[^\]\r\n]{1,32}\]\s*)+$")


def analysis_eligible(message):
    """Only suppress reactions, never images or messages containing real text."""
    if message.get("message_type") in ("sticker", "system"):
        return False
    if message.get("message_type") == "image":
        return True
    return not PURE_REACTION.fullmatch(str(message.get("text") or ""))


def timestamp(value):
    return datetime.fromtimestamp(float(value or 0), timezone.utc).isoformat()


def wechat(row, account, chat, chat_name="", sender_name="", self_id="", media=None):
    raw = row.get("content") or ""
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", errors="replace")
    raw = str(raw)
    sender = row.get("sender_username") or ""
    match = re.match(r"^([a-zA-Z][\w-]{4,80})[:：]\r?\n", raw)
    if chat.endswith("@chatroom") and match:
        sender = sender or match[1]
        raw = raw[match.end():]
    text = raw
    label = str(row.get("type", "文本"))
    message_type = TYPE_NAMES.get(label, "other")
    metadata = {}
    if raw.lstrip().startswith("<") and message_type != "text":
        try:
            root = ET.fromstring(raw[:100000])
            title = html.unescape(root.findtext(".//appmsg/title") or root.findtext(".//title") or "").strip()
            url = html.unescape(root.findtext(".//appmsg/url") or "").strip()
            description = html.unescape(root.findtext(".//appmsg/des") or "").strip()
            app_type = root.findtext(".//appmsg/type") or ""
            quote = root.find(".//refermsg")
            if quote is not None:
                metadata["quote"] = {"sender": quote.findtext("displayname") or "", "text": html.unescape(quote.findtext("content") or "")[:4000]}
                text = title
            elif message_type == "system":
                content = root.findtext(".//revokemsg/content") or root.findtext(".//content")
                text = html.unescape(content or "").strip() or "系统消息"
            elif message_type == "voip":
                text = html.unescape(root.findtext(".//msg") or "").strip() or "音视频通话"
            elif title:
                text = "\n".join(x for x in (title, description, url) if x)
                if app_type == "6":
                    message_type = "file"
                elif app_type in ("62", "63"):
                    message_type = "system"
                metadata["card"] = {"title": title, "url": url,
                    "extension": root.findtext(".//fileext") or "", "size": root.findtext(".//totallen") or ""}
            else:
                text = ""
        except ET.ParseError:
            text = "" if message_type in ("image", "voice", "video", "sticker") else "[" + label + "]"
    if message_type == "system" and not sender:
        direction = "system"
    elif row.get("is_self") is True or (sender and sender in (str(account), str(self_id))):
        direction = "self"
    elif sender:
        direction = "other"
    else:
        direction = "unknown"
    if not text:
        text = "图片消息" if message_type == "image" else "[" + label + "]"
    external = f"{row.get('shard', '')}:{row.get('local_id', 0)}:{row.get('sort_seq', 0)}"
    return {"source": "wechat", "account_id": str(account), "conversation_id": chat,
            "conversation_name": chat_name or chat, "external_id": external,
            "sender_id": sender, "sender_name": sender_name or sender or ("系统" if direction == "system" else ""),
            "text": text[:30000], "sent_at": timestamp(row.get("create_time")),
            "message_type": message_type, "message_type_label": label,
            "message_type_code": str(row.get("type_code") or ""),
            "direction": direction, "is_self": direction == "self" if direction in ("self", "other") else None,
            "metadata": metadata}
    if media:
        result["media"] = media
        metadata["media_status"] = media.get("status")
    return result


def qq(event, names=None):
    if event.get("post_type") not in ("message", "message_sent"):
        return None
    if event.get("echo") is True:
        return None
    if event.get("message_id") is None or event.get("self_id") is None:
        return None
    sender = event.get("sender") or {}
    group = event.get("message_type") == "group"
    chat = ("group:" + str(event["group_id"])) if group else ("private:" + str(event.get("target_id") if event.get("post_type") == "message_sent" else event.get("user_id")))
    segments = event.get("message")
    parts, metadata = [], {"segments": []}
    kinds = set()
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
                kinds.add(kind)
                if len(metadata["segments"]) < 24:
                    metadata["segments"].append({"type": kind, "name": str(data.get("name") or data.get("file") or "")[:300],
                        "url": str(data.get("url") or "")[:2000] if kind == "image" else ""})
    else:
        parts = [str(event.get("raw_message") or segments or "")]
    return {"source": "qq", "account_id": str(event.get("self_id", "")), "conversation_id": chat,
            "conversation_name": (names or {}).get(chat, chat), "external_id": str(event.get("message_id", "")),
            "sender_id": str(event.get("user_id", "")), "sender_name": sender.get("card") or sender.get("nickname") or str(event.get("user_id", "")),
            "text": "".join(parts)[:30000], "sent_at": timestamp(event.get("time")),
            "message_type": "image" if kinds == {"image"} else "sticker" if kinds in ({"face"}, {"mface"}) else "mixed" if kinds - {"image", "face", "mface"} else "text", "metadata": metadata,
            "direction": "self" if event.get("post_type") == "message_sent" or str(event.get("user_id")) == str(event.get("self_id")) else "other",
            "is_self": event.get("post_type") == "message_sent" or str(event.get("user_id")) == str(event.get("self_id"))}
    return result
