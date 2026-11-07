"""桌面只读采集进程。凭据从 stdin 接收；消息先入本地持久队列再上传。"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import hashlib
import json
import os
import signal
import sqlite3
import sys
import threading
import time
from pathlib import Path

import httpx
import websockets

from .normalize import qq, wechat


def emit(**value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


class Queue:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.path = self.directory / "queue.sqlite3"
        with self.connect() as conn:
            conn.executescript("""PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY, identity TEXT UNIQUE, payload TEXT, sent INTEGER DEFAULT 0, error TEXT DEFAULT '');
            CREATE TABLE IF NOT EXISTS cursors(identity TEXT PRIMARY KEY,value INTEGER);
            """)

    @contextlib.contextmanager
    def connect(self):
        conn = sqlite3.connect(self.path, timeout=30)
        try:
            with conn:
                yield conn
        finally:
            conn.close()

    def add(self, payload, cursor=None):
        identity = json.dumps([payload[k] for k in ("source", "account_id", "conversation_id", "external_id")])
        with self.connect() as conn:
            conn.execute("INSERT OR IGNORE INTO outbox(identity,payload) VALUES(?,?)", (identity, json.dumps(payload, ensure_ascii=False)))
            if cursor:
                conn.execute("INSERT INTO cursors VALUES(?,?) ON CONFLICT(identity) DO UPDATE SET value=MAX(value,excluded.value)", cursor)

    def cursor(self, identity, initial=None):
        with self.connect() as conn:
            row = conn.execute("SELECT value FROM cursors WHERE identity=?", (identity,)).fetchone()
            if not row and initial is not None:
                conn.execute("INSERT OR IGNORE INTO cursors VALUES(?,?)", (identity, initial))
        return row[0] if row else initial

    def seed(self, payload):
        identity = json.dumps([payload[k] for k in ("source", "account_id", "conversation_id", "external_id")])
        with self.connect() as conn:
            conn.execute("INSERT OR IGNORE INTO outbox(identity,payload,sent) VALUES(?,'',1)", (identity,))

    def advance(self, identity, value):
        with self.connect() as conn:
            conn.execute("INSERT INTO cursors VALUES(?,?) ON CONFLICT(identity) DO UPDATE SET value=MAX(value,excluded.value)", (identity, value))

    def set_cursor(self, identity, value):
        with self.connect() as conn:
            conn.execute("INSERT OR REPLACE INTO cursors VALUES(?,?)", (identity, value))

    def pending(self):
        with self.connect() as conn:
            return conn.execute("SELECT id,payload FROM outbox WHERE sent=0 ORDER BY id LIMIT 100").fetchall()

    def pending_count(self):
        with self.connect() as conn:
            return conn.execute("SELECT COUNT(*) FROM outbox WHERE sent=0").fetchone()[0]

    def acknowledge(self, identity):
        with self.connect() as conn:
            conn.execute("UPDATE outbox SET sent=1,error='' WHERE id=?", (identity,))
            # 已上传事件保留去重键，但清除正文，避免本地队列无限保存历史内容。
            conn.execute("UPDATE outbox SET payload='' WHERE id=?", (identity,))


def wechat_database(config):
    # 导入 db 模块，不初始化 WeChatGUI/UIA，不改变微信窗口和登录状态。
    from .wechat_reader import open_database
    return open_database(config)


def list_wechat(config):
    with contextlib.redirect_stdout(sys.stderr):
        db = wechat_database(config)
        sessions = db.get_sessions(limit=500)
        result = [{"id": x["username"], "name": db.get_nickname(x["username"]) or x["username"], "source": "wechat"} for x in sessions]
    emit(account=db.account, conversations=result)


async def list_qq(config):
    base = config.get("qq_http_url", "http://127.0.0.1:3000").rstrip("/")
    headers = {"Authorization": "Bearer " + config["qq_token"]} if config.get("qq_token") else {}
    async with httpx.AsyncClient(timeout=20, headers=headers, follow_redirects=False) as client:
        async def action(name):
            response = await client.post(base + "/" + name, json={})
            response.raise_for_status()
            obj = response.json()
            if obj.get("retcode") != 0:
                raise ValueError("SnowLuma API 返回失败，请检查 Token 与端口")
            return obj.get("data")
        account = await action("get_login_info")
        groups = await action("get_group_list")
        friends = await action("get_friend_list")
    emit(account=str(account["user_id"]), conversations=[
        *[{"id": "group:" + str(g["group_id"]), "name": g.get("group_name") or str(g["group_id"]), "source": "qq"} for g in groups],
        *[{"id": "private:" + str(g["user_id"]), "name": g.get("remark") or g.get("nickname") or str(g["user_id"]), "source": "qq"} for g in friends],
    ])


def wechat_loop(config, queue, stop):
    if not config.get("wechat_chats"):
        return
    while not stop.is_set():
        db=None
        stage="open-database"
        try:
            emit(source="wechat",state="starting",message="正在打开微信数据库，初始化独立读取缓存")
            with contextlib.redirect_stdout(sys.stderr):
                db = wechat_database(config)
            if config.get("wechat_account") and db.account != config["wechat_account"]:
                raise ValueError("微信登录账号发生变化")
            names = {}
            stage="initialize-conversations"
            for chat in config["wechat_chats"]:
                names[chat] = db.get_nickname(chat) or chat
                key = "wechat:" + db.account + ":" + chat
                if queue.cursor(key) is None:
                    latest = db.get_messages(chat, limit=100)
                    start = int(latest[0]["sort_seq"]) if latest else 0
                    for row in latest:
                        if int(row["sort_seq"]) == start:
                            queue.seed(wechat(row, db.account, chat, names[chat]))
                    queue.cursor(key, start)
            emit(source="wechat", state="connected", account=db.account,message="微信会话已连接，正在监听新消息")
            stage="poll-messages"
            heartbeat=0
            while not stop.is_set():
                for chat in config["wechat_chats"]:
                    key = "wechat:" + db.account + ":" + chat
                    since = queue.cursor(key) or 0
                    rows = db.get_new_messages(chat, since_seq=max(0, since - 1), limit=5000)
                    for row in rows:
                        sender = row.get("sender_username") or ""
                        name = db.get_nickname(sender) if sender else ""
                        payload = wechat(row, db.account, chat, names[chat], name)
                        keywords = [s.strip() for s in config.get("capture_keywords", "").split(",") if s.strip()]
                        if keywords and not any(word in payload["text"] for word in keywords):
                            queue.seed(payload)
                            queue.advance(key, int(row["sort_seq"]))
                        else:
                            queue.add(payload, (key, int(row["sort_seq"])))
                if time.monotonic()-heartbeat>=10:
                    emit(source="wechat",state="connected",message="正在监听所选微信会话",chat_count=len(config["wechat_chats"]),last_scan_at=time.time())
                    heartbeat=time.monotonic()
                stop.wait(1)
        except Exception as exc:
            from .wechat_reader import record_error
            diagnostic=record_error(config,exc,stage)
            if db and hasattr(db,"close"):db.close()
            import gc
            gc.collect()
            detail="解密缓存被占用或无写入权限" if isinstance(exc,PermissionError) and diagnostic.get("file") and "wechat-cache" in diagnostic["file"] else "微信读取权限不足" if isinstance(exc,PermissionError) else "微信读取暂不可用"
            code="WinError "+str(diagnostic["winerror"]) if diagnostic.get("winerror") else type(exc).__name__
            emit(source="wechat", state="error", message=f"{detail}（{code}），读取位置已保留，10 秒后重试",diagnostic=diagnostic)
            stop.wait(10)


async def qq_loop(config, queue, stopped):
    allowed = set(config.get("qq_chats") or [])
    if not allowed:
        return
    headers = {"Authorization": "Bearer " + config["qq_token"]} if config.get("qq_token") else {}
    async def recover(client):
        base = config.get("qq_http_url", "http://127.0.0.1:3000").rstrip("/")
        login_response = await client.post(base + "/get_login_info", json={})
        login_response.raise_for_status()
        login = login_response.json()
        if login.get("retcode") != 0:
            raise ValueError("无法读取 QQ 账号")
        account = str(login["data"]["user_id"])
        if config.get("qq_account") and account != str(config["qq_account"]):
            raise ValueError("QQ 账号已变化，请重新选择会话")
        for chat in allowed:
            kind, chat_id = chat.split(":", 1)
            start_key = "qq-start:" + account + ":" + chat
            anchor_key = "qq-anchor:" + account + ":" + chat
            started = queue.cursor(start_key, int(time.time()))
            anchor = queue.cursor(anchor_key) or 0
            action = "get_group_msg_history" if kind == "group" else "get_friend_msg_history"
            for _ in range(20):
                response = await client.post(base + "/" + action, json={"group_id" if kind == "group" else "user_id": int(chat_id), "message_id": anchor, "count": 100, "reverse_order": False})
                response.raise_for_status()
                result = response.json()
                if result.get("retcode") != 0:
                    emit(source="qq", state="warning", message="部分 QQ 历史暂不可读取，实时接收仍继续")
                    break
                rows = result.get("data", {}).get("messages") or []
                rows.sort(key=lambda item: float(item.get("time") or 0))
                previous_anchor = anchor
                for item in rows:
                    item = dict(item)
                    item.update(self_id=account, post_type="message", message_type=kind)
                    if kind == "group":
                        item["group_id"] = int(chat_id)
                    elif str(item.get("user_id")) == account:
                        item.update(post_type="message_sent", target_id=int(chat_id))
                    payload = qq(item, config.get("conversation_names"))
                    if payload and float(item.get("time") or 0) >= started:
                        accept(payload)
                    if item.get("message_id") is not None:
                        anchor = int(item["message_id"])
                if anchor:
                    queue.set_cursor(anchor_key, anchor)
                if len(rows) < 100 or anchor == previous_anchor:
                    break
            else:
                emit(source="qq", state="warning", message="QQ 积压超过本轮补读上限，下次连接将继续补读")

    def accept(payload):
        keywords = [s.strip() for s in config.get("capture_keywords", "").split(",") if s.strip()]
        if not keywords or any(word in payload["text"] for word in keywords):
            queue.add(payload)

    while not stopped.is_set():
        try:
            async with websockets.connect(config.get("qq_ws_url", "ws://127.0.0.1:3001"), extra_headers=headers, max_size=2**20, ping_interval=20) as ws:
                async with httpx.AsyncClient(headers=headers, timeout=20, follow_redirects=False) as client:
                    try:
                        await recover(client)
                    except (httpx.HTTPError, ValueError, KeyError, TypeError):
                        emit(source="qq", state="warning", message="历史补读暂不可用；实时接收继续，重连时会再尝试补读")
                emit(source="qq", state="connected")
                async for raw in ws:
                    event = json.loads(raw)
                    payload = qq(event, config.get("conversation_names"))
                    if payload and payload["conversation_id"] in allowed:
                        if config.get("qq_account") and payload["account_id"] != str(config["qq_account"]):
                            emit(source="qq", state="error", message="SnowLuma 登录账号已变化，请重新读取并选择会话")
                            continue
                        accept(payload)
                        queue.set_cursor("qq-anchor:" + payload["account_id"] + ":" + payload["conversation_id"], int(event["message_id"]))
                    if stopped.is_set():
                        return
        except (OSError, ValueError, websockets.WebSocketException):
            emit(source="qq", state="reconnecting", message="SnowLuma 连接中断，正在重连")
            await asyncio.sleep(3)


async def uploader(config, queue, stopped):
    base = config["server_url"].rstrip("/")
    headers = {"Authorization": "Bearer " + config["server_token"]}
    async with httpx.AsyncClient(headers=headers, timeout=30, follow_redirects=False) as client:
        while not stopped.is_set():
            rows = queue.pending()
            try:
                for identity, body in rows:
                    result = await client.post(base + "/api/messages", content=body.encode(), headers={"Content-Type": "application/json"})
                    if result.status_code in (200, 201):
                        queue.acknowledge(identity)
                    elif result.status_code == 401:
                        emit(source="sync", state="unauthorized", message="登录过期，请重新登录后启动采集")
                        await asyncio.sleep(10)
                        break
                    else:
                        # 失败保留队列；界面可见，不静默丢弃。
                        emit(source="sync", state="error", message=f"上传失败 HTTP {result.status_code}，消息保留在本地队列")
                        await asyncio.sleep(5)
                        break
                else:
                    emit(source="sync", state="connected", message="采集队列已连接服务端")
                emit(source="queue", state="pending", count=queue.pending_count())
            except httpx.HTTPError:
                emit(source="sync", state="offline", message="服务端暂不可用，消息已保存在本地")
            await asyncio.sleep(2)


async def run(config, state_dir):
    profile = hashlib.sha256((config["server_url"].rstrip("/") + "|" + config["user_id"]).encode()).hexdigest()[:24]
    queue = Queue(Path(state_dir) / profile)
    stopped = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stopped.set())
    worker = threading.Thread(target=wechat_loop, args=(config, queue, stopped), daemon=True)
    worker.start()
    tasks = [asyncio.create_task(qq_loop(config, queue, stopped)), asyncio.create_task(uploader(config, queue, stopped))]
    try:
        while not stopped.is_set():
            await asyncio.sleep(0.5)
            for task in tasks:
                if task.done() and task.exception():
                    raise task.exception()
    finally:
        stopped.set()
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        worker.join(timeout=5)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["run", "list-wechat", "list-qq"])
    parser.add_argument("--state-dir", default="data/collector")
    args = parser.parse_args()
    config = json.loads(sys.stdin.readline())
    config["_wechat_cache_root"]=str(Path(args.state_dir).resolve()/"wechat-cache")
    config["_wechat_purpose"]="live" if args.command=="run" else "list"
    try:
        if args.command == "list-wechat":
            list_wechat(config)
        elif args.command == "list-qq":
            asyncio.run(list_qq(config))
        else:
            asyncio.run(run(config, args.state_dir))
    except Exception as exc:
        if args.command=="list-wechat":
            from .wechat_reader import record_error
            record_error(config,exc,"list-conversations")
        emit(state="error", message=f"采集进程出错（{type(exc).__name__}），请检查 Python 依赖、登录状态与连接配置")
        raise SystemExit(1)


if __name__ == "__main__":
    main()
