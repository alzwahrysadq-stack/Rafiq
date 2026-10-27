#!/usr/bin/env python3
"""Build ONE atomic SQL Editor script for a disposable Supabase test project.

Never feed production accounts, service_role keys, database passwords, or tokens.
Auth users must ALREADY exist in Supabase Auth; only email addresses are used here.
The output contains a random store UUID and must be reviewed before manual execution.
"""
import argparse
import datetime as dt
import pathlib
import re
import uuid

ROOT = pathlib.Path(__file__).resolve().parent.parent
MIGRATIONS = (
    ROOT / 'supabase/migrations/20261015000100_pilot_control_plane.sql',
    ROOT / 'supabase/migrations/20261015000200_pilot_financial_ledger.sql',
)


def sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def create(owner_email: str, worker_email: str, name: str, seats: int,
           until: str, store_id: str) -> str:
    if not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', owner_email) or not re.fullmatch(
            r'[^\s@]+@[^\s@]+\.[^\s@]+', worker_email):
        raise ValueError('Need distinct existing test Auth email addresses, not passwords')
    if owner_email.lower() == worker_email.lower():
        raise ValueError('Owner and worker must have separate Supabase Auth accounts')
    if not 1 <= seats <= 50 or not 1 <= len(name.strip()) <= 120:
        raise ValueError('Invalid test store name or device seat limit')
    expiry = dt.datetime.fromisoformat(until.replace('Z', '+00:00'))
    if expiry.tzinfo is None or expiry <= dt.datetime.now(dt.timezone.utc):
        raise ValueError('License expiry needs a future timezone-aware timestamp')
    store_id = str(uuid.UUID(store_id))
    chunks = []
    for path in MIGRATIONS:
        source = path.read_text(encoding='utf-8')
        if re.search(r'(?im)^\s*(begin|commit|rollback)\s*;', source):
            raise ValueError(f'{path.name} must not open its own transaction')
        chunks.append(f'\n-- === {path.name} ===\n{source}\n')
    seed = f"""
-- Seed ONLY the named existing test Auth users; fail atomically if either is absent.
do $rafiq_seed$
declare v_store uuid := {sql_literal(store_id)}::uuid;
  v_owner uuid; v_worker uuid;
begin
  select id into v_owner from auth.users where lower(email)=lower({sql_literal(owner_email)});
  select id into v_worker from auth.users where lower(email)=lower({sql_literal(worker_email)});
  if v_owner is null or v_worker is null or v_owner=v_worker then
    raise exception 'test_auth_accounts_missing_or_duplicate';
  end if;
  insert into public.rfq_pilot_stores(id,name,enabled,seat_limit,license_until)
    values(v_store,{sql_literal(name.strip())},true,{seats},{sql_literal(expiry.isoformat())}::timestamptz);
  insert into public.rfq_pilot_members(store_id,user_id,role)
    values(v_store,v_owner,'owner'),(v_store,v_worker,'worker');
  raise notice 'TEST STORE UUID: %',v_store;
end $rafiq_seed$;
"""
    header = ("-- RAFIQ TEST PROJECT ONLY / NOT FOR PRODUCTION / NO CUSTOMER DATA.\n"
              "-- STOP unless Supabase dashboard shows the intended TEST project. Run ALL lines ONCE.\n"
              f"-- REQUIRED existing/confirmed Auth users: OWNER {owner_email} / WORKER {worker_email}.\n"
              f"-- Test store has {seats} device seats and expires {expiry.isoformat()}; not a paid license.\n"
              "-- One transaction: missing Auth account or schema conflict rolls back all changes.\n"
              "-- No local phone data is imported; do not clean-install before a verified backup.\n"
              "-- No SMS dispatch, production signing, live web deployment, or sales-ready APK.\n")
    return (header + 'begin;\n' + ''.join(chunks) + seed + 'commit;\n'
            + f"select id,name,seat_limit,license_until from public.rfq_pilot_stores where id={sql_literal(store_id)}::uuid;\n")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--owner-email', required=True)
    ap.add_argument('--worker-email', required=True)
    ap.add_argument('--name', required=True)
    ap.add_argument('--seats', type=int, default=3)
    ap.add_argument('--license-until', required=True, help='UTC ISO-8601 date/time, e.g. 2026-11-15T00:00:00Z')
    ap.add_argument('--store-id', default=str(uuid.uuid4()))
    ap.add_argument('--output', type=pathlib.Path, required=True)
    args = ap.parse_args()
    contents = create(args.owner_email, args.worker_email, args.name,
                      args.seats, args.license_until, args.store_id)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(contents, encoding='utf-8')
    print(f'Test SQL Editor script written: {args.output} (store {args.store_id})')


if __name__ == '__main__':
    main()
