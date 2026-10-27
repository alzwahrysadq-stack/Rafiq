#!/usr/bin/env python3
"""Check generated original-screen assets without building Android or touching Supabase."""
import importlib.util
import json
import pathlib
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
WEB = ROOT / 'app/src/main/assets/web'
SOURCE = ROOT / 'templates_extra'
spec = importlib.util.spec_from_file_location('build_web', ROOT / 'tools/build_web.py')
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)

bundle = (WEB / 'templates.js').read_text(encoding='utf-8')
prefix = 'window.RAFIQ_TEMPLATES = '
assert bundle.startswith(prefix)
templates = json.loads(bundle[len(prefix):].strip().removesuffix(';'))
for name in ['cash.html', 'pos.html', 'customers.html', 'customer_detail.html',
             'cloud_pos.html', 'cloud_customers.html', 'cloud_dashboard.html',
             'cloud_remote_eye.html']:
    expected = build.jinja_to_nunjucks((SOURCE / name).read_text(encoding='utf-8'))
    assert templates[name] == expected, f'{name} was changed but not merged into Android templates.js'
assert {'cloud-shift.js', 'cloud-ledger.js'} <= build.KEEP
assert (WEB / 'cloud-shift.js').is_file() and (WEB / 'cloud-ledger.js').is_file()
assert 'id="serverShift"' in templates['cash.html']
assert '{% if cloud_shift_only %}' in templates['cash.html']
assert 'توقّف البيع والآجل من الشاشة المحلية' in templates['cloud_pos.html']
assert 'cloudCashLedger' in templates['cash.html']
assert 'cloudAdvanceForm' in templates['cloud_customers.html']
assert 'cloudEyeEvents' in templates['cloud_remote_eye.html']

with tempfile.TemporaryDirectory() as tmp:
    work = pathlib.Path(tmp) / 'repo'
    assets = work / 'app/src/main/assets/web'
    assets.mkdir(parents=True)
    (assets / 'cloud-shift.js').write_text('// keep me', encoding='utf-8')
    (assets / 'cloud-ledger.js').write_text('// keep ledger', encoding='utf-8')
    (assets / 'engine.js').write_text('// keep engine', encoding='utf-8')
    (assets / 'vendor').mkdir()
    (assets / 'vendor/nunjucks.min.js').write_text('// keep vendor', encoding='utf-8')
    (assets / 'obsolete.js').write_text('// removed', encoding='utf-8')
    extra = work / 'templates_extra'
    extra.mkdir()
    (extra / 'cash.html').write_text((SOURCE / 'cash.html').read_text(encoding='utf-8'), encoding='utf-8')
    ref = pathlib.Path(tmp) / 'reference'
    (ref / 'templates').mkdir(parents=True)
    (ref / 'static').mkdir()
    (ref / 'templates/base.html').write_text('<html>{% block content %}{% endblock %}</html>', encoding='utf-8')
    (ref / 'app.py').write_text('@app.route("/cash")\ndef cash():\n    pass\n', encoding='utf-8')
    (ref / 'static/style.css').write_text('/* harmless test asset */', encoding='utf-8')
    build.REPO = str(work)
    build.OUT = str(assets)
    build.REF = str(ref)
    build.main()
    assert (assets / 'cloud-shift.js').read_text(encoding='utf-8') == '// keep me'
    assert (assets / 'cloud-ledger.js').read_text(encoding='utf-8') == '// keep ledger'
    assert (assets / 'engine.js').read_text(encoding='utf-8') == '// keep engine'
    assert (assets / 'vendor/nunjucks.min.js').exists()
    assert not (assets / 'obsolete.js').exists()
    generated = (assets / 'templates.js').read_text(encoding='utf-8')
    assert 'id="serverShift"' in json.loads(generated[len(prefix):].strip().removesuffix(';'))['cash.html']

native = (ROOT / 'app/src/main/java/net/arena/rafiq/web/NativeApi.kt').read_text(encoding='utf-8')
activity = (ROOT / 'app/src/main/java/net/arena/rafiq/MainActivity.kt').read_text(encoding='utf-8')
assert 'requireCloudForMoney = true' in activity
assert '"/api/sale", "/api/customers", "/api/search", "/api/find"' in native
assert 'archiveCustomersRoute' in native and 'cloud_remote_eye.html' in native
assert 'path.startsWith("/cash/") && path != "/cash/report"' in native
assert 'MIXED_CONTENT_NEVER_ALLOW' in activity
assert 'uri.path?.startsWith("/assets/web/")' in activity
assert 'uri.path?.startsWith("/rest/v1/")' in activity
print('PASS original cash assets: compiled templates in sync, rebuild preserves JS, Android guards present; static only.')
