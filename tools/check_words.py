#!/usr/bin/env python3
"""公開文言の禁止語チェック。

ProofKeeping 側（avexe816/proofkeeping）の実装契約 PK-IMPL-CONTRACT 第5章と
DECISIONS #174 は、禁止語の規則を **顧客向け文書にも** 当てることを求めている。
理由は、文書が抜粋されて回るため。否定形（「不正ではありません」）も使わない。
抜粋されたときに否定が落ちると、製品が主張していない意味になるため。

    python3 tools/check_words.py          # data/site.json を検査
    python3 tools/check_words.py --strict # 見つかったら終了コード 1

ビルドからも呼ばれる（警告のみ。ビルドは止めない）。
"""

import argparse
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, "data", "site.json")

# PK-IMPL-CONTRACT §5.1 の禁止語。否定形でも使わない。
BANNED = [
    ("不正", "使わない。P4 は判定する仕組みではない"),
    ("無断宿泊", "使わない"),
    ("検知", "「記録」「お知らせ」に言い換える"),
    ("監視", "「記録」に言い換える"),
    ("不審", "「気づいたこと」に言い換える"),
    ("疑い", "使わない"),
    ("異常", "「通常と違う点」に言い換える"),
    ("報告義務", "「記録のお願い」に言い換える"),
    ("不備あり", "「記録された内容」に言い換える"),
]

# PK-BIZ-PLAN §8.2「使わない説明」。語の並びで引っかける。
BANNED_PHRASES = [
    ("生産性を可視化", "記録を評価に使わない方針に反する"),
    ("作業時間を短縮", "短縮は目的ではない。記録が目的"),
    ("差異率を0%", "0% にはならない"),
    ("完全に自動", "過大表現"),
    ("業界を変革", "過大表現"),
]

# 誤検出を避けるための除外。前後の文脈まで一致したら見逃す。
ALLOW = [
    "設備不具合",   # 「不具合」は禁止語ではない（「不備あり」だけが対象）
]


def walk(node, path=""):
    if isinstance(node, str):
        yield path, node
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from walk(v, f"{path}[{i}]")
    elif isinstance(node, dict):
        for k, v in node.items():
            yield from walk(v, f"{path}.{k}" if path else k)


def check(site):
    hits = []
    for path, text in walk(site):
        for word, why in BANNED + BANNED_PHRASES:
            idx = text.find(word)
            while idx >= 0:
                around = text[max(0, idx - 6):idx + len(word) + 6]
                if not any(a in around for a in ALLOW):
                    hits.append((path, word, why, around))
                    break
                idx = text.find(word, idx + 1)
    return hits


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--strict", action="store_true")
    a = ap.parse_args()
    with open(SITE, encoding="utf-8") as f:
        site = json.load(f)
    hits = check(site)
    if not hits:
        print("禁止語チェック: 問題ありません")
        return 0
    print(f"禁止語チェック: {len(hits)} 件")
    for path, word, why, around in hits:
        print(f"  [{word}] {path}\n      …{around}…\n      → {why}")
    return 1 if a.strict else 0


if __name__ == "__main__":
    sys.exit(main())
