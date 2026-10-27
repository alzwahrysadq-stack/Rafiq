"""CI-only APK content proof; never builds Android locally."""
from pathlib import Path
import hashlib
import zipfile

root = Path(__file__).resolve().parents[1]
files = list((root / 'app/build/outputs/apk/debug').glob('*.apk'))
assert len(files) == 1, 'Expected exactly one debug APK'
apk = files[0]
with zipfile.ZipFile(apk) as z:
    asset_root = root / 'web-client'
    names = ['index.html', 'web.js', 'web.css', 'lib.mjs', 'ocrParse.mjs', 'model.css']
    names += [p.relative_to(asset_root).as_posix() for p in (asset_root / 'assets').rglob('*') if p.is_file()]
    for name in names:
        assert z.read('assets/pilot/' + name) == (asset_root / name).read_bytes(), f'Stale APK asset: {name}'
    js = z.read('assets/pilot/web.js').decode()
    assert "const APP_VIEWS=['home','monitor','pos','customers','suppliers'" in js
    assert 'rfq_pilot_owner_product_costs' in js
    assert 'rfq_pilot_replace_own_device' in js
    assert 'function ensureOwnerSellerSession(' in js
    assert 'visibilitychange' in js
    assert 'Workspace 130' in z.read('assets/pilot/web.css').decode()
    assert 'واجهة 130' in z.read('assets/pilot/index.html').decode()
sha = hashlib.sha256(apk.read_bytes()).hexdigest()
text = f'APK: {apk.name}\nBytes: {apk.stat().st_size}\nSHA256: {sha}\nVerified matching embedded files: {len(names)}\n'
(apk.parent / 'rafiq-apk-verification.txt').write_text(text, encoding='utf-8')
print(text)
