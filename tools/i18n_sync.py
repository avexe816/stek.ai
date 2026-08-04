#!/usr/bin/env python3
"""Translation-memory maintenance for ELE HOTEL.

    python3 tools/i18n_sync.py --stats
        coverage per language.

    python3 tools/i18n_sync.py --todo [zh en ko th]
        Export every string that still has no translation to
        data/i18n-todo.json in the form  {"<key>": {"ja": "...", "zh": ""}}.
        Only NEW or CHANGED Japanese text ever shows up here, so a routine
        content update produces a handful of lines instead of a whole site.

    python3 tools/i18n_sync.py --import <file.json>
        Merge a filled-in todo file back into data/i18n.json.
        Entries marked "locked": true are never overwritten unless --force.

    python3 tools/i18n_sync.py --prune
        Drop memory entries no longer referenced by any page (keeps a backup).

    python3 tools/i18n_sync.py --lock <key> ...
        Mark entries as human-written so they survive future syncs.
"""

import json
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from i18n import DATA, MEM_FILE, load_memory, save_memory  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TARGETS = ["zh", "zh-Hant", "en", "ko", "th"]


def _scan():
    """Run the generator's resolver over all data to learn which keys are live."""
    sys.path.insert(0, ROOT)
    import importlib

    if "build" in sys.modules:
        importlib.reload(sys.modules["build"])
    import build  # noqa: F401  (import runs the resolution pass)

    langs = [l["code"] for l in json.load(open(os.path.join(DATA, "site.json"), encoding="utf-8"))["langs"]]
    return build.R, langs


def stats():
    mem = load_memory()
    print(f"memory entries: {len(mem)}")
    for lg in TARGETS:
        done = sum(1 for e in mem.values() if e.get(lg))
        print(f"  {lg}: {done}/{len(mem)}  ({done * 100 // max(len(mem), 1)}%)")
    locked = sum(1 for e in mem.values() if e.get("locked"))
    print(f"  human-written (locked): {locked}")


def todo(langs):
    mem = load_memory()
    out = {}
    for k, e in mem.items():
        gap = [lg for lg in langs if not e.get(lg)]
        if gap:
            row = {"ja": e["ja"]}
            for lg in gap:
                row[lg] = ""
            if e.get("path"):
                row["path"] = e["path"]
            out[k] = row
    path = os.path.join(DATA, "i18n-todo.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
        f.write("\n")
    chars = sum(len(v["ja"]) for v in out.values())
    print(f"{len(out)} strings need {', '.join(langs)} ({chars} source characters) -> {path}")
    if not out:
        print("nothing to translate")


def do_import(src, force=False):
    mem = load_memory()
    with open(src, encoding="utf-8") as f:
        incoming = json.load(f)
    added = skipped = 0
    for k, row in incoming.items():
        entry = mem.get(k)
        if entry is None:
            entry = mem[k] = {"ja": row.get("ja", ""), "locked": False}
            if row.get("path"):
                entry["path"] = row["path"]
        for lg in TARGETS:
            val = row.get(lg)
            if not val:
                continue
            if entry.get(lg) and entry.get("locked") and not force:
                skipped += 1
                continue
            entry[lg] = val
            added += 1
        for lg in TARGETS:
            entry.setdefault(lg, "")
    shutil.copy(MEM_FILE, MEM_FILE + ".bak")
    save_memory(mem)
    print(f"imported {added} translations, skipped {skipped} locked, backup at i18n.json.bak")


def prune():
    R, _ = _scan()
    mem = load_memory()
    dead = [k for k in mem if k not in R.used]
    if not dead:
        print("no orphan entries")
        return
    shutil.copy(MEM_FILE, MEM_FILE + ".bak")
    for k in dead:
        del mem[k]
    save_memory(mem)
    print(f"removed {len(dead)} orphan entries, backup at i18n.json.bak")


def lock(keys):
    mem = load_memory()
    for k in keys:
        if k in mem:
            mem[k]["locked"] = True
    save_memory(mem)
    print(f"locked {len(keys)} entries")


if __name__ == "__main__":
    a = sys.argv[1:]
    if not a or a[0] == "--stats":
        stats()
    elif a[0] == "--todo":
        todo(a[1:] or ["zh", "en"])
    elif a[0] == "--import":
        do_import(a[1], "--force" in a)
    elif a[0] == "--prune":
        prune()
    elif a[0] == "--lock":
        lock(a[1:])
    else:
        print(__doc__)
