"""Never initialize the default app against a developer's live data during tests."""
import os
import tempfile
_default_app_store=tempfile.TemporaryDirectory(prefix='jiaojianbox-tests-',ignore_cleanup_errors=True)
os.environ['JJB_DATA_DIR']=_default_app_store.name
