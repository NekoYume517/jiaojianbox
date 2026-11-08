"""交件箱：多用户、版本校验、持久事件流和附件存储。"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import io
import json
import os
import re
import secrets
import sqlite3
import time
import uuid
import zipfile
import tempfile
from collections import defaultdict, deque
from contextlib import contextmanager, asynccontextmanager
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Literal

from fastapi import Depends, FastAPI, File, Header, HTTPException, Query, Request, UploadFile, WebSocket
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field, field_validator
from starlette.websockets import WebSocketDisconnect
from starlette.background import BackgroundTask
from starlette.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .stats import summarize
from .accounts import Accounts
from .transfer import install_transfer
from .extract import extract
from .llm import LlmConfig, analyze, endpoint, suggest_file
from .file_content import read_text
from .vision import IMAGE_EXTENSIONS,prepare_image
from cryptography.fernet import Fernet
import httpx


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Credentials(BaseModel):
    username: str = Field(default='', max_length=254)
    email: str = Field(default='', max_length=254)
    password: str = Field(min_length=10, max_length=256)
    invitation_code: str = Field(default='', max_length=128)


class Requirement(BaseModel):
    label: str = Field(min_length=1, max_length=100)
    extensions: list[str] = Field(default_factory=list, max_length=12)
    min_count: int = Field(default=1, ge=1, le=50)

    @field_validator("extensions")
    @classmethod
    def normalize(cls, values):
        if any(not re.fullmatch(r"\.?[a-zA-Z0-9]{1,10}", s) for s in values):
            raise ValueError("文件扩展名无效")
        return list(dict.fromkeys(s.lower().lstrip(".") for s in values))


class TaskInput(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=30000)
    due_at: str | None = None
    status: Literal["collecting", "ready", "submitted", "archived"] = "collecting"
    urgency: Literal["high", "normal", "low"] | None = Field(default=None)
    reminders: list[str] = Field(default_factory=list, max_length=5)
    requirements: list[Requirement] = Field(default_factory=list, max_length=50)
    max_total_bytes: int | None = Field(default=None, gt=0, le=10**12)
    naming_hint: str = Field(default="", max_length=300)
    filename_pattern: str = Field(default="", max_length=200)
    submit_url: str = Field(default="", max_length=2000)
    source_message_id: str | None = None
    version: int = Field(default=0, ge=0)
    client_id: str | None = Field(default=None, max_length=100)

    @field_validator("due_at")
    @classmethod
    def date_valid(cls, value):
        if value:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if not parsed.tzinfo:
                raise ValueError("截止时间必须包含时区")
        return value

    @field_validator("reminders")
    @classmethod
    def reminders_valid(cls, values):
        for value in values:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if not parsed.tzinfo:
                raise ValueError("提醒时间必须包含时区")
        return list(dict.fromkeys(values))[:5]

    @field_validator("submit_url")
    @classmethod
    def url_valid(cls, value):
        if value and not value.startswith(("https://", "http://")):
            raise ValueError("提交入口必须为 http(s) 链接")
        return value

    @field_validator("filename_pattern")
    @classmethod
    def pattern_valid(cls, value):
        # 使用简单通配符，避免执行不受控正则表达式。
        if any(c in value for c in "/\\\x00"):
            raise ValueError("命名规则仅支持文件名通配符")
        return value


class MessageInput(BaseModel):
    source: Literal["qq", "wechat", "manual"]
    account_id: str = Field(min_length=1, max_length=150)
    conversation_id: str = Field(min_length=1, max_length=200)
    conversation_name: str = Field(default="", max_length=200)
    external_id: str = Field(min_length=1, max_length=200)
    sender_id: str = Field(default="", max_length=200)
    sender_name: str = Field(default="", max_length=200)
    text: str = Field(default="", max_length=30000)
    sent_at: str
    message_type: str = Field(default="text", max_length=50)
    metadata: dict = Field(default_factory=dict)

    @field_validator("sent_at")
    @classmethod
    def timestamp_valid(cls, value):
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if not parsed.tzinfo:
            raise ValueError("消息时间必须包含时区")
        return parsed.isoformat()


class AnalyzeInput(BaseModel):
    message_id: str
    context_count: int | None = Field(default=None, ge=0, le=50)
    context_ids: list[str] | None = Field(default=None, max_length=50)


class TriageInput(BaseModel):
    state: Literal["unread", "ignored", "saved"]


class FileKindInput(BaseModel):
    kind: Literal["material","receipt"]
    version: int = Field(ge=1)


class RenameInput(BaseModel):
    name: str = Field(min_length=1, max_length=180)
    version: int = Field(ge=1)


class DevicePoll(BaseModel):
    device_code: str = Field(min_length=20,max_length=200)

class DeviceApproval(BaseModel):
    user_code: str = Field(min_length=8,max_length=20)
    approve: bool

class ShelfAssignment(BaseModel):
    task_id: str | None = None
    category: Literal['inbox','reference','other','material','receipt'] = 'inbox'
    version: int | None = Field(default=None,ge=1)

class ShelfAnalysis(BaseModel):
    auto_assign: bool = True


def safe_filename(value):
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", value)[:180].strip(". ") or "未命名文件"
    return "_" + name if re.match(r"(?i)^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", name) else name


def create_app(data_dir: str | Path | None = None) -> FastAPI:
    root = Path(data_dir or os.environ.get("JJB_DATA_DIR", "data")).resolve()
    root.mkdir(parents=True, exist_ok=True)
    blobs = root / "files"
    blobs.mkdir(exist_ok=True)
    database = root / "jiaojianbox.sqlite3"
    max_upload = int(os.environ.get("JJB_MAX_UPLOAD_MB", "50")) * 1024**2
    master = os.environ.get("JJB_MASTER_KEY")
    key_file = root / "master.key"
    if not master:
        if not key_file.exists():
            try:
                with key_file.open("xb") as handle:
                    handle.write(Fernet.generate_key())
                key_file.chmod(0o600)
            except FileExistsError:
                pass
        master = key_file.read_bytes()
    cipher = Fernet(master)

    @contextmanager
    def db(write=False):
        conn = sqlite3.connect(database, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        try:
            if write:
                conn.execute("BEGIN IMMEDIATE")
            yield conn
            if write:
                conn.commit()
        except BaseException:
            conn.rollback()
            raise
        finally:
            conn.close()

    with db() as conn:
        conn.executescript("""
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT UNIQUE COLLATE NOCASE, salt TEXT, password TEXT);
        CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), expires REAL);
        CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), dedup TEXT, payload TEXT, created_at TEXT, UNIQUE(user_id,dedup));
        CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), version INTEGER, client_id TEXT, payload TEXT, UNIQUE(user_id,client_id));
        CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE, name TEXT, size INTEGER, sha256 TEXT, kind TEXT);
        CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT REFERENCES users(id), kind TEXT, entity_id TEXT, at TEXT);
        CREATE INDEX IF NOT EXISTS ix_events_owner ON events(user_id,seq);
        CREATE INDEX IF NOT EXISTS ix_messages_owner ON messages(user_id,created_at);
        CREATE INDEX IF NOT EXISTS ix_tasks_owner ON tasks(user_id);
        CREATE INDEX IF NOT EXISTS ix_files_task ON attachments(user_id,task_id);
        CREATE TABLE IF NOT EXISTS llm_settings(user_id TEXT PRIMARY KEY REFERENCES users(id), payload TEXT, secret TEXT);
        CREATE TABLE IF NOT EXISTS llm_calls(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),kind TEXT,model TEXT,status TEXT,started_at TEXT,duration_ms REAL,first_token_ms REAL,prompt_tokens INTEGER,completion_tokens INTEGER,total_tokens INTEGER,http_status INTEGER,usage_reported INTEGER,streamed INTEGER);
        CREATE INDEX IF NOT EXISTS llm_calls_owner_time ON llm_calls(user_id,started_at);
        CREATE TABLE IF NOT EXISTS analysis_jobs(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, message_id TEXT UNIQUE, state TEXT DEFAULT 'queued', attempts INTEGER DEFAULT 0, next_at REAL DEFAULT 0, error TEXT DEFAULT '');
        CREATE TABLE IF NOT EXISTS device_auth(device_hash TEXT PRIMARY KEY, user_code TEXT UNIQUE, expires REAL, state TEXT DEFAULT 'pending', user_id TEXT, token TEXT);
        CREATE TABLE IF NOT EXISTS shelf_meta(file_id TEXT PRIMARY KEY REFERENCES attachments(id) ON DELETE CASCADE, user_id TEXT REFERENCES users(id), category TEXT, suggestion TEXT, created_at TEXT, version INTEGER DEFAULT 1);
        """)
        if 'streamed' not in {r[1] for r in conn.execute('PRAGMA table_info(llm_calls)')}:
            conn.execute('ALTER TABLE llm_calls ADD COLUMN streamed INTEGER');conn.commit()
        if 'version' not in {r[1] for r in conn.execute('PRAGMA table_info(shelf_meta)')}:
            conn.execute('ALTER TABLE shelf_meta ADD COLUMN version INTEGER DEFAULT 1')
            conn.commit()

    @asynccontextmanager
    async def lifespan(application):
        with db(True) as conn:
            conn.execute("UPDATE analysis_jobs SET state='queued' WHERE state='running'")
        worker = asyncio.create_task(analyze_worker())
        yield
        worker.cancel()
        await asyncio.gather(worker, return_exceptions=True)

    app = FastAPI(title="交件箱 API", version="0.5.0", docs_url="/docs", lifespan=lifespan)
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET", "POST", "PUT", "DELETE"], allow_headers=["Authorization", "Content-Type"])
    app.state.database = database
    attempts = defaultdict(deque)

    def limit_auth(request):
        key = request.client.host if request.client else "unknown"
        queue = attempts[key]
        while queue and queue[0] < time.monotonic() - 60:
            queue.popleft()
        if len(queue) >= 20:
            raise HTTPException(429, "尝试过于频繁，请稍后重试")
        queue.append(time.monotonic())

    def event(conn, user, kind, entity):
        conn.execute("INSERT INTO events(user_id,kind,entity_id,at) VALUES(?,?,?,?)", (user, kind, entity, now()))

    def user_for_token(token):
        if not token:
            raise HTTPException(401, "请登录")
        with db() as conn:
            row = conn.execute("SELECT user_id FROM sessions WHERE token_hash=? AND expires>?", (hashlib.sha256(token.encode()).hexdigest(), time.time())).fetchone()
        if not row:
            raise HTTPException(401, "登录已过期，请重新登录")
        return row[0]

    def owner(authorization: str = Header(default="")):
        return user_for_token(authorization.removeprefix("Bearer ") if authorization.startswith("Bearer ") else "")

    accounts = Accounts(db, cipher)
    accounts.install(app, owner, limit_auth)
    install_transfer(app, db, owner, blobs, event, now, cipher)

    def task_row(conn, user, task_id):
        row = conn.execute("SELECT * FROM tasks WHERE id=? AND user_id=?", (task_id, user)).fetchone()
        if not row:
            raise HTTPException(404, "任务不存在")
        return row

    def task_object(conn, row):
        obj = json.loads(row["payload"])
        obj["attachments"] = [dict(x) for x in conn.execute("SELECT id,name,size,sha256,kind FROM attachments WHERE task_id=? ORDER BY rowid", (row["id"],))]
        return obj

    def update_payload(conn, user, task_id, payload):
        payload["updated_at"] = now()
        conn.execute("UPDATE tasks SET version=?,payload=? WHERE id=? AND user_id=?", (payload["version"], json.dumps(payload, ensure_ascii=False), task_id, user))
        event(conn, user, "task.upsert", task_id)

    def settings_for(user):
        with db() as conn:
            row = conn.execute("SELECT * FROM llm_settings WHERE user_id=?", (user,)).fetchone()
        if not row:
            return LlmConfig().model_dump(exclude={"api_key"}), ""
        return json.loads(row["payload"]), cipher.decrypt(row["secret"].encode()).decode() if row["secret"] else ""

    def record_llm(user,kind,config,started,result=None,error=None,metrics_override=None):
        metrics=metrics_override if metrics_override is not None else (result or {}).get('performance',{}) if error is None else getattr(error,'metrics',{})
        code=metrics.get('http_status')
        status='success' if error is None else 'http_error' if code and code>=400 else 'timeout' if isinstance(error,(httpx.TimeoutException,TimeoutError)) else 'cancelled' if isinstance(error,asyncio.CancelledError) else 'invalid_output' if isinstance(error,ValueError) else 'connection_error'
        with db(True) as conn:
            conn.execute('INSERT INTO llm_calls(id,user_id,kind,model,status,started_at,duration_ms,first_token_ms,prompt_tokens,completion_tokens,total_tokens,http_status,usage_reported,streamed) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',(str(uuid.uuid4()),user,kind,config['model'],status,started[0],metrics.get('elapsed_ms',round((time.monotonic()-started[1])*1000)),metrics.get('first_token_ms'),metrics.get('prompt_tokens'),metrics.get('completion_tokens'),metrics.get('total_tokens'),code,int(bool(metrics.get('usage_reported'))),int(metrics['streamed']) if 'streamed' in metrics else None))

    @app.get('/api/statistics')
    def statistics(days:int=Query(default=30,ge=1,le=365),user=Depends(owner)):
        local=timezone(timedelta(hours=8));start=(datetime.now(local).date()-timedelta(days=days-1));cutoff=datetime.combine(start,datetime.min.time(),tzinfo=local).astimezone(timezone.utc).isoformat()
        with db() as conn:rows=[dict(r) for r in conn.execute('SELECT kind,model,status,started_at,duration_ms,CASE WHEN streamed=1 THEN first_token_ms ELSE NULL END AS first_token_ms,prompt_tokens,completion_tokens,total_tokens,http_status,usage_reported,streamed FROM llm_calls WHERE user_id=? AND started_at>=? ORDER BY started_at DESC',(user,cutoff))]
        return summarize(rows,days)

    def readonly_tool_executor(user):
        """LLM 只读工具：白名单分发，只能查看任务/消息/时间，不能修改。"""
        def execute(name, args):
            with db() as conn:
                if name == "list_recent_tasks":
                    limit = max(1, min(int(args.get("limit") or 30), 100))
                    rows = conn.execute("SELECT payload FROM tasks WHERE user_id=? ORDER BY rowid DESC LIMIT ?", (user, limit)).fetchall()
                    tasks = [json.loads(r[0]) for r in rows]
                    return tool_result_tasks(tasks)
                if name == "get_task_detail":
                    row = conn.execute("SELECT payload FROM tasks WHERE id=? AND user_id=?", (str(args.get("task_id") or ""), user)).fetchone()
                    if not row:
                        return {"error": "任务不存在"}
                    task = json.loads(row[0])
                    return {"id": task["id"], "title": task["title"], "description": task.get("description", ""),
                            "status": task["status"], "due_at": task.get("due_at"), "urgency": task.get("urgency") or "normal",
                            "requirements": task.get("requirements", []), "naming_hint": task.get("naming_hint", ""),
                            "submit_url": task.get("submit_url", ""), "created_at": task.get("created_at")}
                if name == "get_recent_messages":
                    conversation = str(args.get("conversation") or "")
                    limit = max(1, min(int(args.get("limit") or 10), 30))
                    rows = conn.execute("""SELECT payload FROM messages WHERE user_id=? AND (json_extract(payload,'$.conversation_name')=? OR json_extract(payload,'$.conversation_id')=?)
                        ORDER BY rowid DESC LIMIT ?""", (user, conversation, conversation, limit)).fetchall()
                    return {"messages": [{"from": json.loads(r[0]).get("sender_name") or "", "sent_at": json.loads(r[0]).get("sent_at"),
                                          "text": (json.loads(r[0]).get("text") or "")[:500]} for r in rows]}
                if name == "get_now":
                    local = datetime.now(timezone(timedelta(hours=8)))
                    return {"now": local.isoformat(), "timezone": "Asia/Shanghai", "weekday": ["周一", "周二", "周三", "周四", "周五", "周六", "周日"][local.weekday()]}
            return {"error": "未知工具"}
        return execute

    async def run_analysis(user, body, progress=None):
        config, key = settings_for(user)
        if not config["base_url"] or not config["model"]:
            raise HTTPException(400, "请先在设置中填写 LLM API 地址和模型")
        with db() as conn:
            row = conn.execute("SELECT payload FROM messages WHERE id=? AND user_id=?", (body.message_id, user)).fetchone()
            if not row:
                raise HTTPException(404, "消息不存在")
            target = json.loads(row[0])
            count = body.context_count if body.context_count is not None else config["context_count"]
            if body.context_ids is not None:
                contexts = []
                for identity in dict.fromkeys(body.context_ids):
                    if identity == body.message_id:
                        continue
                    r = conn.execute("SELECT payload FROM messages WHERE id=? AND user_id=?", (identity, user)).fetchone()
                    if not r:
                        raise HTTPException(404, "所选上下文不存在")
                    contexts.append(json.loads(r[0]))
            else:
                contexts = [json.loads(r[0]) for r in conn.execute("""SELECT payload FROM messages
                    WHERE user_id=? AND id<>? AND json_extract(payload,'$.source')=?
                    AND json_extract(payload,'$.account_id')=? AND json_extract(payload,'$.conversation_id')=?
                    AND julianday(json_extract(payload,'$.sent_at'))<=julianday(?)
                    ORDER BY julianday(json_extract(payload,'$.sent_at')) DESC,rowid DESC LIMIT ?""",
                    (user, body.message_id, target["source"], target["account_id"], target["conversation_id"], target["sent_at"], count))]
                contexts.reverse()
        started_llm=(now(),time.monotonic());result=None
        try:
            if progress:await progress({'stage':'context','context_count':len(contexts),'target_characters':len(target.get('text','')),'context_characters':sum(len(m.get('text','')) for m in contexts)})
            user_tasks=[]
            with db() as conn:
                for r in conn.execute("SELECT payload FROM tasks WHERE user_id=? ORDER BY rowid DESC LIMIT 40", (user,)):
                    task_obj = json.loads(r[0])
                    conversation = ""
                    if task_obj.get("source_message_id"):
                        msg_row = conn.execute("SELECT payload FROM messages WHERE id=? AND user_id=?", (task_obj["source_message_id"], user)).fetchone()
                        if msg_row:
                            conversation = json.loads(msg_row[0]).get("conversation_name") or ""
                    user_tasks.append(task_obj | {"conversation": conversation})
            result = await analyze(config, [target], contexts, key, progress=progress, user_tasks=user_tasks, tool_executor=readonly_tool_executor(user))
            # 再通过任务数据契约校验模型推断，避免不合法日期/链接进入任务。
            validated = TaskInput.model_validate({**result, "title": result.get("title") or target["draft"]["title"]})
            for k in ("due_at", "requirements", "max_total_bytes", "naming_hint", "submit_url", "urgency", "reminders"):
                result[k] = validated.model_dump()[k]
        except asyncio.CancelledError as exc:
            record_llm(user,"notification",config,started_llm,error=exc);raise
        except (ValueError, httpx.HTTPError) as exc:
            record_llm(user,"notification",config,started_llm,error=exc,metrics_override=result.get("performance",{}) if result else None)
            raise HTTPException(502, "LLM 分析失败：请检查接口、模型及输出格式后重试")
        record_llm(user,"notification",config,started_llm,result=result)
        result |= {"at": now(), "context_ids": [m["id"] for m in contexts], "model": config["model"]}
        created_task = None
        if config.get("auto_task") and result.get("classification") == "actionable" and result.get("confidence", 0) >= .8:
            with db(True) as conn:
                current = conn.execute("SELECT payload FROM messages WHERE id=? AND user_id=?", (body.message_id, user)).fetchone()
                if current:
                    obj = json.loads(current[0])
                    draft = obj.get("draft") or {}
                    title = (result.get("title") or draft.get("title") or "").strip()[:200]
                    if title:
                        client_id = "auto-" + body.message_id
                        old = conn.execute("SELECT * FROM tasks WHERE user_id=? AND client_id=?", (user, client_id)).fetchone()
                        if old:
                            created_task = json.loads(old["payload"]) | {"attachments": []}
                        else:
                            # 同会话短窗口内容重复的通知（如重发）不重复建任务。
                            window = time.time() - 3600
                            recent = conn.execute("""SELECT payload FROM tasks WHERE user_id=? AND client_id LIKE 'auto-%'
                                AND json_extract(payload,'$.created_at')>=? AND json_extract(payload,'$.title')=?""",
                                (user, datetime.fromtimestamp(window, timezone.utc).isoformat(), title)).fetchone()
                            if recent:
                                created_task = json.loads(recent[0]) | {"attachments": [], "duplicate_of": json.loads(recent[0])["id"]}
                            else:
                                task = TaskInput(title=title, description=draft.get("description") or obj.get("text", ""),
                                    due_at=result.get("due_at"), requirements=result.get("requirements") or [],
                                    urgency=result.get("urgency") or "normal", reminders=result.get("reminder_suggestions") or [],
                                    max_total_bytes=result.get("max_total_bytes"), naming_hint=result.get("naming_hint") or "",
                                    filename_pattern="", submit_url=result.get("submit_url") or "",
                                    source_message_id=body.message_id, client_id=client_id).model_dump()
                                task |= {"id": str(uuid.uuid4()), "version": 1, "created_at": now(), "updated_at": now()}
                                conn.execute("INSERT INTO tasks VALUES(?,?,?,?,?)", (task["id"], user, 1, client_id, json.dumps(task, ensure_ascii=False)))
                                event(conn, user, "task.upsert", task["id"])
                                created_task = task | {"attachments": []}
        with db(True) as conn:
            current = conn.execute("SELECT payload FROM messages WHERE id=? AND user_id=?", (body.message_id, user)).fetchone()
            if not current:
                raise HTTPException(404, "消息不存在")
            obj = json.loads(current[0])
            obj["analysis"] = result
            obj.pop("analysis_error", None)
            if created_task:
                obj["auto_task_id"] = created_task["id"]
                if created_task.get("duplicate_of"):
                    obj["auto_task_duplicate"] = True
            conn.execute("UPDATE messages SET payload=? WHERE id=? AND user_id=?", (json.dumps(obj, ensure_ascii=False), body.message_id, user))
            event(conn, user, "message.upsert", body.message_id)
        if created_task:
            result["auto_created_task"] = created_task
        return result

    async def analyze_worker():
        while True:
            with db(True) as conn:
                row = conn.execute("SELECT * FROM analysis_jobs WHERE state='queued' AND next_at<=? ORDER BY id LIMIT 1", (time.time(),)).fetchone()
                if row:
                    conn.execute("UPDATE analysis_jobs SET state='running',attempts=attempts+1 WHERE id=?", (row["id"],))
            if not row:
                await asyncio.sleep(1)
                continue
            try:
                result = await run_analysis(row["user_id"], AnalyzeInput(message_id=row["message_id"]))
                state, error, retry = "done", "", 0
            except (HTTPException, ValueError, httpx.HTTPError):
                state, error, retry = ("failed" if row["attempts"] >= 2 else "queued"), "自动分析失败，将在消息页显示重试入口", time.time() + 20
            with db(True) as conn:
                conn.execute("UPDATE analysis_jobs SET state=?,error=?,next_at=? WHERE id=?", (state, error, retry, row["id"]))
                if error:
                    message_row = conn.execute("SELECT payload FROM messages WHERE id=? AND user_id=?", (row["message_id"], row["user_id"])).fetchone()
                    if message_row:
                        obj = json.loads(message_row[0]) | {"analysis_error": error}
                        conn.execute("UPDATE messages SET payload=? WHERE id=?", (json.dumps(obj, ensure_ascii=False), row["message_id"]))
                        event(conn, row["user_id"], "message.upsert", row["message_id"])

    @app.get("/api/settings/llm")
    def read_llm(user=Depends(owner)):
        config, key = settings_for(user)
        return config | {"has_key": bool(key)}

    @app.put("/api/settings/llm")
    def save_llm(body: LlmConfig, user=Depends(owner)):
        if body.base_url:
            try:
                endpoint(body.base_url)
            except ValueError as exc:
                raise HTTPException(422, str(exc))
        _, previous_key = settings_for(user)
        key = body.api_key if body.api_key is not None else previous_key
        payload = body.model_dump(exclude={"api_key"})
        with db(True) as conn:
            conn.execute("INSERT OR REPLACE INTO llm_settings VALUES(?,?,?)", (user, json.dumps(payload, ensure_ascii=False), cipher.encrypt(key.encode()).decode() if key else ""))
            event(conn, user, "settings.upsert", "llm")
        return payload | {"has_key": bool(key)}

    @app.post("/api/settings/llm/test")
    async def test_llm(user=Depends(owner)):
        config, key = settings_for(user)
        if not config["base_url"]:
            raise HTTPException(400, "请先保存 API 地址")
        try:
            async with httpx.AsyncClient(timeout=15, follow_redirects=False) as client:
                response = await client.get(endpoint(config["base_url"], "models"), headers={"Authorization": f"Bearer {key}"} if key else {})
            if response.status_code != 200:
                raise HTTPException(502, f"模型列表接口返回 HTTP {response.status_code}")
            return {"models": [str(x["id"]) for x in response.json().get("data", [])[:200]]}
        except (httpx.HTTPError, ValueError, KeyError):
            raise HTTPException(502, "无法读取模型列表，请检查 API 地址和 Key")

    def analysis_stream(operation):
        async def events():
            queue=asyncio.Queue(maxsize=64)
            async def progress(value):await queue.put(('progress',value))
            async def work():
                try:
                    async with asyncio.timeout(180):result=await operation(progress)
                    await queue.put(('result',result))
                except HTTPException as exc:await queue.put(('error',{'message':exc.detail,'status':exc.status_code}))
                except (ValueError,httpx.HTTPError,TimeoutError):await queue.put(('error',{'message':'分析未完成，请检查模型连接或减少上下文后重试','status':502}))
                except Exception:await queue.put(('error',{'message':'分析暂不可用，请重试','status':500}))
            task=asyncio.create_task(work())
            try:
                while True:
                    try:kind,data=await asyncio.wait_for(queue.get(),12)
                    except asyncio.TimeoutError:kind,data='progress',{'stage':'waiting'}
                    yield 'event: '+kind+'\ndata: '+json.dumps(data,ensure_ascii=False)+'\n\n'
                    if kind in ('result','error'):break
            finally:
                task.cancel()
                await asyncio.gather(task,return_exceptions=True)
        return StreamingResponse(events(),media_type='text/event-stream',headers={'Cache-Control':'no-cache','X-Accel-Buffering':'no'})

    @app.post("/api/analyze")
    async def analyze_message(body: AnalyzeInput, stream: bool=False, user=Depends(owner)):
        if stream:return analysis_stream(lambda progress:run_analysis(user,body,progress))
        return await run_analysis(user, body)

    @app.middleware("http")
    async def headers(request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/health")
    def health():
        return {"status": "ok", "version": "0.5.0"}

    @app.post("/api/auth/register", status_code=201)
    def register(body: Credentials, request: Request):
        limit_auth(request)
        return accounts.register(body)

    @app.post("/api/auth/login")
    def login(body: Credentials, request: Request):
        limit_auth(request)
        with db(True) as conn:
            identity = (body.email or body.username).strip()
            row = conn.execute("SELECT u.* FROM users u LEFT JOIN profiles p ON p.user_id=u.id WHERE u.username=? OR p.email=?", (identity, identity)).fetchone()
            salt = row["salt"] if row else "00" * 16
            candidate = hashlib.pbkdf2_hmac("sha256", body.password.encode(), bytes.fromhex(salt), 310000).hex()
            if not row or not hmac.compare_digest(candidate, row["password"]):
                raise HTTPException(401, "用户名或密码错误")
            token = secrets.token_urlsafe(40)
            conn.execute("DELETE FROM sessions WHERE expires<?", (time.time(),))
            conn.execute("INSERT INTO sessions VALUES(?,?,?)", (hashlib.sha256(token.encode()).hexdigest(), row["id"], time.time() + 30 * 86400))
        return {"token": token, "user_id": row["id"], "username": row["username"]}

    @app.post("/api/auth/logout")
    def logout(user=Depends(owner), authorization: str = Header()):
        with db(True) as conn:
            conn.execute("DELETE FROM sessions WHERE token_hash=?", (hashlib.sha256(authorization[7:].encode()).hexdigest(),))
        return {"ok": True}

    @app.post('/api/auth/device/start')
    def device_start(request:Request):
        limit_auth(request)
        secret=secrets.token_urlsafe(40)
        user_code=''.join(secrets.choice('ABCDEFGHJKLMNPQRSTUVWXYZ23456789') for _ in range(8))
        with db(True) as conn:
            conn.execute('DELETE FROM device_auth WHERE expires<?',(time.time(),))
            conn.execute('INSERT INTO device_auth(device_hash,user_code,expires) VALUES(?,?,?)',(hashlib.sha256(secret.encode()).hexdigest(),user_code,time.time()+600))
        return {'device_code':secret,'user_code':user_code[:4]+'-'+user_code[4:],'expires_in':600,'interval':2,'verification_path':'/authorize?code='+user_code}

    @app.post('/api/auth/device/poll')
    def device_poll(body:DevicePoll):
        with db(True) as conn:
            digest=hashlib.sha256(body.device_code.encode()).hexdigest()
            row=conn.execute('SELECT * FROM device_auth WHERE device_hash=?',(digest,)).fetchone()
            if not row or row['expires']<time.time():raise HTTPException(410,'授权已过期，请重新打开浏览器')
            if row['state']=='denied':raise HTTPException(403,'授权已取消')
            if row['state']=='consumed':raise HTTPException(410,'此授权已使用')
            if row['state']!='approved':return {'status':'pending'}
            user=conn.execute('SELECT username FROM users WHERE id=?',(row['user_id'],)).fetchone()
            token=cipher.decrypt(row['token'].encode()).decode()
            conn.execute("UPDATE device_auth SET state='consumed',token=NULL WHERE device_hash=?",(digest,))
        return {'status':'approved','token':token,'user_id':row['user_id'],'username':user[0]}

    @app.get('/api/auth/device/request')
    def device_request(code:str,user=Depends(owner)):
        normalized=code.replace('-','').replace(' ','').upper()
        with db() as conn:
            row=conn.execute('SELECT state,expires FROM device_auth WHERE user_code=?',(normalized,)).fetchone()
        if not row or row['expires']<time.time():raise HTTPException(410,'授权已过期')
        return {'state':row['state'],'user_code':normalized[:4]+'-'+normalized[4:],'application':'交件箱桌面客户端','expires_in':max(0,int(row['expires']-time.time()))}

    @app.post('/api/auth/device/approve')
    def device_approve(body:DeviceApproval,user=Depends(owner)):
        code=body.user_code.replace('-','').replace(' ','').upper()
        with db(True) as conn:
            row=conn.execute('SELECT * FROM device_auth WHERE user_code=?',(code,)).fetchone()
            if not row or row['expires']<time.time():raise HTTPException(410,'授权已过期')
            if row['state']!='pending':raise HTTPException(409,'此请求已处理')
            token=secrets.token_urlsafe(40) if body.approve else ''
            if token:conn.execute('INSERT INTO sessions VALUES(?,?,?)',(hashlib.sha256(token.encode()).hexdigest(),user,time.time()+30*86400))
            conn.execute('UPDATE device_auth SET state=?,user_id=?,token=? WHERE user_code=?',('approved' if body.approve else 'denied',user,cipher.encrypt(token.encode()).decode() if token else None,code))
        return {'status':'approved' if body.approve else 'denied'}

    @app.get('/authorize')
    def authorize_page():
        return FileResponse(Path(__file__).resolve().parents[1]/'web/index.html')

    @app.get("/api/snapshot")
    def snapshot(user=Depends(owner)):
        with db() as conn:
            conn.execute("BEGIN")
            cursor = conn.execute("SELECT COALESCE(MAX(seq),0) FROM events WHERE user_id=?", (user,)).fetchone()[0]
            tasks = [task_object(conn, r) for r in conn.execute("SELECT * FROM tasks WHERE user_id=? ORDER BY rowid DESC", (user,))]
            messages = [json.loads(r[0]) for r in conn.execute("SELECT payload FROM messages WHERE user_id=? ORDER BY rowid DESC LIMIT 200", (user,))]
            shelf=[dict(r) for r in conn.execute('SELECT a.id,a.name,a.size,a.sha256,a.kind,a.task_id,s.category,s.suggestion,s.created_at,s.version FROM attachments a JOIN shelf_meta s ON s.file_id=a.id WHERE a.user_id=? ORDER BY s.created_at DESC LIMIT 200',(user,))]
        for item in shelf:item['suggestion']=json.loads(item['suggestion']) if item['suggestion'] else None
        return {"cursor": cursor, "tasks": tasks, "messages": messages, 'shelf':shelf}

    @app.get("/api/changes")
    def changes(after: int = Query(default=0, ge=0), user=Depends(owner)):
        with db() as conn:
            rows = [dict(r) for r in conn.execute("SELECT seq,kind,entity_id,at FROM events WHERE user_id=? AND seq>? ORDER BY seq LIMIT 500", (user, after))]
        return {"events": rows, "cursor": rows[-1]["seq"] if rows else after}

    @app.websocket("/api/sync")
    async def sync(ws: WebSocket):
        await ws.accept()
        try:
            first = await asyncio.wait_for(ws.receive_json(), 8)
            token = str(first.get("token", ""))
            user = user_for_token(token)
            cursor = max(0, int(first.get("after", 0)))
            last_heartbeat = time.monotonic()
            while True:
                user_for_token(token)
                with db() as conn:
                    events = [dict(r) for r in conn.execute("SELECT seq,kind,entity_id,at FROM events WHERE user_id=? AND seq>? ORDER BY seq LIMIT 500", (user, cursor))]
                if events:
                    cursor = events[-1]["seq"]
                    await ws.send_json({"type": "changes", "events": events, "cursor": cursor})
                elif time.monotonic() - last_heartbeat > 15:
                    await ws.send_json({"type": "heartbeat", "cursor": cursor})
                    last_heartbeat = time.monotonic()
                try:
                    await asyncio.wait_for(ws.receive_text(), timeout=0.35)
                except asyncio.TimeoutError:
                    pass
        except HTTPException:
            await ws.close(code=4401, reason="登录已过期")
        except (WebSocketDisconnect, RuntimeError, OSError):
            pass
        except (ValueError, TypeError, asyncio.TimeoutError):
            await ws.close(code=4400, reason="同步参数无效")

    @app.post("/api/messages", status_code=201)
    def ingest(body: MessageInput, user=Depends(owner)):
        if len(json.dumps(body.metadata)) > 20000:
            raise HTTPException(422, "消息附加信息过大")
        dedup = json.dumps([body.source, body.account_id, body.conversation_id, body.external_id], ensure_ascii=False)
        with db(True) as conn:
            old = conn.execute("SELECT payload FROM messages WHERE user_id=? AND dedup=?", (user, dedup)).fetchone()
            if old:
                return json.loads(old[0])
            # 内容级去重：同一账号、同会话、同发送者，60 秒内相同正文且原始时间戳相同 → 采集抖动。
            # 不同账号/群收到同文通知是常态，不归为重复。
            window = (datetime.now(timezone.utc) - timedelta(seconds=60)).isoformat()
            text_key = re.sub(r"\s+", "", body.text)[:500]
            if text_key:
                rows = conn.execute("""SELECT payload FROM messages WHERE user_id=? AND json_extract(payload,'$.conversation_id')=?
                    AND json_extract(payload,'$.sender_id')=? AND json_extract(payload,'$.account_id')=? AND json_extract(payload,'$.created_at')>=?
                    ORDER BY rowid DESC LIMIT 20""", (user, body.conversation_id, body.sender_id, body.account_id, window)).fetchall()
                for row in rows:
                    candidate = json.loads(row[0])
                    same_text = re.sub(r"\s+", "", candidate.get("text") or "")[:500] == text_key
                    same_origin = candidate.get("sent_at") == body.sent_at or abs((datetime.fromisoformat(candidate["sent_at"].replace("Z", "+00:00")) - datetime.fromisoformat(body.sent_at.replace("Z", "+00:00"))).total_seconds()) < 5
                    if same_text and same_origin:
                        return candidate
            message = body.model_dump() | {"id": str(uuid.uuid4()), "created_at": now()}
            message["draft"] = extract(body.text, body.sent_at)
            conn.execute("INSERT INTO messages VALUES(?,?,?,?,?)", (message["id"], user, dedup, json.dumps(message, ensure_ascii=False), message["created_at"]))
            event(conn, user, "message.upsert", message["id"])
            # 配置读取沿用同一事务；避免另开连接读取尚未提交状态。
            settings_row = conn.execute("SELECT payload FROM llm_settings WHERE user_id=?", (user,)).fetchone()
            if settings_row:
                config = json.loads(settings_row[0])
                include = [s.strip() for s in config.get("include_keywords", "").split(",") if s.strip()]
                exclude = [s.strip() for s in config.get("exclude_keywords", "").split(",") if s.strip()]
                if config.get("auto_analyze") and (not include or any(s in body.text for s in include)) and not any(s in body.text for s in exclude):
                    conn.execute("INSERT OR IGNORE INTO analysis_jobs(user_id,message_id) VALUES(?,?)", (user, message["id"]))
        return message

    @app.get("/api/messages")
    def messages(before: str = "", limit: int = Query(default=100, ge=1, le=200), user=Depends(owner)):
        with db() as conn:
            sql = "SELECT payload FROM messages WHERE user_id=?"
            params = [user]
            if before:
                sql += " AND rowid<(SELECT rowid FROM messages WHERE id=? AND user_id=?)"
                params += [before, user]
            rows = conn.execute(sql + " ORDER BY rowid DESC LIMIT ?", params + [limit]).fetchall()
        return [json.loads(r[0]) for r in rows]

    @app.put("/api/messages/{message_id}/triage")
    def triage(message_id: str, body: TriageInput, user=Depends(owner)):
        with db(True) as conn:
            row = conn.execute("SELECT payload FROM messages WHERE id=? AND user_id=?", (message_id, user)).fetchone()
            if not row:
                raise HTTPException(404, "消息不存在")
            obj = json.loads(row[0]) | {"triage": body.state}
            conn.execute("UPDATE messages SET payload=? WHERE id=? AND user_id=?", (json.dumps(obj, ensure_ascii=False), message_id, user))
            if body.state == "ignored":
                conn.execute("UPDATE analysis_jobs SET state='ignored' WHERE message_id=? AND state='queued'", (message_id,))
            event(conn, user, "message.upsert", message_id)
        return obj

    @app.post("/api/tasks", status_code=201)
    def create_task(body: TaskInput, user=Depends(owner)):
        with db(True) as conn:
            if body.client_id:
                old = conn.execute("SELECT * FROM tasks WHERE user_id=? AND client_id=?", (user, body.client_id)).fetchone()
                if old:
                    return task_object(conn, old)
            if body.source_message_id and not conn.execute("SELECT 1 FROM messages WHERE id=? AND user_id=?", (body.source_message_id, user)).fetchone():
                raise HTTPException(404, "来源消息不存在")
            obj = body.model_dump() | {"id": str(uuid.uuid4()), "version": 1, "created_at": now(), "updated_at": now()}
            conn.execute("INSERT INTO tasks VALUES(?,?,?,?,?)", (obj["id"], user, 1, body.client_id, json.dumps(obj, ensure_ascii=False)))
            event(conn, user, "task.upsert", obj["id"])
        return obj | {"attachments": []}

    @app.get("/api/tasks/{task_id}")
    def get_task(task_id: str, user=Depends(owner)):
        with db() as conn:
            return task_object(conn, task_row(conn, user, task_id))

    @app.put("/api/tasks/{task_id}")
    def edit_task(task_id: str, body: TaskInput, user=Depends(owner)):
        with db(True) as conn:
            row = task_row(conn, user, task_id)
            if row["version"] != body.version:
                raise HTTPException(409, {"message": "其他设备已修改，请刷新后重新编辑", "current": task_object(conn, row)})
            old = json.loads(row["payload"])
            # urgency/reminders 未传时沿用旧值，避免编辑表单把 AI 推断清掉。
            patch = body.model_dump(exclude_none=False)
            if body.urgency is None: patch.pop("urgency", None)
            if not body.reminders: patch["reminders"] = old.get("reminders", [])
            obj = old | patch | {"id": task_id, "version": body.version + 1, "client_id": old.get("client_id"), "source_message_id": old.get("source_message_id")}
            update_payload(conn, user, task_id, obj)
            return task_object(conn, task_row(conn, user, task_id))

    @app.delete("/api/tasks/{task_id}")
    def delete_task(task_id: str, version: int, user=Depends(owner)):
        with db(True) as conn:
            row = task_row(conn, user, task_id)
            if row["version"] != version:
                raise HTTPException(409, "任务已有更新，请刷新")
            files = [r[0] for r in conn.execute("SELECT id FROM attachments WHERE task_id=?", (task_id,))]
            conn.execute("DELETE FROM tasks WHERE id=? AND user_id=?", (task_id, user))
            event(conn, user, "task.delete", task_id)
        for identity in files:
            (blobs / identity).unlink(missing_ok=True)
        return {"ok": True}

    @app.post("/api/tasks/{task_id}/files", status_code=201)
    async def upload(task_id: str, version: int, kind: Literal["material", "receipt"] = "material", file: UploadFile = File(), user=Depends(owner)):
        with db() as conn:
            task_row(conn, user, task_id)
        identity = str(uuid.uuid4())
        path = blobs / identity
        size = 0
        digest = hashlib.sha256()
        try:
            with path.open("xb") as out:
                while chunk := await file.read(1024 * 512):
                    size += len(chunk)
                    if size > max_upload:
                        raise HTTPException(413, f"单文件不能超过 {max_upload // 1024**2} MB")
                    digest.update(chunk)
                    out.write(chunk)
            name = safe_filename(file.filename or "未命名文件")
            with db(True) as conn:
                row = task_row(conn, user, task_id)
                if row["version"] != version:
                    raise HTTPException(409, "任务已有更新，刷新后重传")
                totals = conn.execute("SELECT COUNT(*),COALESCE(SUM(size),0) FROM attachments WHERE task_id=?", (task_id,)).fetchone()
                if totals[0] >= 50 or totals[1] + size > 200 * 1024**2:
                    raise HTTPException(413, "每项任务最多 50 个文件，总大小最多 200 MB")
                conn.execute("INSERT INTO attachments VALUES(?,?,?,?,?,?,?)", (identity, user, task_id, name, size, digest.hexdigest(), kind))
                obj = json.loads(row["payload"])
                obj["version"] += 1
                update_payload(conn, user, task_id, obj)
                return task_object(conn, task_row(conn, user, task_id))
        except BaseException:
            path.unlink(missing_ok=True)
            raise
        finally:
            await file.close()

    @app.get("/api/files/{file_id}")
    def download(file_id: str, user=Depends(owner)):
        with db() as conn:
            row = conn.execute("SELECT * FROM attachments WHERE id=? AND user_id=?", (file_id, user)).fetchone()
        if not row or not (blobs / row["id"]).is_file():
            raise HTTPException(404, "文件不存在")
        return FileResponse(blobs / row["id"], filename=row["name"], media_type="application/octet-stream")

    def shelf_row(conn,user,file_id):
        row=conn.execute('SELECT a.*,s.category,s.suggestion,s.created_at,s.version FROM attachments a JOIN shelf_meta s ON s.file_id=a.id WHERE a.id=? AND a.user_id=?',(file_id,user)).fetchone()
        if not row:raise HTTPException(404,'收纳文件不存在')
        obj=dict(row);obj['suggestion']=json.loads(obj['suggestion']) if obj['suggestion'] else None
        return obj

    def assign_shelf(conn,user,file_id,task_id,category):
        original=shelf_row(conn,user,file_id)
        if task_id and category not in ('material','receipt'):raise HTTPException(422,'待办内文件用途请选择任务材料或提交回执')
        if task_id:
            target=task_row(conn,user,task_id)
            payload=json.loads(target['payload'])
            if payload['status']=='archived' and original['task_id']!=task_id:raise HTTPException(400,'归档任务不能接收新文件')
            totals=conn.execute('SELECT COUNT(*),COALESCE(SUM(size),0) FROM attachments WHERE task_id=? AND id<>?',(task_id,file_id)).fetchone()
            if totals[0]>=50 or totals[1]+original['size']>200*1024**2:raise HTTPException(413,'任务的材料数量或大小已达到上限')
        conn.execute('UPDATE attachments SET task_id=?,kind=? WHERE id=?',(task_id,'receipt' if category=='receipt' else 'material',file_id))
        conn.execute('UPDATE shelf_meta SET category=?,version=version+1 WHERE file_id=?',(category,file_id))
        for identity in {original['task_id'],task_id}-{None}:
            row=task_row(conn,user,identity);payload=json.loads(row['payload']);payload['version']+=1
            update_payload(conn,user,identity,payload)
        event(conn,user,'shelf.upsert',file_id)
        return shelf_row(conn,user,file_id)

    @app.post('/api/shelf',status_code=201)
    async def shelf_upload(file:UploadFile=File(),user=Depends(owner)):
        identity=str(uuid.uuid4());path=blobs/identity;size=0;digest=hashlib.sha256()
        try:
            with path.open('xb') as target:
                while chunk:=await file.read(512*1024):
                    size+=len(chunk)
                    if size>max_upload:raise HTTPException(413,'文件超过单文件上传上限')
                    digest.update(chunk);target.write(chunk)
            with db(True) as conn:
                total=conn.execute('SELECT COUNT(*),COALESCE(SUM(size),0) FROM attachments WHERE user_id=? AND task_id IS NULL',(user,)).fetchone()
                if total[0]>=200 or total[1]+size>1024**3:raise HTTPException(413,'待整理收纳空间已满，请先归档或清理')
                conn.execute('INSERT INTO attachments VALUES(?,?,?,?,?,?,?)',(identity,user,None,safe_filename(file.filename or '未命名文件'),size,digest.hexdigest(),'material'))
                conn.execute('INSERT INTO shelf_meta(file_id,user_id,category,suggestion,created_at) VALUES(?,?,?,?,?)',(identity,user,'inbox',None,now()))
                event(conn,user,'shelf.upsert',identity)
                return shelf_row(conn,user,identity)
        except BaseException:
            path.unlink(missing_ok=True);raise
        finally:await file.close()

    @app.put('/api/shelf/{file_id}')
    def shelf_assign(file_id:str,body:ShelfAssignment,user=Depends(owner)):
        with db(True) as conn:
            original=shelf_row(conn,user,file_id)
            if body.version is not None and body.version!=original['version']:raise HTTPException(409,'此文件已在其他设备整理，请刷新')
            return assign_shelf(conn,user,file_id,body.task_id,body.category)

    @app.post('/api/shelf/{file_id}/suggest')
    async def shelf_suggest(file_id:str,body:ShelfAnalysis,stream:bool=False,user=Depends(owner)):
        if stream:return analysis_stream(lambda progress:run_shelf_suggest(file_id,body,user,progress))
        return await run_shelf_suggest(file_id,body,user)

    async def run_shelf_suggest(file_id,body,user,progress=None):
        config,key=settings_for(user)
        if not config['base_url'] or not config['model']:raise HTTPException(400,'请先配置 LLM，或直接手动选择分类')
        with db() as conn:
            file=shelf_row(conn,user,file_id)
            candidates=[json.loads(r[0]) for r in conn.execute('SELECT payload FROM tasks WHERE user_id=? ORDER BY rowid DESC LIMIT 50',(user,))]
        candidates=[t for t in candidates if t['status'] not in ('submitted','archived')]
        if progress:await progress({'stage':'extracting','task_count':len(candidates)})
        content,extraction=await asyncio.to_thread(read_text,blobs/file_id,file['name'])
        image=None;image_info={}
        if config.get('vision_enabled') and Path(file['name']).suffix.lower() in IMAGE_EXTENSIONS:
            try:image,image_info=await asyncio.to_thread(prepare_image,blobs/file_id)
            except ValueError as exc:raise HTTPException(400,str(exc))
            extraction='已读取图片内容（'+str(image_info['image_width'])+'×'+str(image_info['image_height'])+'）'
        if progress:await progress({'stage':'file-context','task_count':len(candidates),'extracted_characters':len(content),'extraction':extraction,'image_count':1 if image else 0})
        started_llm=(now(),time.monotonic())
        try:result=await suggest_file(config,key,{'name':file['name'],'size':file['size']},content,candidates,**({'progress':progress} if progress else {}),**({'image':image} if image else {}))
        except asyncio.CancelledError as exc:
            record_llm(user,'file',config,started_llm,error=exc);raise
        except (ValueError,httpx.HTTPError) as exc:
            record_llm(user,'file',config,started_llm,error=exc);raise HTTPException(502,'AI 归类暂不可用，文件已保留，可手动分类或重试')
        record_llm(user,'file',config,started_llm,result=result)
        result|=image_info
        result|={'extraction':extraction,'extracted_characters':len(content),'at':now(),'model':config['model']}
        with db(True) as conn:
            current=shelf_row(conn,user,file_id)
            if current['version']!=file['version']:raise HTTPException(409,'你已手动整理此文件，AI 结果没有覆盖修改')
            conn.execute('UPDATE shelf_meta SET suggestion=? WHERE file_id=?',(json.dumps(result,ensure_ascii=False),file_id))
            if body.auto_assign and result['task_id'] and result['confidence']>=.85 and current['task_id'] is None:
                assign_shelf(conn,user,file_id,result['task_id'],result['category'])
            elif current['task_id'] is None and result['task_id'] is None:
                conn.execute('UPDATE shelf_meta SET category=? WHERE file_id=?',(result['category'] if result['category'] in ('reference','other','receipt') else 'inbox',file_id))
            event(conn,user,'shelf.upsert',file_id)
            return shelf_row(conn,user,file_id)

    @app.delete('/api/shelf/{file_id}')
    def shelf_delete(file_id:str,version:int,user=Depends(owner)):
        with db(True) as conn:
            file=shelf_row(conn,user,file_id)
            if file['version']!=version:raise HTTPException(409,'此文件已更新，请刷新')
            conn.execute('DELETE FROM attachments WHERE id=? AND user_id=?',(file_id,user))
            if file['task_id']:
                row=task_row(conn,user,file['task_id']);obj=json.loads(row['payload']);obj['version']+=1;update_payload(conn,user,file['task_id'],obj)
            event(conn,user,'shelf.delete',file_id)
        (blobs/file_id).unlink(missing_ok=True)
        return {'ok':True}

    @app.delete("/api/tasks/{task_id}/files/{file_id}")
    def remove_file(task_id: str, file_id: str, version: int, user=Depends(owner)):
        with db(True) as conn:
            row = task_row(conn, user, task_id)
            if row["version"] != version:
                raise HTTPException(409, "任务已有更新，请刷新")
            if not conn.execute("SELECT 1 FROM attachments WHERE id=? AND task_id=? AND user_id=?", (file_id, task_id, user)).fetchone():
                raise HTTPException(404, "文件不存在")
            conn.execute("DELETE FROM attachments WHERE id=? AND user_id=?", (file_id, user))
            obj = json.loads(row["payload"])
            obj["version"] += 1
            update_payload(conn, user, task_id, obj)
        (blobs / file_id).unlink(missing_ok=True)
        return {"ok": True}

    @app.put('/api/tasks/{task_id}/files/{file_id}/kind')
    def change_file_kind(task_id:str,file_id:str,body:FileKindInput,user=Depends(owner)):
        with db(True) as conn:
            row=task_row(conn,user,task_id)
            if row['version']!=body.version:raise HTTPException(409,'任务已有更新，请刷新后再移动文件')
            if not conn.execute('SELECT 1 FROM attachments WHERE id=? AND user_id=? AND task_id=?',(file_id,user,task_id)).fetchone():raise HTTPException(404,'文件不存在')
            conn.execute('UPDATE attachments SET kind=? WHERE id=?',(body.kind,file_id))
            if conn.execute('SELECT 1 FROM shelf_meta WHERE file_id=?',(file_id,)).fetchone():
                conn.execute('UPDATE shelf_meta SET category=?,version=version+1 WHERE file_id=?',(body.kind,file_id))
                event(conn,user,'shelf.upsert',file_id)
            payload=json.loads(row['payload']);payload['version']+=1;update_payload(conn,user,task_id,payload)
            return task_object(conn,task_row(conn,user,task_id))

    @app.put("/api/tasks/{task_id}/files/{file_id}")
    def rename_file(task_id: str, file_id: str, body: RenameInput, user=Depends(owner)):
        with db(True) as conn:
            row = task_row(conn, user, task_id)
            if row["version"] != body.version:
                raise HTTPException(409, "任务已有更新，请刷新")
            if not conn.execute("SELECT 1 FROM attachments WHERE id=? AND user_id=? AND task_id=?", (file_id, user, task_id)).fetchone():
                raise HTTPException(404, "文件不存在")
            conn.execute("UPDATE attachments SET name=? WHERE id=?", (safe_filename(body.name), file_id))
            obj = json.loads(row["payload"])
            obj["version"] += 1
            update_payload(conn, user, task_id, obj)
            return task_object(conn, task_row(conn, user, task_id))

    def check_object(obj):
        import fnmatch
        files = [f for f in obj["attachments"] if f["kind"] == "material"]
        results = []
        # 每份文件只占一个材料名额；允许格式重叠时用增广匹配，避免一份 PDF 同时满足两份要求。
        slots = [i for i, req in enumerate(obj["requirements"]) for _ in range(req["min_count"])]
        assignments = {}
        def allocate(slot, seen):
            extensions = obj["requirements"][slots[slot]]["extensions"]
            for index, file in enumerate(files):
                if index in seen or (extensions and Path(file["name"]).suffix.lower().lstrip(".") not in extensions):
                    continue
                seen.add(index)
                if index not in assignments or allocate(assignments[index], seen):
                    assignments[index] = slot
                    return True
            return False
        for slot in range(len(slots)):
            allocate(slot, set())
        for index, req in enumerate(obj["requirements"]):
            count = sum(slots[slot] == index for slot in assignments.values())
            results.append({"label": req["label"], "ok": count >= req["min_count"], "detail": f"{count}/{req['min_count']}"})
        if obj.get("max_total_bytes"):
            size = sum(f["size"] for f in files)
            results.append({"label": "材料总大小", "ok": size <= obj["max_total_bytes"], "detail": f"{size}/{obj['max_total_bytes']} 字节"})
        if obj.get("filename_pattern"):
            bad = [f["name"] for f in files if not fnmatch.fnmatchcase(f["name"], obj["filename_pattern"])]
            results.append({"label": "文件命名", "ok": not bad, "detail": "、".join(bad) or "全部符合"})
        elif obj.get("naming_hint"):
            results.append({"label": "命名要求需人工核对", "ok": None, "detail": obj["naming_hint"]})
        return {"results": results, "ready": bool(files) and all(x["ok"] is True for x in results), "material_count": len(files)}

    @app.get("/api/tasks/{task_id}/check")
    def check(task_id: str, user=Depends(owner)):
        with db() as conn:
            return check_object(task_object(conn, task_row(conn, user, task_id)))

    @app.get("/api/tasks/{task_id}/package")
    def package(task_id: str, user=Depends(owner)):
        with db(True) as conn:
            obj = task_object(conn, task_row(conn, user, task_id))
            files = [f for f in obj["attachments"] if f["kind"] == "material"]
            if not files:
                raise HTTPException(400, "请先添加材料")
            # 在读取事务内复制材料，避免并发删除产生不完整压缩包。
            output = tempfile.SpooledTemporaryFile(max_size=8 * 1024**2)
            used = {"交件清单.json"}
            with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
                for f in files:
                    name = f["name"]
                    stem, suffix = Path(name).stem, Path(name).suffix
                    n = 2
                    while name.casefold() in {s.casefold() for s in used}:
                        name = f"{stem} ({n}){suffix}"
                        n += 1
                    used.add(name)
                    archive.write(blobs / f["id"], name)
                archive.writestr("交件清单.json", json.dumps({"task": obj, "check": check_object(obj)}, ensure_ascii=False, indent=2))
        output.seek(0)
        return StreamingResponse(output, media_type="application/zip", headers={"Content-Disposition": 'attachment; filename="submission.zip"'}, background=BackgroundTask(output.close))

    web_root = Path(__file__).resolve().parents[1] / "web"
    if web_root.exists():
        app.mount("/", StaticFiles(directory=web_root, html=True), name="web")
    return app


app = create_app()
