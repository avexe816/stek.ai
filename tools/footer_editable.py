#!/usr/bin/env python3
"""フッターを管理画面から自由に増減できる形へ移行する（何度実行しても同じ結果）。

変更点
------
* footer.meta      : 運営会社 / 所在地 …… の行を追加・削除できる配列にする
* footer.columns   : リンク列そのものを追加・削除できる配列にする
                     auto="services" の列は事業内容を自動表示、"" の列は手入力
* footer.links     : 最下部（© の行）に並べるリンクの配列
* menu.footer      : footer.columns へ引き継いだうえで削除（二重管理を避ける）
* 旧キー削除       : company_label / address_label / services_title / nav_title

使い方: python3 tools/footer_editable.py
"""

import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, "data", "site.json")


def main():
    with open(SITE, encoding="utf-8") as fp:
        d = json.load(fp)

    f = d.setdefault("footer", {})
    menu = d.setdefault("menu", {})
    changed = []

    # ---- footer.meta（会社名・所在地などの行） ----
    if not isinstance(f.get("meta"), list):
        f["meta"] = [
            {"k": f.get("company_label") or "運営会社", "v": "{legal}"},
            {"k": f.get("address_label") or "所在地", "v": "{address}"},
        ]
        changed.append("footer.meta を追加（2行）")

    # ---- footer.columns（リンク列） ----
    if not isinstance(f.get("columns"), list):
        nav_items = [
            {"label": str(it.get("label") or ""), "link": str(it.get("link") or "")}
            for it in (menu.get("footer") or [])
            if isinstance(it, dict) and it.get("label") and it.get("link")
        ]
        f["columns"] = [
            {"title": f.get("services_title") or "事業内容", "auto": "services", "items": []},
            {"title": f.get("nav_title") or "サイトマップ", "auto": "", "items": nav_items},
        ]
        changed.append(f"footer.columns を追加（2列／サイトマップ {len(nav_items)}件）")

    # ---- footer.links（最下部のリンク） ----
    if not isinstance(f.get("links"), list):
        f["links"] = []
        changed.append("footer.links を追加（空）")

    # ---- 旧キーの削除 ----
    for k in ("company_label", "address_label", "services_title", "nav_title"):
        if k in f:
            del f[k]
            changed.append(f"footer.{k} を削除")
    if "footer" in menu:
        del menu["footer"]
        changed.append("menu.footer を削除（footer.columns へ移動）")

    # ---- キーの並び順を整える（管理画面の表示順） ----
    order = [
        "tagline", "meta", "columns",
        "contact_title", "contact_lead", "contact_btn",
        "copyright", "privacy", "links",
    ]
    d["footer"] = {k: f[k] for k in order if k in f} | {k: v for k, v in f.items() if k not in order}

    if not changed:
        print("すでに移行済みです。変更はありません。")
        return

    with open(SITE, "w", encoding="utf-8") as fp:
        json.dump(d, fp, ensure_ascii=False, indent=2)
        fp.write("\n")
    for c in changed:
        print("・" + c)
    print(f"-> {SITE}")


if __name__ == "__main__":
    main()
