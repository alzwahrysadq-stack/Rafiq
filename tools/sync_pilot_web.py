#!/usr/bin/env python3
"""Copy the tested web pilot UI into Android's isolated, local pilot assets.

Do not copy README or include the old Room/WebView engine. Run after each web-client edit.
Android is built only in GitHub Actions; this tool does not build an APK.
"""
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "web-client"
DEST = ROOT / "app/src/main/assets/pilot"
FILES = ("index.html", "lib.mjs", "ocrParse.mjs", "web.css", "web.js", "model.css", "camera.js", "thermal.js", "bulkedit.js", "home.js", "pos.js", "sorting.js", "dupcheck.js", "sms-offline.js", "sms-sale.js", "xlsx.js", "product-import.js")


def main():
    DEST.mkdir(parents=True, exist_ok=True)
    for file in FILES:
        shutil.copyfile(SOURCE / file, DEST / file)
    source_assets, dest_assets = SOURCE / "assets", DEST / "assets"
    if dest_assets.exists():
        shutil.rmtree(dest_assets)
    shutil.copytree(source_assets, dest_assets)
    print("Pilot assets synchronized:", len(list(DEST.rglob("*"))), "entries")


if __name__ == "__main__":
    main()
