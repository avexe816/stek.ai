#!/usr/bin/env python3
"""data/site.json の中の日本語文字列を洗い出して data/_strings.json に書き出す。

翻訳作業用の下ごしらえ。キーは i18n.py と同じ sha1(ja)[:16]。
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from tools.i18n import key_of, needs_translation  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")

SKIP_KEYS = {"id", "no", "k_raw"}


def walk(node, out, path=""):
    if isinstance(node, str):
        if needs_translation(node):
            out.setdefault(key_of(node), {"ja": node, "paths": []})["paths"].append(path)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            walk(v, out, f"{path}[{i}]")
    elif isinstance(node, dict):
        for k, v in node.items():
            if k in SKIP_KEYS:
                continue
            walk(v, out, f"{path}.{k}" if path else k)


def main():
    site = json.load(open(os.path.join(DATA, "site.json"), encoding="utf-8"))
    out = {}
    walk(site, out)
    with open(os.path.join(DATA, "_strings.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    total_chars = sum(len(v["ja"]) for v in out.values())
    print(f"{len(out)} strings, {total_chars} chars -> data/_strings.json")


if __name__ == "__main__":
    main()
