#!/usr/bin/env python3
"""dist/ の静的チェック。build.py のあとに実行する。

    python3 build.py && python3 tools/check_site.py

見るもの:
  1. サイト内リンクの行き先が実在するか（リンク切れ）
  2. title / description / canonical / og:image が全ページに入っているか
  3. title と description の長さ（検索結果で切れないか）
  4. sitemap.xml の件数がページ数と合っているか
  5. 提供状況ラベルが、決めた語彙から外れていないか
"""

import json
import os
import re
import sys
from urllib.parse import urlparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist")
SITE_URL = "https://stek.ai"

TITLE_RANGE = (16, 40)
DESC_RANGE = (60, 130)

# 使ってよい提供状況ラベル。ここに無い語が出たら書き間違いを疑う。
ALLOWED_STATUS = {
    "提供中", "開発中", "開発中・先行導入のご相談受付中", "先行導入受付中",
    "構想中", "準備中", "実装済み", "ProofKeepingで提供",
}

RE_HREF = re.compile(r'href="([^"]+)"')
RE_TITLE = re.compile(r"<title>(.*?)</title>", re.S)
RE_DESC = re.compile(r'<meta name="description" content="([^"]*)"')
RE_CANON = re.compile(r'<link rel="canonical" href="([^"]+)"')
RE_OG = re.compile(r'<meta property="og:image" content="([^"]+)"')
RE_BADGE = re.compile(r'<span class="badge[^"]*">([^<]*)</span>')


def html_files():
    for base, _dirs, files in os.walk(DIST):
        if os.sep + "admin" in base:
            continue
        for f in files:
            if f.endswith(".html"):
                yield os.path.join(base, f)


def exists(path):
    """/products/proofkeeping/ のような URL が dist に実在するか"""
    p = path.lstrip("/")
    cand = [os.path.join(DIST, p)]
    if p.endswith("/") or p == "":
        cand.append(os.path.join(DIST, p, "index.html"))
    else:
        cand.append(os.path.join(DIST, p + "/index.html"))
    return any(os.path.exists(c) for c in cand)


def main():
    if not os.path.isdir(DIST):
        print("dist/ がありません。先に python3 build.py を実行してください。")
        return 1

    errors, warns = [], []
    files = sorted(html_files())

    for f in files:
        rel = os.path.relpath(f, DIST)
        doc = open(f, encoding="utf-8").read()

        # 1. リンク切れ
        for href in RE_HREF.findall(doc):
            if href.startswith(("http://", "https://", "mailto:", "tel:", "#", "data:")):
                continue
            target = urlparse(href).path
            if not target or target.startswith("/assets/"):
                continue
            if not exists(target):
                errors.append(f"[リンク切れ] {rel} → {href}")

        # 2〜3. head の中身
        m = RE_TITLE.search(doc)
        if not m or not m.group(1).strip():
            errors.append(f"[title なし] {rel}")
        else:
            n = len(m.group(1).strip())
            if not (TITLE_RANGE[0] <= n <= TITLE_RANGE[1]):
                warns.append(f"[title の長さ {n}] {rel}（目安 {TITLE_RANGE[0]}〜{TITLE_RANGE[1]}）")
        m = RE_DESC.search(doc)
        if not m or not m.group(1).strip():
            errors.append(f"[description なし] {rel}")
        else:
            n = len(m.group(1).strip())
            if not (DESC_RANGE[0] <= n <= DESC_RANGE[1]):
                warns.append(f"[description の長さ {n}] {rel}（目安 {DESC_RANGE[0]}〜{DESC_RANGE[1]}）")
        if not RE_CANON.search(doc):
            errors.append(f"[canonical なし] {rel}")
        if not RE_OG.search(doc):
            errors.append(f"[og:image なし] {rel}")

        # 5. 提供状況ラベル（日本語ページのみ。訳文は語彙が変わるため見ない）
        for label in ([] if rel.startswith("en" + os.sep) else RE_BADGE.findall(doc)):
            label = label.strip()
            if label and label not in ALLOWED_STATUS:
                warns.append(f"[見慣れない提供状況ラベル「{label}」] {rel}")

    # 4. sitemap
    sm = os.path.join(DIST, "sitemap.xml")
    if not os.path.exists(sm):
        errors.append("[sitemap.xml がありません]")
    else:
        locs = re.findall(r"<loc>([^<]+)</loc>", open(sm, encoding="utf-8").read())
        if len(locs) != len(files):
            warns.append(f"[sitemap の件数 {len(locs)} と HTML の枚数 {len(files)} が違います]")
        for loc in locs:
            if not exists(urlparse(loc).path):
                errors.append(f"[sitemap の行き先がありません] {loc}")

    print(f"検査したページ: {len(files)} 枚")
    for w in warns:
        print("  警告 " + w)
    for e in errors:
        print("  エラー " + e)
    if errors:
        print(f"\nエラー {len(errors)} 件、警告 {len(warns)} 件")
        return 1
    print(f"\nエラーなし（警告 {len(warns)} 件）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
