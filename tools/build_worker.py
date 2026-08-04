# -*- coding: utf-8 -*-
"""src/ の各モジュールを 1 本の _worker.js にまとめる。

Cloudflare Pages の advanced mode は単一ファイルの _worker.js を読み込むため、
バンドラを使わずに単純連結する。build.py から自動で呼ばれる。
"""
import io
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
PARTS = ["admin_translate.js", "admin_api.js", "worker_contact.js", "worker_main.js"]

HEADER = """/* ============================================================================
 * stek.ai — Cloudflare Pages worker（自動生成ファイル）
 *
 *   このファイルは直接編集しないでください。
 *   編集するのは src/ の中の各ファイルで、build.py が自動でまとめ直します。
 *
 *     src/admin_translate.js 自動翻訳（Workers AI）
 *     src/admin_api.js       管理画面 API（/api/admin/*）
 *     src/worker_contact.js  お問い合わせメール送信
 *     src/worker_main.js     ルーティング
 * ==========================================================================*/

import { connect } from "cloudflare:sockets";
"""


def build():
    out = [HEADER]
    for name in PARTS:
        path = os.path.join(SRC, name)
        out.append(f"\n// ==== src/{name} " + "=" * (60 - len(name)) + "\n")
        out.append(io.open(path, encoding="utf-8").read())
    text = "".join(out)
    io.open(os.path.join(ROOT, "_worker.js"), "w", encoding="utf-8").write(text)
    return len(text)


if __name__ == "__main__":
    print(f"_worker.js: {build()} bytes")
