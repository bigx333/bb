import argparse
import json
import sqlite3
import time
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("database", type=Path)
parser.add_argument("thread_ids", nargs="+")
parser.add_argument("--seconds", type=int, default=180)
args = parser.parse_args()
connection = sqlite3.connect(args.database.resolve().as_uri() + "?mode=ro", uri=True, timeout=2)
seen = set()
last_outcome = None
stop_at = time.monotonic() + args.seconds
while time.monotonic() < stop_at:
    for thread_id in args.thread_ids:
        rows = connection.execute(
            "SELECT sequence,type,item_kind,turn_id,created_at FROM events "
            "WHERE thread_id=? AND type IN ('turn/completed','item/completed') "
            "ORDER BY sequence DESC LIMIT 12", (thread_id,)
        ).fetchall()
        for sequence, kind, item_kind, turn_id, created_at in reversed(rows):
            if kind == "item/completed" and item_kind != "agentMessage":
                continue
            key = (thread_id, sequence)
            if key in seen:
                continue
            seen.add(key)
            print(json.dumps(dict(stage="stored-event", observedAt=int(time.time()*1000),
                                  at=created_at, threadId=thread_id, sequence=sequence,
                                  eventType=kind, itemKind=item_kind, turnId=turn_id)), flush=True)
    outcome = connection.execute(
        "SELECT value FROM plugin_kv WHERE plugin_id='push-notifications' AND key='last-send-outcome'"
    ).fetchone()
    if outcome and outcome[0] != last_outcome:
        last_outcome = outcome[0]
        print(json.dumps(dict(stage="global-relay-outcome", observedAt=int(time.time()*1000),
                              outcome=json.loads(last_outcome))), flush=True)
    time.sleep(0.25)
