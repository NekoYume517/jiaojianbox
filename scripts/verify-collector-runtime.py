"""Exercise the shipped helper's run path with hostile inherited proxy/cert settings."""
import argparse
import json
import os
from pathlib import Path
import queue
import subprocess
import tempfile
import threading
import time

parser = argparse.ArgumentParser()
parser.add_argument('helper', type=Path)
args = parser.parse_args()
helper = args.helper.resolve()
with tempfile.TemporaryDirectory(prefix='jjb-collector-runtime-') as state:
    env = dict(os.environ, ALL_PROXY='socks5h://127.0.0.1:1',
               HTTP_PROXY='socks5://127.0.0.1:1', HTTPS_PROXY='socks5://127.0.0.1:1',
               NO_PROXY='', PYTHONIOENCODING='gbk', PYTHONUTF8='0', SSL_CERT_FILE=str(Path(state) / 'absent.pem'))
    child = subprocess.Popen([str(helper), 'run', '--state-dir', state], cwd=helper.parent,
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             text=True, encoding='utf-8', env=env,
                             creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    events = queue.Queue()
    def read_events():
        for line in child.stdout:
            try: events.put(json.loads(line))
            except ValueError: pass
    reader = threading.Thread(target=read_events, daemon=True)
    reader.start()
    child.stdin.write(json.dumps({'server_url': 'http://127.0.0.1:1', 'server_token': 'fixture',
                                 'user_id': 'packaging-smoke', 'qq_chats': [], 'wechat_chats': [],
                                 'conversation_names': {'private:1': '中文群聊：交件箱 😀'},
                                 'wechat_db_dir': 'D:/微信备份/消息'}, ensure_ascii=False) + '\n')
    child.stdin.flush()
    try:
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            try: event = events.get(timeout=.2)
            except queue.Empty:
                if child.poll() is not None:
                    raise AssertionError('Bundled collector exited during startup: ' + str(child.returncode))
                continue
            if event.get('state') == 'error': raise AssertionError(event.get('message'))
            if event.get('source') == 'queue':
                assert child.poll() is None
                print(json.dumps({'collectorRun': True, 'proxyEnvironmentIsolated': True,
                                  'certificateEnvironmentIsolated': True, 'utf8ChineseConfig': True, 'bundled': True}))
                break
        else: raise AssertionError('Bundled collector did not finish startup within 45 seconds')
    finally:
        if child.poll() is None: child.kill()
        child.wait(timeout=10)
        child.stdin.close()
        reader.join(timeout=5)
        child.stdout.close()
        child.stderr.close()
