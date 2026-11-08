"""Consistent, local-only backup of an existing JiaojianBox data volume."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import tarfile


def main():
    root = Path(os.environ.get('JJB_DATA_DIR', '/data')).resolve()
    folder = root / 'backups' / ('pre-upgrade-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ'))
    folder.mkdir(parents=True, mode=0o700)
    source = sqlite3.connect('file:' + str(root / 'jiaojianbox.sqlite3') + '?mode=ro', uri=True, timeout=30)
    target = sqlite3.connect(folder / 'jiaojianbox.sqlite3')
    try:
        source.backup(target)
        if target.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise RuntimeError('Database integrity check failed; upgrade must stop')
        counts = {name: target.execute('SELECT COUNT(*) FROM ' + name).fetchone()[0] for name in ['users', 'messages', 'tasks', 'attachments']}
        files = target.execute('SELECT id,size,sha256 FROM attachments').fetchall()
        with tarfile.open(folder / 'attachments.tar', 'w') as archive:
            for identity, size, expected in files:
                if Path(identity).name != identity or '/' in identity or '\\' in identity:
                    raise RuntimeError('Invalid attachment identity')
                path = root / 'files' / identity
                digest = hashlib.sha256()
                with path.open('rb') as content:
                    while chunk := content.read(1024 * 1024):
                        digest.update(chunk)
                if path.stat().st_size != size or digest.hexdigest() != expected:
                    raise RuntimeError('Attachment integrity mismatch; upgrade must stop')
                archive.add(path, arcname=identity, recursive=False)
        if os.environ.get('JJB_MASTER_KEY'):
            (folder / 'master.key').write_text(os.environ['JJB_MASTER_KEY'])
        else:
            shutil.copy2(root / 'master.key', folder / 'master.key')
        if (root / 'workspace.id').exists():
            shutil.copy2(root / 'workspace.id', folder / 'workspace.id')
    finally:
        target.close()
        source.close()
    for file in folder.iterdir():
        file.chmod(0o600)
    manifest = {'path': str(folder), 'counts': counts, 'attachments_verified': len(files), 'sqlite_integrity': 'ok'}
    with (folder / 'complete.json').open('x', encoding='utf-8') as result:
        json.dump(manifest, result)
        result.flush()
        os.fsync(result.fileno())
    print(json.dumps(manifest), flush=True)


if __name__ == '__main__':
    main()
