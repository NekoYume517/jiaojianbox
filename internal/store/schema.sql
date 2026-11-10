
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


                CREATE TABLE IF NOT EXISTS user_roles(user_id TEXT PRIMARY KEY REFERENCES users(id), role TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS site_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS profiles(user_id TEXT PRIMARY KEY REFERENCES users(id), nickname TEXT DEFAULT '', email TEXT UNIQUE COLLATE NOCASE, verified INTEGER DEFAULT 0);
        CREATE TABLE IF NOT EXISTS user_quotas(user_id TEXT PRIMARY KEY REFERENCES users(id), bytes INTEGER NOT NULL, updated_at TEXT);
                CREATE TABLE IF NOT EXISTS ai_credits(user_id TEXT PRIMARY KEY REFERENCES users(id), balance REAL NOT NULL, updated_at TEXT);
                CREATE TABLE IF NOT EXISTS ai_checkins(user_id TEXT REFERENCES users(id), day TEXT NOT NULL, credits REAL NOT NULL, at TEXT NOT NULL, PRIMARY KEY(user_id,day));
                CREATE TABLE IF NOT EXISTS mail_tokens(hash TEXT PRIMARY KEY, purpose TEXT, email TEXT, payload TEXT, expires REAL, created REAL);
                CREATE TABLE IF NOT EXISTS invitations(id TEXT PRIMARY KEY, code_hash TEXT UNIQUE NOT NULL,
                    prefix TEXT, label TEXT, max_uses INTEGER, uses INTEGER DEFAULT 0,
                    expires REAL, revoked INTEGER DEFAULT 0, created_by TEXT REFERENCES users(id));
        CREATE TABLE IF NOT EXISTS shares(
            id TEXT PRIMARY KEY,
            user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
            task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
            token_hash TEXT UNIQUE NOT NULL,
            token_cipher TEXT NOT NULL,
            payload TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS ix_shares_owner ON shares(user_id,created_at);
        CREATE INDEX IF NOT EXISTS ix_shares_task ON shares(task_id);
        CREATE TABLE IF NOT EXISTS share_submissions(
            id TEXT PRIMARY KEY,
            share_id TEXT REFERENCES shares(id) ON DELETE CASCADE,
            task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
            user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
            name TEXT NOT NULL DEFAULT '',
            contact TEXT NOT NULL DEFAULT '',
            note TEXT NOT NULL DEFAULT '',
            ip_hash TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS ix_share_submissions_share ON share_submissions(share_id,created_at);
        CREATE TABLE IF NOT EXISTS share_submission_files(
            submission_id TEXT REFERENCES share_submissions(id) ON DELETE CASCADE,
            attachment_id TEXT REFERENCES attachments(id) ON DELETE CASCADE,
            PRIMARY KEY(submission_id,attachment_id));

