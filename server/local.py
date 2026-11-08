"""Desktop-owned loopback service; configuration arrives on stdin, never argv."""
import json
import os
import socket
import sys

def main():
    config = json.loads(sys.stdin.readline())
    os.environ['JJB_DATA_DIR'] = config['data_dir']
    os.environ['JJB_ALLOW_REGISTRATION'] = 'false'
    os.environ['JJB_BOOTSTRAP_ADMIN_USERNAME'] = 'offline'
    os.environ['JJB_BOOTSTRAP_ADMIN_PASSWORD'] = config['password']
    from server.app import app
    import uvicorn
    sock = socket.socket()
    sock.bind(('127.0.0.1', 0))
    sock.listen(128)
    print(json.dumps({'port': sock.getsockname()[1]}), flush=True)
    uvicorn.Server(uvicorn.Config(app, host='127.0.0.1', log_level='warning')).run(sockets=[sock])

if __name__ == '__main__': main()
