"""从通知生成可编辑草稿；每个推断都交由用户确认。"""
import re
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

ZONE = ZoneInfo("Asia/Shanghai")

# 微信/QQ 文本表情码 → emoji；仅用于展示与草稿，原文保持不变。
EMOJI = {
    "微笑": "🙂", "撇嘴": "😕", "色": "😍", "发呆": "😮", "得意": "😎", "流泪": "😭",
    "害羞": "😊", "闭嘴": "🤐", "睡": "😴", "大哭": "😭", "尴尬": "😅", "发怒": "😡",
    "调皮": "😜", "呲牙": "😁", "惊讶": "😲", "难过": "🙁", "酷": "😎", "冷汗": "😓",
    "抓狂": "🤯", "吐": "🤮", "偷笑": "🤭", "愉快": "😄", "白眼": "🙄", "傲慢": "😤",
    "困": "😪", "惊恐": "😱", "憨笑": "🤣", "悠闲": "😌", "咒骂": "🤬", "疑问": "❓",
    "嘘": "🤫", "晕": "😵", "衰": "😩", "骷髅": "💀", "敲打": "🤕", "再见": "👋",
    "擦汗": "😅", "抠鼻": "😤", "鼓掌": "👏", "坏笑": "😏", "右哼哼": "哼", "鄙视": "😒",
    "委屈": "🥹", "快哭了": "😥", "阴险": "😈", "亲亲": "😘", "可怜": "🥺", "笑脸": "😄",
    "生病": "🤒", "脸红": "😳", "破涕为笑": "😂", "恐惧": "😨", "失望": "😞", "无语": "😶",
    "嘿哈": "😐", "捂脸": "🤦", "奸笑": "😌", "机智": "🧐", "皱眉": "🙁", "耶": "✌️",
    "吃瓜": "🍉", "加油": "💪", "汗": "😅", "天啊": "😱", "Emm": "😶", "社会社会": "😎",
    "旺柴": "🐶", "好的": "👌", "打脸": "🤡", "哇": "😮", "翻白眼": "🙄", "666": "👍",
    "让我看看": "👀", "叹气": "😮‍💨", "苦涩": "😖", "裂开": "💥", "嘴唇": "👄", "爱心": "❤️",
    "心碎": "💔", "拥抱": "🤗", "强": "👍", "弱": "👎", "握手": "🤝", "胜利": "✌️",
    "抱拳": "🙏", "勾引": "💋", "拳头": "✊", "OK": "👌", "合十": "🙏", "啤酒": "🍺",
    "咖啡": "☕", "蛋糕": "🎂", "玫瑰": "🌹", "凋谢": "🥀", "菜刀": "🔪", "炸弹": "💣",
    "便便": "💩", "月亮": "🌙", "太阳": "☀️", "庆祝": "🎉", "红包": "🧧", "礼物": "🎁",
    "鞭炮": "🧨", "烟花": "🎆", "猪头": "🐷", "闪电": "⚡", "旋风": "🌀", "礼物2": "🎁",
}
EMOJI_PATTERN = re.compile(r"\[((" + "|".join(sorted((re.escape(k) for k in EMOJI), key=len, reverse=True)) + r"))\]")


def pretty_text(text: str) -> str:
    """表情码转 emoji，并清理微信导出的控制字符。"""
    text = re.sub(r"[\x00-\x08\x0b-\x1f]", "", text or "")
    return EMOJI_PATTERN.sub(lambda m: EMOJI[m[1]], text)


def draft_title(text: str) -> str:
    """取第一条有信息量的行：跳过称呼（以冒号结尾）与纯表情行。"""
    for raw in (text or "").strip().splitlines():
        line = pretty_text(raw).strip()
        if not line:
            continue
        if re.fullmatch(r"[①-⑳\d、.\s/]*", line):
            continue
        line = line.lstrip("/｜|■●○·\\.\\s")
        if not line:
            continue
        if line.endswith(("：", ":")) and len(line) <= 16:
            continue
        if re.fullmatch(r"(?:[\U0001F300-\U0001FAFF\u2600-\u27BF~\s/]|[一二三四五六七八九十]|切|了|哈|嗯)+", line):
            continue
        return line[:100] or "新交件任务"
    return "新交件任务"


def extract(text: str, sent_at: str) -> dict:
    base = datetime.fromisoformat(sent_at.replace("Z", "+00:00")).astimezone(ZONE)
    requirements = []
    for ext in dict.fromkeys(re.findall(r"(?i)\b(pdf|docx?|xlsx?|pptx?|zip|rar|7z|py|cpp)\b", text)):
        ext = ext.lower()
        requirements.append({"label": f"{ext.upper()} 文件", "extensions": [ext], "min_count": 1})
    size = re.search(r"(?:不超过|小于|上限|≤|<)\s*(\d+(?:\.\d+)?)\s*(MB|GB|KB|M|G|K)", text, re.I)
    max_bytes = None
    if size:
        max_bytes = int(float(size[1]) * {"k": 1024, "m": 1024**2, "g": 1024**3}[size[2][0].lower()])
    naming = re.search(r"(?:文件名|命名)(?:称)?\s*(?:为|是|[:：])?\s*[“\"「]?([^\n。；;”\"」]{2,60})", text)
    urls = re.findall(r"https?://[^\s<>\"，。；）)]+", text)
    due = None
    notes = ["规则提取草稿，请核对截止时间、材料数量和命名要求。"]
    date = re.search(r"(?:(\d{4})[-年/])?(\d{1,2})[-月/](\d{1,2})日?", text)
    relative = re.search(r"今天|明天|后天", text)
    weekday = re.search(r"(下周|本周|这周|周|星期)([一二三四五六日天])", text)
    target = None
    try:
        if date:
            target = base.replace(year=int(date[1] or base.year), month=int(date[2]), day=int(date[3]))
        elif relative:
            target = base + timedelta(days={"今天": 0, "明天": 1, "后天": 2}[relative[0]])
        elif weekday:
            day = "一二三四五六日".index(weekday[2].replace("天", "日"))
            offset = day - base.weekday()
            if weekday[1] == "下周":
                offset += 7
            elif weekday[1] in ("周", "星期") and offset < 0:
                offset += 7
            target = base + timedelta(days=offset)
            notes.append("星期按消息发送日期推算，请确认是否发生延期。")
        if target:
            clock = re.search(r"(?:(上午|下午|晚上|中午)\s*)?(\d{1,2})[:：点时](\d{1,2})?", text)
            hour, minute = (23, 59)
            if clock:
                hour, minute = int(clock[2]), int(clock[3] or 0)
                if clock[1] in ("下午", "晚上") and hour < 12:
                    hour += 12
            else:
                notes.append("未注明具体时刻，暂填当天 23:59，请确认。")
            due = target.replace(hour=hour, minute=minute, second=0, microsecond=0).isoformat()
    except ValueError:
        notes.append("日期无法确定，请手动填写。")
    return {"title": draft_title(text), "description": text,
            "due_at": due, "requirements": requirements, "max_total_bytes": max_bytes,
            "naming_hint": naming[1].strip() if naming else "", "submit_url": urls[0] if urls else "",
            "notes": notes, "candidate": bool(re.search(r"提交|截止|报名|交作业|上交|交齐|交材料|报告", text))}
