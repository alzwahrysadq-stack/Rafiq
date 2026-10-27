#!/usr/bin/env python3
"""Package ONLY incremental 003+004 into one atomic SQL Editor paste for the TEST project.

Do not bundle the installer. Does not connect to Supabase and carries no IDs/secrets.
"""
from pathlib import Path
import re

root = Path(__file__).resolve().parent.parent
sources = [root / 'supabase/migrations/20261016000300_original_cash_shift_decision.sql',
           root / 'supabase/migrations/20261016000400_original_finance_and_owner_events.sql']
out = root / 'docs/rafiq_test_upgrade_20261016.sql'

pieces = []
for source in sources:
    text = source.read_text(encoding='utf-8').strip()
    begin = list(re.finditer(r'^begin;\s*$', text, re.M | re.I))
    commit = list(re.finditer(r'^commit;\s*$', text, re.M | re.I))
    if len(begin) != 1 or len(commit) != 1 or commit[0].start() < begin[0].start():
        raise SystemExit(f'Unexpected transaction shape; do not package {source.name}')
    text = text[:commit[0].start()] + text[commit[0].end():]
    text = text[:begin[0].start()] + text[begin[0].end():]
    pieces.append(f'-- BEGIN incremental source {source.name}\n{text.strip()}\n'
                  f'-- END incremental source {source.name}')

header = """-- ONE-TIME TEST PROJECT UPGRADE (2026-10-16); SQL Editor only.
-- Preconditions: pilot 00100+00200 installed; original 00300 NOT applied.
-- Never run the installer again; never run this upgrade twice.
-- READ BEFORE APPLYING: no Room import, no production publication, no SMS/Push.
-- Contents: incremental 00300 shift decisions + 00400 financial/read/owner feed.
-- Entire upgrade shares ONE PostgreSQL transaction; any SQL failure rolls back both.
-- The app also requires a matching new Android APK (not yet built/tested).
"""
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(header + 'begin;\n\n' + '\n\n'.join(pieces) + '\n\ncommit;\n', encoding='utf-8')
print(out.relative_to(root))
