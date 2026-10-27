"""Fail the source bundle if any real-looking Supabase project endpoint/key is embedded.
Run on sources/templates, NOT on test fixtures (which deliberately use synthetic values).
"""
from pathlib import Path
import re

root = Path(__file__).resolve().parents[1]
paths = list((root / 'app/src/main/java/net/arena/rafiq/cloud').glob('*.kt'))
paths += [root / 'templates_extra/cloud_setup.html']
assert paths and all(p.is_file() for p in paths)
for path in paths:
    text = path.read_text(encoding='utf-8')
    assert not re.search(r'https://[a-z0-9]{12,}\.supabase\.co', text, re.I), path
    assert not re.search(r'sb_publishable_[A-Za-z0-9_-]{24,}', text), path
    assert not re.search(r'sb_secret_[A-Za-z0-9_-]{20,}', text), path
print('Cloud config source: no embedded project endpoint or publishable/secret key PASS')
