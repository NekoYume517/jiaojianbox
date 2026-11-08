"""Container probe using only the Python standard library."""
import urllib.request

if __name__ == '__main__':
    with urllib.request.urlopen('http://127.0.0.1:8765/health', timeout=3) as response:
        if response.status != 200:
            raise SystemExit(1)
