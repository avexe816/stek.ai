#!/usr/bin/env python3
"""stek.ai static site builder.

日本語が唯一の原稿言語。data/site.json の日本語を data/i18n.json の
翻訳メモリで各言語に解決し、言語 × ページ分の静的 HTML を dist/ に出力する。

    python3 build.py            # dist/ に全言語を書き出す
    python3 build.py --lang ja  # 1言語だけ
"""

import argparse
import html
import json
import re
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tools.i18n import Resolver  # noqa: E402
from tools.build_worker import build as build_worker  # noqa: E402

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data")
DIST = os.path.join(ROOT, "dist")

SITE_URL = "https://stek.ai"

LANGS = [
    # code,      html lang, label,      short
    ("ja",       "ja",      "日本語",     "JA"),
    ("en",       "en",      "English",  "EN"),
    # 公開停止中（翻訳データは data/i18n.json に残してあるので、行を戻せば復活します）
    # ("zh",       "zh-Hans", "简体中文",   "简"),
    # ("zh-Hant",  "zh-Hant", "繁體中文",   "繁"),
    # ("ko",       "ko",      "한국어",     "KO"),
]
LANG_DIR = {"ja": "", "en": "en", "zh": "zh", "zh-Hant": "zh-hant", "ko": "ko"}

# ページ名。"/" を含むものはディレクトリ形式（/products/proofkeeping/）で出力する。
PAGES = [
    "index", "services", "news", "about", "contact", "privacy",
    "products/proofkeeping", "products/stek-ops", "services/it-support",
]

# ページ名 → data/site.json の meta.<key>_title / _desc
META_KEY = {
    "index": "home",
    "services": "services",
    "news": "news",
    "about": "about",
    "contact": "contact",
    "privacy": "privacy",
    "products/proofkeeping": "proofkeeping",
    "products/stek-ops": "stek_ops",
    "services/it-support": "itsupport",
}

RE_SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$")
NAV = [("index", "home"), ("services", "services"), ("about", "about"), ("contact", "contact")]

def img_tag(name, *, cls="", w=1200, hgt=750, eager=False, alt=""):
    """画像名（拡張子なし）から <img> を作る。未設定なら何も出さない。"""
    n = str(name or "").strip()
    if not n:
        return ""
    a = f' class="{cls}"' if cls else ""
    load = ' fetchpriority="high"' if eager else ' loading="lazy"'
    return (f'<img src="/assets/img/{n}.webp" srcset="/assets/img/{n}-sm.webp 900w, /assets/img/{n}.webp 1800w" '
            f'sizes="(max-width:800px) 100vw, 50vw" alt="{alt}" width="{w}" height="{hgt}"{load}{a}>')

# HTML 属性の断片。f-string の式の中に \" を書くと Python 3.11 以前で
# SyntaxError になるため、定数に切り出して差し込む。
ATTR_CURRENT_PAGE = ' aria-current="page"'
ATTR_CURRENT_TRUE = ' aria-current="true"'
ATTR_EXTERNAL = ' target="_blank" rel="noopener"'

SVC_ICON = {
    # 収益管理・IT・Web — 上昇するグラフ
    "tech": '<svg class="svc-ico" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 26h24"/><path d="M4 22V10M11 22v-7M18 22v-12M25 22V6"/><path d="M4 10l7 5 7-9 7 4" stroke-dasharray="0"/></svg>',
    # 運営受託 — 建物と鍵
    "operation": '<svg class="svc-ico" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 27V8l9-4v23"/><path d="M14 13h13v14"/><path d="M5 27h24"/><path d="M9 12h1M9 17h1M9 22h1M19 18h1M23 18h1M19 23h1M23 23h1"/></svg>',
    # 清掃・リネン — ベッドと輝き
    "facility": '<svg class="svc-ico" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 25v-9h20a5 5 0 0 1 5 5v4"/><path d="M3 25h25"/><path d="M3 16v-7"/><path d="M8 16v-3h7v3"/><path d="M24 4l1.2 2.8L28 8l-2.8 1.2L24 12l-1.2-2.8L20 8l2.8-1.2z"/></svg>',
    # 不動産活用 — 敷地と拡大
    "asset": '<svg class="svc-ico" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4h11v11H4z"/><path d="M4 20h11v8H4z"/><path d="M20 4h8v8h-8z"/><circle cx="23" cy="21" r="5"/><path d="M27 25l2.5 2.5"/></svg>',
}

# 管理画面から事業領域を増やしたときのための既定アイコン（丸に点）。
# SVC_ICON に無い id でもビルドが止まらないようにする。
SVC_ICON_DEFAULT = '<svg class="svc-ico" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="16" cy="16" r="11"/><circle cx="16" cy="16" r="3" fill="currentColor" stroke="none"/></svg>'


def svc_icon(sid):
    return SVC_ICON.get(str(sid or ""), SVC_ICON_DEFAULT)


def e(s):
    return html.escape(str(s), quote=True)


def nl2br(s):
    return "<br>".join(e(p) for p in str(s).split("\n"))


def para(s):
    return "".join(f"<p>{nl2br(p)}</p>" for p in str(s).split("\n\n") if p.strip())


def url(lang, page):
    d = LANG_DIR[lang]
    base = f"/{d}/" if d else "/"
    if page == "index":
        return base
    if "/" in page:  # 製品ページなどの階層パスはディレクトリ形式
        return f"{base}{page}/"
    return f"{base}{page}.html"


def out_path(outdir, page):
    """dist 内の書き出し先。階層パスは <dir>/index.html にする。"""
    if page == "index":
        return os.path.join(outdir, "index.html")
    if "/" in page:
        return os.path.join(outdir, *page.split("/"), "index.html")
    return os.path.join(outdir, f"{page}.html")


# 提供状況ラベル → バッジの見た目。文字だけでも意味が伝わるようにし、
# 色だけで区別しない（ラベル文字列そのものを必ず表示する）。
def status_class(text):
    s = str(text or "")
    if not s.strip():
        return ""
    if "構想" in s:
        return "concept"
    if "準備" in s:
        return "prep"
    if "開発" in s or "先行" in s:
        return "dev"
    if "提供" in s or "実装" in s:
        return "live"
    return "dev"


def badge(text, *, small=False):
    s = str(text or "").strip()
    if not s:
        return ""
    cls = f"badge badge--{status_class(s)}" + (" badge--sm" if small else "")
    return f'<span class="{cls}">{e(s)}</span>'


# ------------------------------------------------------------------ chunks
LOGO_SVG = """<svg class="mark" viewBox="48 60 309 278" fill="none" aria-hidden="true"><path fill="var(--logo-leaf,#5E8B72)" d="M234.80 265.97C234.19 265.29 234.16 263.99 234.00 224.22C233.83 183.17 233.83 183.17 232.39 179.00C229.14 169.61 223.69 163.79 214.15 159.51C210.01 157.65 208.79 156.71 208.34 155.02C207.56 152.13 208.06 75.40 208.87 73.67C212.01 66.96 218.82 63.91 227.11 65.50C228.55 65.78 230.82 66.00 232.16 66.00C233.69 66.00 235.81 66.32 237.87 66.85C239.67 67.32 242.21 67.84 243.53 68.00C244.84 68.17 247.02 68.67 248.37 69.13C249.73 69.58 252.68 70.49 254.95 71.17C257.21 71.84 260.06 72.84 261.28 73.39C262.50 73.94 264.93 74.97 266.69 75.67C271.92 77.76 277.30 80.41 281.01 82.73C282.93 83.92 285.55 85.48 286.83 86.18C288.12 86.88 290.30 88.33 291.69 89.39C293.08 90.45 295.35 92.11 296.75 93.08C303.17 97.52 314.56 108.45 320.29 115.67C327.38 124.59 330.09 128.19 330.91 129.83C331.38 130.75 332.77 133.08 334.01 135.01C336.34 138.63 340.85 147.86 342.16 151.68C342.58 152.88 343.44 155.07 344.09 156.55C344.74 158.03 345.61 160.34 346.01 161.70C346.41 163.06 347.41 166.19 348.22 168.67C349.03 171.14 349.83 174.17 349.98 175.40C350.14 176.63 350.65 179.25 351.11 181.23C354.58 196.11 355.31 221.14 352.46 227.61C349.51 234.31 345.84 235.27 331.95 232.97C324.92 231.81 305.78 231.51 301.33 232.49C300.14 232.76 297.89 233.22 296.33 233.52C285.82 235.55 274.87 239.25 268.83 242.80C267.18 243.77 264.71 245.15 263.33 245.87C261.96 246.58 259.35 248.26 257.55 249.61C255.74 250.95 253.19 252.73 251.88 253.56C250.42 254.49 247.38 257.17 244.00 260.50C237.31 267.09 236.34 267.67 234.80 265.97ZM167.50 265.61C166.43 265.03 164.11 262.71 161.63 259.76C160.36 258.26 158.31 256.31 157.08 255.44C155.84 254.57 153.66 252.91 152.22 251.76C142.05 243.63 122.92 235.34 110.00 233.49C107.89 233.18 105.07 232.73 103.72 232.47C100.09 231.77 79.40 231.81 76.17 232.52C74.88 232.80 72.79 233.26 71.51 233.54C60.47 235.92 54.25 232.84 52.38 224.07C51.79 221.31 51.87 200.03 52.49 195.67C52.76 193.74 53.22 190.29 53.51 188.00C53.80 185.71 54.47 181.96 54.99 179.67C55.51 177.38 56.03 174.63 56.14 173.57C56.35 171.56 56.86 169.91 60.43 159.67C66.41 142.53 74.31 128.74 86.08 114.93C87.59 113.15 89.97 110.35 91.37 108.71C93.85 105.78 94.95 104.72 102.70 97.75C110.34 90.88 126.61 80.53 135.64 76.79C136.84 76.28 139.55 75.15 141.65 74.26C143.76 73.37 146.76 72.25 148.32 71.78C149.89 71.31 152.59 70.49 154.33 69.96C162.42 67.50 169.44 66.00 172.87 66.00C174.68 66.00 177.52 65.76 179.17 65.46C188.64 63.78 194.84 67.50 196.63 75.93C197.11 78.23 197.16 153.29 196.67 154.97C196.16 156.76 195.10 157.64 191.16 159.50C180.38 164.60 173.43 173.71 171.93 184.72C171.48 188.00 171.48 188.64 171.85 198.17C172.04 203.14 171.98 204.84 171.48 208.11C170.91 211.85 170.91 212.23 171.44 215.61C172.19 220.29 172.22 231.92 171.50 236.00C171.12 238.18 171.00 241.71 171.00 251.23C171.00 266.19 170.71 267.38 167.50 265.61Z"/><path fill="var(--logo-stem,#C29A3C)" d="M184.22 334.53C181.88 333.67 179.75 330.91 178.62 327.27C177.26 322.90 180.28 317.72 185.11 316.14C192.12 313.84 204.74 304.11 209.67 297.20C210.31 296.30 211.30 294.90 211.88 294.09C212.46 293.28 213.27 292.25 213.69 291.80C214.12 291.35 215.97 288.03 217.82 284.41C221.73 276.72 221.40 277.01 226.44 277.00C232.98 277.00 232.96 276.87 228.67 290.17C226.28 297.60 222.04 306.68 219.05 310.83C218.12 312.12 216.44 314.52 215.31 316.17C213.11 319.38 205.81 327.04 203.33 328.75C202.51 329.32 201.34 330.21 200.73 330.73C196.65 334.24 188.51 336.12 184.22 334.53Z"/></svg>"""

ARROW = """<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.5 8h11m0 0L9 3.5M13.5 8 9 12.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>"""

THEME_SVG = """<svg class="i-moon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg><svg class="i-sun" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="4.2" stroke="currentColor" stroke-width="1.6"/><path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4 17 7M7 17l-1.6 1.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>"""

GLOBE_SVG = """<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" style="width:15px;height:15px"><circle cx="12" cy="12" r="8.6" stroke="currentColor" stroke-width="1.5"/><path d="M3.5 12h17M12 3.4c2.3 2.4 3.4 5.4 3.4 8.6S14.3 18.2 12 20.6c-2.3-2.4-3.4-5.4-3.4-8.6S9.7 5.8 12 3.4Z" stroke="currentColor" stroke-width="1.5"/></svg>"""


def head(t, page, lang, s, custom=None):
    if custom is not None:
        title = f"{custom.get('title','')}｜{s['brand']['legal']}"
        desc = custom.get("desc") or custom.get("lead") or t["meta"]["home_desc"]
    else:
        key = META_KEY[page]
        title = t["meta"][f"{key}_title"]
        desc = t["meta"][f"{key}_desc"]
    hl = dict((c, h) for c, h, _l, _s in LANGS)[lang]
    alts = "\n  ".join(
        f'<link rel="alternate" hreflang="{dict((c,h) for c,h,_l,_s in LANGS)[c]}" href="{SITE_URL}{url(c, page)}">'
        for c, _h, _l, _s in LANGS
    )
    return f"""<!doctype html>
<html lang="{hl}" data-theme="light">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{e(title)}</title>
  <meta name="description" content="{e(desc)}">
  <meta property="og:title" content="{e(title)}">
  <meta property="og:description" content="{e(desc)}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="{e(s['brand']['legal'])}">
  <meta property="og:image" content="{SITE_URL}/assets/img/{e(s['meta'].get('og_img') or 'hero')}.webp">
  <meta name="theme-color" content="#0F3A2C">
  <link rel="canonical" href="{SITE_URL}{url(lang, page)}">
  {alts}
  <link rel="alternate" hreflang="x-default" href="{SITE_URL}{url('ja', page)}">
  <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700&family=BIZ+UDPGothic:wght@400;700&family=Outfit:wght@400;500;600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/assets/style.css">
  <script>(function(){{try{{var t=localStorage.getItem('stek-theme');if(!t)t=matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light';document.documentElement.dataset.theme=t;}}catch(e){{}}}})();</script>
</head>
<body>
<a class="skip" href="#main">{e(t['common']['skip'])}</a>
"""


def resolve_link(lang, link):
    """管理画面で入力されたリンク先を実際の URL に変換する。

    - ページ名（index / services / about / contact / privacy）→ 言語別のページ URL
    - "#flow" のようなページ内リンク → トップページの該当位置
    - "/" や "http" や "mailto:" で始まるもの → そのまま
    """
    link = str(link or "").strip()
    if not link:
        return ""
    if link in PAGES:
        return url(lang, link)
    if link.startswith("#"):
        return url(lang, "index") + link
    if link.startswith(("http://", "https://", "mailto:", "tel:", "/")):
        return link
    if RE_SLUG.match(link):  # 管理画面で追加した自由ページ
        return url(lang, link)
    return "/" + link.lstrip("/")


def menu_items(t, kind):
    src = (t.get("menu") or {}).get(kind) or []
    out = []
    for it in src:
        if not isinstance(it, dict):
            continue
        label = str(it.get("label") or "").strip()
        link = str(it.get("link") or "").strip()
        if label and link:
            out.append((label, link))
    return out


def is_ext(link):
    return link.startswith(("http://", "https://"))


def header(t, page, lang, s):
    items = menu_items(t, "header")
    nav = "".join(
        f'<a href="{resolve_link(lang, lk)}"'
        f'{ATTR_CURRENT_PAGE if lk == page else ""}'
        f'{ATTR_EXTERNAL if is_ext(lk) else ""}'
        f'>{e(lb)}</a>'
        for lb, lk in items
    )
    langs = "".join(
        f'<a href="{url(c, page)}" hreflang="{h}"{ATTR_CURRENT_TRUE if c == lang else ""}>{e(l)}<i>{e(sh)}</i></a>'
        for c, h, l, sh in LANGS
    )
    cur = next(sh for c, _h, _l, sh in LANGS if c == lang)
    mob = "".join(
        f'<a href="{resolve_link(lang, lk)}"'
        f'{ATTR_EXTERNAL if is_ext(lk) else ""}>{e(lb)}</a>'
        for lb, lk in items
    )
    return f"""<header class="hd">
  <div class="wrap hd-in">
    <a class="logo" href="{url(lang, 'index')}" aria-label="{e(s['brand']['legal'])}">{LOGO_SVG}<b>stek</b><span>{e(s['brand']['tagline'])}</span></a>
    <nav class="nav" aria-label="main">{nav}</nav>
    <div class="hd-tools">
      <div class="langw">
        <button class="icon-btn langb" id="langbtn" aria-haspopup="true" aria-expanded="false" aria-label="{e(t['common']['lang_label'])}">{GLOBE_SVG}<span>{e(cur)}</span></button>
        <div class="langm" id="langm">{langs}</div>
      </div>
      <button class="icon-btn" id="theme" aria-label="Theme">{THEME_SVG}</button>
      <a class="btn btn-p" href="{url(lang, 'contact')}">{e(t['nav']['cta'])}</a>
      <button class="icon-btn burger" id="burger" aria-label="{e(t['common']['menu'])}" aria-expanded="false">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
      </button>
    </div>
  </div>
  <div class="mob" id="mob">{mob}<a class="btn btn-p" href="{url(lang, 'contact')}">{e(t['nav']['cta'])}</a></div>
</header>
"""


def footer_meta_value(text, t, s):
    """{legal} {address} {tel} {hours} を「会社の基本情報」から差し込む。"""
    out = str(text or "")
    if "{" not in out:
        return out
    brand_ja = s.get("brand") or {}
    brand_tr = t.get("brand") or {}
    for token, key, src in (
        ("{legal}", "legal", brand_ja),
        ("{name}", "name", brand_ja),
        ("{address}", "address", brand_tr),
        ("{tel}", "tel", brand_tr),
        ("{hours}", "hours", brand_tr),
        ("{domain}", "domain", brand_ja),
    ):
        if token in out:
            out = out.replace(token, str(src.get(key) or ""))
    return out


def footer_columns(t):
    """フッターのリンク列。管理画面の footer.columns が正。

    旧データ（footer.services_title / footer.nav_title / menu.footer）しか無い
    ときは、それを組み立て直して同じ形にする。
    """
    cols = (t.get("footer") or {}).get("columns")
    if isinstance(cols, list):
        out = []
        for c in cols:
            if not isinstance(c, dict):
                continue
            title = str(c.get("title") or "").strip()
            auto = str(c.get("auto") or "").strip()
            items = [
                (str(it.get("label") or "").strip(), str(it.get("link") or "").strip())
                for it in (c.get("items") or [])
                if isinstance(it, dict)
            ]
            items = [(lb, lk) for lb, lk in items if lb and lk]
            if not title and not items and not auto:
                continue
            out.append({"title": title, "auto": auto, "items": items})
        return out
    f = t.get("footer") or {}
    legacy = []
    if f.get("services_title"):
        legacy.append({"title": f["services_title"], "auto": "services", "items": []})
    if f.get("nav_title"):
        legacy.append({"title": f["nav_title"], "auto": "", "items": menu_items(t, "footer")})
    return legacy


def footer_meta_rows(t, s):
    f = t.get("footer") or {}
    rows = f.get("meta")
    if isinstance(rows, list):
        out = []
        for r in rows:
            if not isinstance(r, dict):
                continue
            k = str(r.get("k") or "").strip()
            v = footer_meta_value(r.get("v"), t, s).strip()
            if k or v:
                out.append((k, v))
        return out
    out = []
    if f.get("company_label"):
        out.append((f["company_label"], (s.get("brand") or {}).get("legal", "")))
    if f.get("address_label"):
        out.append((f["address_label"], (t.get("brand") or {}).get("address", "")))
    return out


def footer(t, page, lang, s):
    f = t["footer"]

    meta = "".join(
        f"<div><dt>{e(k)}</dt><dd>{e(v)}</dd></div>" for k, v in footer_meta_rows(t, s)
    )
    meta_html = f'<dl class="ft-meta">{meta}</dl>' if meta else ""

    cols_html = ""
    n_cols = 0
    for col in footer_columns(t):
        if col["auto"] == "services":
            li = "".join(
                f'<li><a href="{url(lang, "services")}#{sv["id"]}">{e(sv["name"])}</a></li>'
                for sv in t["services"]
            )
        elif col["auto"] == "posts":
            li = "".join(
                f'<li><a href="{url(lang, "news")}">{e(p.get("title", ""))}</a></li>'
                for p in (t.get("posts") or [])[:5]
            )
        else:
            li = "".join(
                f'<li><a href="{resolve_link(lang, lk)}"'
                f'{ATTR_EXTERNAL if is_ext(lk) else ""}>{e(lb)}</a></li>'
                for lb, lk in col["items"]
            )
        if not li and not col["title"]:
            continue
        head_html = f"<h3>{e(col['title'])}</h3>" if col["title"] else ""
        cols_html += f"<div>{head_html}<ul>{li}</ul></div>"
        n_cols += 1

    has_cta = bool(f.get("contact_title") or f.get("contact_lead") or f.get("contact_btn"))
    cta_html = ""
    if has_cta:
        btn = (
            f'<a class="btn btn-l" href="{url(lang, "contact")}">{e(f["contact_btn"])}{ARROW}</a>'
            if f.get("contact_btn")
            else ""
        )
        cta_html = f"""<div class="ft-cta">
        {f'<h3>{e(f["contact_title"])}</h3>' if f.get("contact_title") else ""}
        {f'<p class="ft-cta-lead">{e(f["contact_lead"])}</p>' if f.get("contact_lead") else ""}
        {btn}
      </div>"""

    grid = "1.5fr" + " .85fr" * max(n_cols, 0) + (" 1.15fr" if has_cta else "")

    btm = []
    if f.get("copyright"):
        btm.append(f"<span>© {e(f['copyright'])}</span>")
    if f.get("privacy"):
        btm.append(f'<a href="{url(lang, "privacy")}">{e(f["privacy"])}</a>')
    for it in (f.get("links") or []):
        if not isinstance(it, dict):
            continue
        lb, lk = str(it.get("label") or "").strip(), str(it.get("link") or "").strip()
        if lb and lk:
            ext = ' target="_blank" rel="noopener"' if is_ext(lk) else ""
            btm.append(f'<a href="{resolve_link(lang, lk)}"{ext}>{e(lb)}</a>')
    btm_html = f'<div class="ft-btm">{"".join(btm)}</div>' if btm else ""

    return f"""<footer class="ft">
  <div class="wrap">
    <div class="ft-in" style="--ft-grid:{grid}">
      <div class="ft-brand">
        <a class="logo" href="{url(lang, 'index')}">{LOGO_SVG}<b>stek</b><span>{e(s['brand']['tagline'])}</span></a>
        {f'<p>{e(f["tagline"])}</p>' if f.get("tagline") else ""}
        {meta_html}
      </div>
      {cols_html}
      {cta_html}
    </div>
    {btm_html}
  </div>
</footer>
<script src="/assets/app.js" defer></script>
</body>
</html>
"""


def cta_band(t, lang):
    h = t["home"]
    return f"""<section class="cta"><div class="wrap cta-in">
  <div><h2>{nl2br(h['cta_title'])}</h2><p>{e(h['cta_lead'])}</p></div>
  <a class="btn btn-l btn-lg" href="{url(lang, 'contact')}">{e(h['cta_button'])}{ARROW}</a>
</div></section>"""


# ------------------------------------------------------------------- pages
#
# トップページは data/site.json の sections[] が正。
# 並び順も表示・非表示も、管理画面の「トップページの構成」で変えられる。

HIDE_WORDS = {"非表示", "off", "OFF", "no", "なし", "隠す"}

PRODUCT_ICON = {
    # ProofKeeping — チェック付きのボード
    "proofkeeping": '<svg class="p-ico" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5H8a2 2 0 0 0-2 2v19a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3"/><rect x="11" y="3" width="10" height="5" rx="1.4"/><path d="m11 16 3 3 6.5-7"/><path d="M11 24h10"/></svg>',
    # STEK OPS — つながる 4 つの点
    "stek-ops": '<svg class="p-ico" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="16" cy="16" r="3.4"/><circle cx="7" cy="7" r="2.6"/><circle cx="25" cy="7" r="2.6"/><circle cx="7" cy="25" r="2.6"/><circle cx="25" cy="25" r="2.6"/><path d="m9 9 4.6 4.6M23 9l-4.6 4.6M9 23l4.6-4.6M23 23l-4.6-4.6"/></svg>',
}

PRODUCT_ICON_DEFAULT = '<svg class="p-ico" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="5" width="22" height="22" rx="3"/><path d="M11 16h10"/></svg>'


def by_id(rows):
    return {str(r.get("id") or ""): r for r in (rows or []) if isinstance(r, dict)}


def orig_status(s, pid):
    """バッジの色は日本語の原文から決める（英語版でも同じ色になるように）。"""
    p = by_id(s.get("products")).get(pid) or {}
    return status_class(p.get("status"))


def product_features(p, s_p):
    """機能一覧。note（前提条件・構想中など）が入っていれば併記する。"""
    out = []
    s_feats = (s_p or {}).get("features") or []
    for i, ft in enumerate(p.get("features") or []):
        if not isinstance(ft, dict):
            continue
        text = str(ft.get("text") or "").strip()
        if not text:
            continue
        note = str(ft.get("note") or "").strip()
        s_note = ""
        if i < len(s_feats) and isinstance(s_feats[i], dict):
            s_note = str(s_feats[i].get("note") or "").strip()
        note_html = ""
        if note:
            cls = status_class(s_note or note)
            note_html = f'<span class="p-note p-note--{cls}">{e(note)}</span>'
        out.append(f"<li>{e(text)}{note_html}</li>")
    return "".join(out)


# ---------------------------------------------------------------- sections
def sec_hero(t, lang, s, alt):
    h = t["home"]
    c1 = resolve_link(lang, h.get("hero_cta1_link") or "contact")
    c2 = resolve_link(lang, h.get("hero_cta2_link") or "contact")
    return f"""<section class="hero"><div class="wrap hero-in">
  <div>
    <p class="eyebrow">{e(h['hero_eyebrow'])}</p>
    <h1>{nl2br(h['hero_title'])}</h1>
    <p class="lead">{e(h['hero_lead'])}</p>
    <div class="hero-cta">
      <a class="btn btn-p btn-lg" href="{c1}">{e(h['hero_cta1'])}{ARROW}</a>
      <a class="btn btn-o btn-lg" href="{c2}">{e(h['hero_cta2'])}</a>
    </div>
    <p class="small hero-note">{e(h['hero_note'])}</p>
  </div>
  <figure class="hero-fig">
    {img_tag(h.get('hero_img'), w=1200, hgt=960, eager=True)}
  </figure>
</div></section>"""


def sec_problem(t, lang, s, alt):
    h = t["home"]
    cards = "".join(
        f"""<li class="pb rv"><h3>{e(p.get('title',''))}</h3>"""
        + (f"<p>{e(p['body'])}</p>" if p.get("body") else "")
        + "</li>"
        for p in (h.get("problems") or []) if isinstance(p, dict) and p.get("title")
    )
    if not cards:
        return ""
    return f"""<section class="sec{alt}" id="problem"><div class="wrap">
  <div class="sec-head">
    <p class="eyebrow">{e(h.get('problem_eyebrow',''))}</p>
    <h2 class="h-sec">{e(h.get('problem_title',''))}</h2>
    <p class="lead">{e(h.get('problem_body',''))}</p>
  </div>
  <ul class="pbs">{cards}</ul>
</div></section>"""


def sec_products(t, lang, s, alt):
    h = t["home"]
    s_by = by_id(s.get("products"))
    cards = []
    for p in (t.get("products") or []):
        if not isinstance(p, dict) or not p.get("name"):
            continue
        pid = str(p.get("id") or "")
        s_p = s_by.get(pid) or {}
        icon = PRODUCT_ICON.get(pid, PRODUCT_ICON_DEFAULT)
        st = str(p.get("status") or "").strip()
        st_html = (
            f'<span class="badge badge--{orig_status(s, pid)}">{e(st)}</span>' if st else ""
        )
        link = resolve_link(lang, p.get("link") or "contact")
        cards.append(f"""<article class="pcard rv" id="product-{e(pid)}">
      <div class="pcard-head">
        <span class="p-mark">{icon}</span>
        <div>
          <p class="p-cat">{e(p.get('category',''))}</p>
          <h3>{e(p['name'])}</h3>
        </div>
        {st_html}
      </div>
      <p class="p-heading">{e(p.get('heading',''))}</p>
      <p class="p-body">{e(p.get('body',''))}</p>
      <ul class="plist">{product_features(p, s_p)}</ul>
      <a class="btn btn-o" href="{link}">{e(p.get('cta') or p['name'])}{ARROW}</a>
    </article>""")
    if not cards:
        return ""
    return f"""<section class="sec{alt}" id="products"><div class="wrap">
  <div class="sec-head">
    <p class="eyebrow">{e(h.get('products_eyebrow',''))}</p>
    <h2 class="h-sec">{e(h.get('products_title',''))}</h2>
    <p class="lead">{e(h.get('products_lead',''))}</p>
  </div>
  <div class="pcards">{''.join(cards)}</div>
</div></section>"""


def sec_relation(t, lang, s, alt):
    h = t["home"]
    s_steps = (s.get("home") or {}).get("steps") or []
    items = []
    for i, st in enumerate(h.get("steps") or []):
        if not isinstance(st, dict) or not st.get("title"):
            continue
        note = str(st.get("note") or "").strip()
        s_note = ""
        if i < len(s_steps) and isinstance(s_steps[i], dict):
            s_note = str(s_steps[i].get("note") or "").strip()
        note_html = (
            f'<span class="badge badge--{status_class(s_note or note)} badge--sm">{e(note)}</span>'
            if note else ""
        )
        items.append(
            f'<li class="rv"><span class="num">{e(st.get("no",""))}</span>'
            f'<h3>{e(st["title"])}{note_html}</h3><p>{e(st.get("body",""))}</p></li>'
        )
    if not items:
        return ""
    return f"""<section class="sec{alt}" id="relation"><div class="wrap">
  <div class="sec-head">
    <p class="eyebrow">{e(h.get('relation_eyebrow',''))}</p>
    <h2 class="h-sec">{e(h.get('relation_title',''))}</h2>
    <p class="lead">{e(h.get('relation_body',''))}</p>
  </div>
  <ol class="flow">{''.join(items)}</ol>
</div></section>"""


def sec_audience(t, lang, s, alt):
    h = t["home"]
    cards = "".join(
        f'<li class="aud rv"><h3>{e(a.get("t",""))}</h3><p>{e(a.get("d",""))}</p></li>'
        for a in (h.get("audience") or []) if isinstance(a, dict) and a.get("t")
    )
    if not cards:
        return ""
    return f"""<section class="sec{alt}" id="audience"><div class="wrap">
  <div class="sec-head">
    <p class="eyebrow">{e(h.get('audience_eyebrow',''))}</p>
    <h2 class="h-sec">{e(h.get('audience_title',''))}</h2>
  </div>
  <ul class="auds">{cards}</ul>
</div></section>"""


def sec_itsupport(t, lang, s, alt):
    h = t["home"]
    items = "".join(
        f'<li>{e(i.get("title",""))}</li>'
        for i in (h.get("it_items") or []) if isinstance(i, dict) and i.get("title")
    )
    return f"""<section class="sec{alt}" id="itsupport"><div class="wrap">
  <div class="it-in">
    <div>
      <p class="eyebrow">{e(h.get('it_eyebrow',''))}</p>
      <h2 class="h-sec">{e(h.get('it_title',''))}</h2>
      <p class="lead">{e(h.get('it_body',''))}</p>
      <a class="txt-link" href="{url(lang, 'services/it-support')}">{e(h.get('it_cta',''))}{ARROW}</a>
    </div>
    <ul class="itlist">{items}</ul>
  </div>
</div></section>"""


def sec_why(t, lang, s, alt):
    h = t["home"]
    why = "".join(
        f'<li class="rv"><span class="num">{e(w.get("no",""))}</span>'
        f'<div><h3>{e(w.get("title",""))}</h3><p>{e(w.get("body",""))}</p></div></li>'
        for w in (h.get("why") or []) if isinstance(w, dict) and w.get("title")
    )
    if not why:
        return ""
    return f"""<section class="sec{alt}" id="why"><div class="wrap">
  <div class="sec-head">
    <p class="eyebrow">{e(h.get('why_eyebrow',''))}</p>
    <h2 class="h-sec">{e(h.get('why_title',''))}</h2>
  </div>
  <ul class="why">{why}</ul>
</div></section>"""


def sec_flow(t, lang, s, alt):
    h = t["home"]
    flow = "".join(
        f'<li class="rv"><span class="num">{e(f_.get("no",""))}</span>'
        f'<h3>{e(f_.get("title",""))}</h3><p>{e(f_.get("body",""))}</p></li>'
        for f_ in (h.get("flow") or []) if isinstance(f_, dict) and f_.get("title")
    )
    if not flow:
        return ""
    return f"""<section class="sec{alt}" id="flow"><div class="wrap">
  <div class="sec-head">
    <p class="eyebrow">{e(h.get('flow_eyebrow',''))}</p>
    <h2 class="h-sec">{e(h.get('flow_title',''))}</h2>
    <p class="lead">{e(h.get('flow_lead',''))}</p>
  </div>
  <ol class="flow">{flow}</ol>
</div></section>"""


def sec_news(t, lang, s, alt):
    h = t["home"]
    latest = (t.get("posts") or [])[:3]
    if not latest:
        return ""
    rows = "".join(
        f"""<li class="rv"><a href="{url(lang, 'news')}#post-{i + 1}">
        <span class="post-meta"><time datetime="{e(p_.get('date',''))}">{e(p_.get('date',''))}</time>"""
        + (f'<span class="post-cat">{e(p_["category"])}</span>' if p_.get("category") else "")
        + f"""</span>
        <h3>{e(p_.get('title',''))}</h3></a></li>"""
        for i, p_ in enumerate(latest))
    return f"""<section class="sec{alt}" id="news"><div class="wrap">
  <div class="sec-head sec-head-row">
    <div>
      <p class="eyebrow">{e(h.get('news_eyebrow',''))}</p>
      <h2 class="h-sec" style="margin:0">{e(h.get('news_title',''))}</h2>
    </div>
    <a class="txt-link" href="{url(lang, 'news')}">{e(h.get('news_more',''))}{ARROW}</a>
  </div>
  <ul class="news-list">{rows}</ul>
</div></section>"""


def sec_faq(t, lang, s, alt):
    h = t["home"]
    faq = "".join(
        f'<details><summary>{e(q.get("q",""))}</summary><div class="a"><p>{e(q.get("a",""))}</p></div></details>'
        for q in (h.get("faq") or []) if isinstance(q, dict) and q.get("q")
    )
    if not faq:
        return ""
    return f"""<section class="sec{alt}" id="faq"><div class="wrap">
  <div class="sec-head">
    <p class="eyebrow">{e(h.get('faq_eyebrow',''))}</p>
    <h2 class="h-sec">{e(h.get('faq_title',''))}</h2>
  </div>
  <div class="faq">{faq}</div>
</div></section>"""


def sec_cta(t, lang, s, alt):
    return cta_band(t, lang)


SECTIONS = {
    "hero": sec_hero,
    "problem": sec_problem,
    "products": sec_products,
    "relation": sec_relation,
    "audience": sec_audience,
    "itsupport": sec_itsupport,
    "why": sec_why,
    "flow": sec_flow,
    "news": sec_news,
    "faq": sec_faq,
    "cta": sec_cta,
}

SECTION_ORDER_DEFAULT = ["hero", "problem", "products", "relation", "audience",
                         "itsupport", "why", "flow", "news", "faq", "cta"]


def page_index(t, lang, s):
    """sections[] の並び順どおりに段を積む。表示・非表示も同じ表で決まる。"""
    rows = [x for x in (s.get("sections") or []) if isinstance(x, dict) and x.get("id")]
    order = [(str(x["id"]).strip(), str(x.get("show") or "表示").strip()) for x in rows]
    if not order:
        order = [(sid, "表示") for sid in SECTION_ORDER_DEFAULT]

    out, alt = [], 0
    for sid, show in order:
        if show in HIDE_WORDS:
            continue
        fn = SECTIONS.get(sid)
        if fn is None:
            print(f"  ! 知らないセクション名なので飛ばしました: {sid}")
            continue
        if sid in ("hero", "cta"):
            html_ = fn(t, lang, s, "")
        else:
            html_ = fn(t, lang, s, " sec-alt" if alt % 2 == 0 else "")
        if html_:
            out.append(html_)
            if sid not in ("hero", "cta"):
                alt += 1
    return '<main id="main">\n' + "\n".join(out) + "\n</main>"


def page_services(t, lang, s):
    p = t["services_page"]
    blocks = []
    for sv in t["services"]:
        items = "".join(f"<li><h3>{e(i['title'])}</h3><p>{e(i['body'])}</p></li>" for i in sv["items"])
        blocks.append(f"""<section class="svc" id="{sv['id']}"><div class="wrap">
  <div class="svc-top">
    <div>
      <span class="svc-mark">{svc_icon(sv["id"])}<span class="num">{e(sv['no'])}</span></span>
      <h2>{e(sv['name'])}</h2>
      <p class="sub">{e(sv['lead'])}</p>
      <p class="lead">{e(sv['body'])}</p>
    </div>
    {img_tag(sv.get('img'))}
  </div>
  <p class="items-label">{e(p['items_label'])}</p>
  <ul class="svc-items">{items}</ul>
</div></section>""")
    return f"""<main id="main">
<section class="page-hero"><div class="wrap">
  <p class="eyebrow">{e(p['hero_eyebrow'])}</p>
  <h1>{nl2br(p['hero_title'])}</h1>
  <p class="lead">{e(p['hero_lead'])}</p>
</div></section>
{''.join(blocks)}
<section class="cta"><div class="wrap cta-in">
  <div><h2>{e(p['cta_title'])}</h2><p>{e(p['cta_lead'])}</p></div>
  <a class="btn btn-l btn-lg" href="{url(lang, 'contact')}">{e(t['home']['cta_button'])}{ARROW}</a>
</div></section>
</main>"""


def page_about(t, lang, s):
    a = t["about"]
    rows = "".join(f"<div><dt>{e(r['k'])}</dt><dd>{nl2br(r['v'])}</dd></div>" for r in a["profile"])
    vals = "".join(
        f'<li><span class="n">{e(v["no"])}</span>'
        f'<h3>{e(v["t"])}</h3><p>{e(v["d"])}</p></li>'
        for v in a["values"])
    cases = "".join(
        f'<li><h3>{e(c["t"])}</h3><p>{e(c["d"])}</p></li>' for c in a["cases"])

    # 事業領域。トップページで主役から外した既存事業を、会社情報に残す。
    biz_html = ""
    if a.get("business_title"):
        biz_cards = "".join(f"""<a class="scard" href="{url(lang, 'services')}#{sv['id']}">
      <span class="svc-mark">{svc_icon(sv["id"])}<span class="num">{e(sv['no'])}</span></span>
      <h3>{e(sv['name'])}</h3>
      <p>{e(sv['lead'])}</p></a>""" for sv in t["services"])
        more = ""
        if a.get("business_more"):
            more = (f'<a class="txt-link" style="margin-top:2rem" href="{url(lang, "services")}">'
                    f'{e(a["business_more"])}{ARROW}</a>')
        biz_html = f"""<section class="sec" id="business"><div class="wrap">
  <div class="sec-head">
    <h2 class="h-sec" style="margin:0">{e(a['business_title'])}</h2>
    <p class="lead">{e(a.get('business_lead',''))}</p>
  </div>
  <div class="grid-4">{biz_cards}</div>
  {more}
</div></section>"""
    return f"""<main id="main">
<section class="page-hero"><div class="wrap">
  <p class="eyebrow">{e(a['hero_eyebrow'])}</p>
  <h1>{nl2br(a['hero_title'])}</h1>
  <p class="lead">{e(a['hero_lead'])}</p>
</div></section>

<section class="sec"><div class="wrap msg">
  <div><h2 class="h-sec" style="margin:0">{e(a['message_title'])}</h2></div>
  <div class="body">{para(a['message_body'])}<p class="sign">{e(a['message_name'])}</p></div>
</div></section>

<section class="sec sec-alt"><div class="wrap">
  <div class="sec-head"><h2 class="h-sec" style="margin:0">{e(a['profile_title'])}</h2></div>
  <dl class="table">{rows}</dl>
</div></section>

{biz_html}

<section class="sec sec-alt"><div class="wrap">
  <div class="sec-head">
    <h2 class="h-sec" style="margin:0">{e(a['values_title'])}</h2>
    <p class="lead">{e(a['values_lead'])}</p>
  </div>
  <ul class="values">{vals}</ul>
</div></section>

<section class="sec"><div class="wrap">
  <div class="sec-head">
    <h2 class="h-sec" style="margin:0">{e(a['cases_title'])}</h2>
    <p class="lead">{e(a['cases_lead'])}</p>
  </div>
  <ul class="cases">{cases}</ul>
</div></section>
{cta_band(t, lang)}
</main>"""


def page_contact(t, lang, s):
    c = t["contact"]
    kinds = "".join(f'<option value="{e(k)}">{e(k)}</option>' for k in c["kinds"])
    radios = "".join(
        f'<label><input type="radio" name="reply" value="{e(r)}"{" checked" if i == 0 else ""}> {e(r)}</label>'
        for i, r in enumerate(c["reply_options"])
    )
    req = f'<span class="tag tag-req">{e(c["required"])}</span>'
    opt = f'<span class="tag tag-opt">{e(c["optional"])}</span>'
    return f"""<main id="main">
<section class="page-hero"><div class="wrap">
  <p class="eyebrow">{e(c['hero_eyebrow'])}</p>
  <h1>{e(c['hero_title'])}</h1>
  <p class="lead">{e(c['hero_lead'])}</p>
</div></section>

<section class="sec"><div class="wrap cform-grid">
  <div>
    <div class="msg-box msg-ng" id="err" role="alert"></div>
    <form id="cform" novalidate
      data-err-required="{e(c['error_required'])}"
      data-err-email="{e(c['error_email'])}"
      data-err-send="{e(c['error_send'])}"
      data-sending="{e(c['sending'])}"
      data-submit="{e(c['submit'])}">
      <input type="text" name="_gotcha" class="hp" tabindex="-1" autocomplete="off" aria-hidden="true">
      <input type="hidden" name="lang" value="{e(lang)}">
      <div class="field">
        <label for="kind">{e(c['kind_label'])}{req}</label>
        <select id="kind" name="kind" required>{kinds}</select>
      </div>
      <div class="field">
        <label for="name">{e(c['name_label'])}{req}</label>
        <input id="name" name="name" required maxlength="80" autocomplete="name">
      </div>
      <div class="field">
        <label for="company">{e(c['company_label'])}{opt}</label>
        <input id="company" name="company" maxlength="120" autocomplete="organization">
      </div>
      <div class="field">
        <label for="email">{e(c['email_label'])}{req}</label>
        <input id="email" name="email" type="email" required maxlength="120" autocomplete="email" inputmode="email">
      </div>
      <div class="field">
        <label for="tel">{e(c['tel_label'])}{opt}</label>
        <input id="tel" name="tel" type="tel" maxlength="40" autocomplete="tel" inputmode="tel">
      </div>
      <div class="field">
        <label>{e(c['reply_label'])}{opt}</label>
        <div class="radios">{radios}</div>
      </div>
      <div class="field">
        <label for="message">{e(c['message_label'])}{req}</label>
        <textarea id="message" name="message" required maxlength="4000" placeholder="{e(c['message_placeholder'])}"></textarea>
      </div>
      <p class="form-note">{e(c['privacy_note'])} <a href="{url(lang, 'privacy')}">{e(c['privacy_link'])}</a></p>
      <button class="btn btn-p btn-lg" type="submit" id="submit">{e(c['submit'])}</button>
    </form>
    <div class="done" id="done" role="status">
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.5"/><path d="m7.6 12.3 3 3 5.8-6.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <h2>{e(c['success_title'])}</h2><p>{e(c['success_body'])}</p>
    </div>
  </div>
  <aside class="aside">
    <h2>{e(c['info_title'])}</h2>
    <dl>
      <div><dt>{e(c['info_tel_label'])}</dt><dd class="tel">{e(t['brand']['tel'])}</dd></div>
      <div><dt>{e(c['info_hours_label'])}</dt><dd>{e(t['brand']['hours'])}</dd></div>
    </dl>
    <p class="small" style="margin-top:1.1rem">{e(c['info_tel_note'])}</p>
    <p class="small" style="margin-top:.8rem">{e(c['info_note'])}</p>
  </aside>
</div></section>
</main>"""


def page_news(t, lang, s):
    n = t["news"]
    posts = t.get("posts") or []
    if posts:
        rows = "".join(f"""<article class="post" id="post-{i}">
    <div class="post-meta"><time datetime="{e(pt.get('date',''))}">{e(pt.get('date',''))}</time>
      {f'<span class="post-cat">{e(pt["category"])}</span>' if pt.get("category") else ""}</div>
    <div class="post-body"><h2>{e(pt.get('title',''))}</h2>{para(pt.get('body',''))}</div>
  </article>""" for i, pt in enumerate(posts, 1))
        body = f'<div class="posts">{rows}</div>'
    else:
        body = f'<p class="empty">{e(n["empty"])}</p>'
    return f"""<main id="main">
<section class="page-hero"><div class="wrap">
  <p class="eyebrow">{e(n['hero_eyebrow'])}</p>
  <h1>{nl2br(n['hero_title'])}</h1>
  <p class="lead">{e(n['hero_lead'])}</p>
</div></section>
<section class="sec"><div class="wrap wrap-n">{body}</div></section>
{cta_band(t, lang)}
</main>"""


def page_privacy(t, lang, s):
    p = t["privacy"]
    arts = "".join(f"<h2>{e(a['h'])}</h2><p>{nl2br(a['b'])}</p>" for a in p["articles"])
    return f"""<main id="main">
<section class="page-hero"><div class="wrap">
  <p class="eyebrow">Privacy</p>
  <h1>{e(p['title'])}</h1>
  <p class="lead">{e(p['lead'])}</p>
</div></section>
<section class="sec"><div class="wrap prose">{arts}
  <p style="margin-top:3rem" class="small">{e(p['signature'])}</p>
</div></section>
</main>"""


def page_custom(t, lang, s, pg):
    """管理画面から追加された自由ページ。見出し＋本文＋写真のブロックを積む。"""
    secs = []
    for i, b in enumerate(pg.get("blocks") or []):
        heading = str(b.get("heading") or "").strip()
        body = str(b.get("body") or "").strip()
        img = str(b.get("img") or "").strip()
        if not (heading or body or img):
            continue
        alt = " sec-alt" if i % 2 else ""
        if img:
            inner = f'''<div class="cpage-row{" rev" if i % 2 else ""}">
    <div>
      {f"<h2>{e(heading)}</h2>" if heading else ""}
      {para(body) if body else ""}
    </div>
    {img_tag(img)}
  </div>'''
        else:
            inner = f'''<div class="prose">
    {f"<h2>{e(heading)}</h2>" if heading else ""}
    {para(body) if body else ""}
  </div>'''
        secs.append(f'''<section class="sec{alt}"><div class="wrap">
  {inner}
</div></section>''')
    hero_lead = str(pg.get("lead") or "").strip()
    eyebrow = str(pg.get("eyebrow") or "").strip()
    eyebrow_html = f'<p class="eyebrow">{e(eyebrow)}</p>' if eyebrow else ""
    lead_html = f'<p class="lead">{e(hero_lead)}</p>' if hero_lead else ""
    return f'''<main id="main">
<section class="page-hero"><div class="wrap">
  {eyebrow_html}
  <h1>{e(pg.get("title") or "")}</h1>
  {lead_html}
</div></section>
{"".join(secs)}
</main>'''


# --------------------------------------------------------- 製品・サービス頁
def prod_hero(t, lang, s, pid, page, *, status_text=None, status_cls=None):
    """製品ページの冒頭。カテゴリーと提供状況は products[] を正とする。"""
    p = by_id(t.get("products")).get(pid) or {}
    cat = str(p.get("category") or "").strip()
    st = status_text if status_text is not None else str(p.get("status") or "").strip()
    cls = status_cls if status_cls is not None else orig_status(s, pid)
    tags = []
    if cat:
        tags.append(f'<span class="p-cat">{e(cat)}</span>')
    if st:
        tags.append(f'<span class="badge badge--{cls}">{e(st)}</span>')
    tag_html = f'<div class="ph-tags">{"".join(tags)}</div>' if tags else ""
    return f"""<section class="page-hero"><div class="wrap">
  <p class="eyebrow">{e(page.get('hero_eyebrow',''))}</p>
  <h1>{nl2br(page.get('hero_title',''))}</h1>
  {tag_html}
  <p class="lead">{e(page.get('hero_lead',''))}</p>
</div></section>"""


def cta_section(t, lang, page):
    btn = str(page.get("cta_button") or "").strip()
    if not (page.get("cta_title") or btn):
        return ""
    btn_html = (
        f'<a class="btn btn-l btn-lg" href="{url(lang, "contact")}">{e(btn)}{ARROW}</a>'
        if btn else ""
    )
    return f"""<section class="cta"><div class="wrap cta-in">
  <div><h2>{nl2br(page.get('cta_title',''))}</h2><p>{e(page.get('cta_lead',''))}</p></div>
  {btn_html}
</div></section>"""


def status_table(page, s_page):
    """提供状況の表。ここがサイト内で唯一の状況の出どころ。"""
    rows = page.get("status_rows") or []
    s_rows = (s_page or {}).get("status_rows") or []
    if not rows:
        return ""
    body = ""
    for i, r in enumerate(rows):
        if not isinstance(r, dict) or not r.get("k"):
            continue
        state = str(r.get("v") or "").strip()
        s_state = ""
        if i < len(s_rows) and isinstance(s_rows[i], dict):
            s_state = str(s_rows[i].get("v") or "").strip()
        note = str(r.get("note") or "").strip()
        badge_html = (
            f'<span class="badge badge--{status_class(s_state or state)} badge--sm">{e(state)}</span>'
            if state else ""
        )
        note_html = f'<span class="st-note">{e(note)}</span>' if note else ""
        body += (f'<div class="st-row"><div class="st-k">{e(r["k"])}</div>'
                 f'<div class="st-v">{badge_html}{note_html}</div></div>')
    return f'<div class="sttable">{body}</div>' if body else ""


def page_proofkeeping(t, lang, s):
    p = t.get("pk_page") or {}
    sp = s.get("pk_page") or {}
    prod = by_id(t.get("products")).get("proofkeeping") or {}
    s_prod = by_id(s.get("products")).get("proofkeeping") or {}

    probs = "".join(
        f'<li class="pb"><h3>{e(x.get("title",""))}</h3><p>{e(x.get("body",""))}</p></li>'
        for x in (p.get("problems") or []) if isinstance(x, dict) and x.get("title"))
    bens = "".join(
        f'<li class="aud"><h3>{e(x.get("t",""))}</h3><p>{e(x.get("d",""))}</p></li>'
        for x in (p.get("benefits") or []) if isinstance(x, dict) and x.get("t"))
    flow = "".join(
        f'<li><span class="num">{e(x.get("no",""))}</span><h3>{e(x.get("title",""))}</h3>'
        f'<p>{e(x.get("body",""))}</p></li>'
        for x in (p.get("flow") or []) if isinstance(x, dict) and x.get("title"))
    faq = "".join(
        f'<details><summary>{e(x.get("q",""))}</summary><div class="a"><p>{e(x.get("a",""))}</p></div></details>'
        for x in (p.get("faq") or []) if isinstance(x, dict) and x.get("q"))

    screen_media = img_tag(p.get("screen_img")) or (
        f'<p class="small screen-note">{e(p.get("screen_note",""))}</p>'
        if p.get("screen_note") else "")

    return f"""<main id="main">
{prod_hero(t, lang, s, 'proofkeeping', p)}

<section class="sec"><div class="wrap">
  <div class="sec-head"><h2 class="h-sec" style="margin:0">{e(p.get('problem_title',''))}</h2></div>
  <ul class="pbs">{probs}</ul>
</div></section>

<section class="sec sec-alt"><div class="wrap">
  <div class="sec-head">
    <h2 class="h-sec" style="margin:0">{e(p.get('feature_title',''))}</h2>
    <p class="lead">{e(p.get('feature_lead',''))}</p>
  </div>
  <ul class="plist plist-wide">{product_features(prod, s_prod)}</ul>
</div></section>

<section class="sec"><div class="wrap">
  <div class="sec-head"><h2 class="h-sec" style="margin:0">{e(p.get('benefit_title',''))}</h2></div>
  <ul class="auds">{bens}</ul>
</div></section>

<section class="sec sec-alt"><div class="wrap">
  <div class="sec-head"><h2 class="h-sec" style="margin:0">{e(p.get('screen_title',''))}</h2></div>
  <div class="prose"><p>{e(p.get('screen_body',''))}</p></div>
  {screen_media}
</div></section>

<section class="sec"><div class="wrap">
  <div class="sec-head"><h2 class="h-sec" style="margin:0">{e(p.get('flow_title',''))}</h2></div>
  <ol class="flow flow-5">{flow}</ol>
</div></section>

<section class="sec sec-alt"><div class="wrap">
  <div class="prose">
    <h2>{e(p.get('match_title',''))}</h2>
    {para(p.get('match_body',''))}
  </div>
</div></section>

<section class="sec" id="status"><div class="wrap">
  <div class="sec-head">
    <h2 class="h-sec" style="margin:0">{e(p.get('status_title',''))}</h2>
    <p class="lead">{e(p.get('status_lead',''))}</p>
  </div>
  {status_table(p, sp)}
</div></section>

<section class="sec sec-alt"><div class="wrap">
  <div class="prose">
    <h2>{e(p.get('price_title',''))}</h2>
    {para(p.get('price_body',''))}
  </div>
</div></section>

<section class="sec"><div class="wrap">
  <div class="sec-head"><h2 class="h-sec" style="margin:0">{e(p.get('faq_title',''))}</h2></div>
  <div class="faq">{faq}</div>
</div></section>
{cta_section(t, lang, p)}
</main>"""


def page_stek_ops(t, lang, s):
    p = t.get("ops_page") or {}
    s_mods = (s.get("ops_page") or {}).get("modules") or []

    pts = "".join(
        f'<li class="aud"><h3>{e(x.get("t",""))}</h3><p>{e(x.get("d",""))}</p></li>'
        for x in (p.get("relation_points") or []) if isinstance(x, dict) and x.get("t"))

    mods = ""
    for i, m in enumerate(p.get("modules") or []):
        if not isinstance(m, dict) or not m.get("t"):
            continue
        st = str(m.get("status") or "").strip()
        s_st = ""
        if i < len(s_mods) and isinstance(s_mods[i], dict):
            s_st = str(s_mods[i].get("status") or "").strip()
        badge_html = (
            f'<span class="badge badge--{status_class(s_st or st)} badge--sm">{e(st)}</span>'
            if st else "")
        mods += (f'<li><h3>{e(m["t"])}{badge_html}</h3><p>{e(m.get("d",""))}</p></li>')

    perms = "".join(
        f'<div><dt>{e(r.get("k",""))}</dt><dd>{e(r.get("v",""))}</dd></div>'
        for r in (p.get("perm_rows") or []) if isinstance(r, dict) and r.get("k"))

    return f"""<main id="main">
{prod_hero(t, lang, s, 'stek-ops', p)}

<section class="sec"><div class="wrap">
  <div class="prose">
    <h2>{e(p.get('concept_title',''))}</h2>
    {para(p.get('concept_body',''))}
  </div>
</div></section>

<section class="sec sec-alt"><div class="wrap">
  <div class="sec-head">
    <h2 class="h-sec" style="margin:0">{e(p.get('relation_title',''))}</h2>
    <p class="lead">{e(p.get('relation_body',''))}</p>
  </div>
  <ul class="auds">{pts}</ul>
</div></section>

<section class="sec" id="modules"><div class="wrap">
  <div class="sec-head">
    <h2 class="h-sec" style="margin:0">{e(p.get('module_title',''))}</h2>
    <p class="lead">{e(p.get('module_lead',''))}</p>
  </div>
  <ul class="svc-items">{mods}</ul>
</div></section>

<section class="sec sec-alt"><div class="wrap">
  <div class="sec-head">
    <h2 class="h-sec" style="margin:0">{e(p.get('share_title',''))}</h2>
    <p class="lead">{e(p.get('share_body',''))}</p>
  </div>
  <div class="sec-head" style="margin-bottom:1.4rem"><h3 class="h-sub">{e(p.get('perm_title',''))}</h3></div>
  <dl class="table">{perms}</dl>
</div></section>

<section class="sec" id="status"><div class="wrap">
  <div class="prose">
    <h2>{e(p.get('status_title',''))}</h2>
    {para(p.get('status_lead',''))}
  </div>
</div></section>
{cta_section(t, lang, p)}
</main>"""


def page_itsupport(t, lang, s):
    p = t.get("it_page") or {}
    items = "".join(
        f'<li><h3>{e(x.get("title",""))}</h3><p>{e(x.get("body",""))}</p></li>'
        for x in (p.get("items") or []) if isinstance(x, dict) and x.get("title"))
    flow = "".join(
        f'<li><span class="num">{e(x.get("no",""))}</span><h3>{e(x.get("title",""))}</h3>'
        f'<p>{e(x.get("body",""))}</p></li>'
        for x in (p.get("flow") or []) if isinstance(x, dict) and x.get("title"))
    st = str(p.get("status") or "").strip()
    s_st = str((s.get("it_page") or {}).get("status") or "").strip()
    tag_html = (f'<div class="ph-tags"><span class="badge badge--{status_class(s_st or st)}">{e(st)}</span></div>'
                if st else "")
    return f"""<main id="main">
<section class="page-hero"><div class="wrap">
  <p class="eyebrow">{e(p.get('hero_eyebrow',''))}</p>
  <h1>{nl2br(p.get('hero_title',''))}</h1>
  {tag_html}
  <p class="lead">{e(p.get('hero_lead',''))}</p>
</div></section>

<section class="sec"><div class="wrap">
  <div class="prose">
    <h2>{e(p.get('intro_title',''))}</h2>
    {para(p.get('intro_body',''))}
  </div>
</div></section>

<section class="sec sec-alt"><div class="wrap">
  <p class="items-label">{e(p.get('items_label',''))}</p>
  <ul class="svc-items">{items}</ul>
</div></section>

<section class="sec"><div class="wrap">
  <div class="prose">
    <h2>{e(p.get('case_title',''))}</h2>
    {para(p.get('case_body',''))}
  </div>
</div></section>

<section class="sec sec-alt"><div class="wrap">
  <div class="sec-head"><h2 class="h-sec" style="margin:0">{e(p.get('flow_title',''))}</h2></div>
  <ol class="flow">{flow}</ol>
</div></section>
{cta_section(t, lang, p)}
</main>"""


BUILDERS = {
    "index": page_index,
    "services": page_services,
    "news": page_news,
    "about": page_about,
    "contact": page_contact,
    "privacy": page_privacy,
    "products/proofkeeping": page_proofkeeping,
    "products/stek-ops": page_stek_ops,
    "services/it-support": page_itsupport,
}


# -------------------------------------------------------------------- main
def build(langs=None):
    site = json.load(open(os.path.join(DATA, "site.json"), encoding="utf-8"))
    r = Resolver()
    build_worker()  # src/*.js -> _worker.js
    if os.path.isdir(DIST):
        shutil.rmtree(DIST)
    os.makedirs(DIST, exist_ok=True)

    count = 0
    for code, _hl, _label, _short in LANGS:
        if langs and code not in langs:
            continue
        t = r.tree(site, code)
        outdir = os.path.join(DIST, LANG_DIR[code]) if LANG_DIR[code] else DIST
        os.makedirs(outdir, exist_ok=True)
        for page in PAGES:
            body = BUILDERS[page](t, code, site)
            doc = head(t, page, code, site) + header(t, page, code, site) + body + footer(t, page, code, site)
            dest = out_path(outdir, page)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(dest, "w", encoding="utf-8") as f:
                f.write(doc)
            count += 1
        for pg in (t.get("pages") or []):
            slug = str(pg.get("slug") or "").strip()
            if not slug or slug in PAGES or not RE_SLUG.match(slug):
                if slug:
                    print(f"  ! ページ名が使えません（半角英数字とハイフンのみ）: {slug}")
                continue
            body = page_custom(t, code, site, pg)
            doc = head(t, slug, code, site, custom=pg) + header(t, slug, code, site) + body + footer(t, slug, code, site)
            with open(os.path.join(outdir, f"{slug}.html"), "w", encoding="utf-8") as f:
                f.write(doc)
            count += 1

    # static assets
    for d in ("assets", "admin"):
        src = os.path.join(ROOT, d)
        if os.path.isdir(src):
            shutil.copytree(src, os.path.join(DIST, d), dirs_exist_ok=True)
    for f in ("_headers", "_worker.js", "robots.txt"):
        p = os.path.join(ROOT, f)
        if os.path.exists(p):
            shutil.copy(p, os.path.join(DIST, f))
    sitemap(DIST)

    print(f"built {count} pages -> dist/")

    # 公開文言の禁止語チェック（警告のみ。ビルドは止めない）
    try:
        from tools.check_words import check as check_words
        hits = check_words(site)
        if hits:
            print(f"禁止語チェック: {len(hits)} 件（tools/check_words.py で詳細を確認してください）")
            for path, word, _why, _around in hits[:5]:
                print(f"  [{word}] {path}")
    except Exception as err:  # チェックが壊れてもビルドは通す
        print(f"禁止語チェックを飛ばしました: {err}")

    miss = r.report()
    if miss:
        print("translation gaps:", miss)
        for lg, d in r.missing.items():
            for k, v in list(d.items())[:5]:
                print(f"  [{lg}] {v['ja'][:40]}")
    return count


def sitemap(dist):
    urls = []
    site = json.load(open(os.path.join(DATA, "site.json"), encoding="utf-8"))
    slugs = [str(p.get("slug") or "").strip() for p in (site.get("pages") or [])]
    slugs = [x for x in slugs if x and x not in PAGES and RE_SLUG.match(x)]
    for code, _h, _l, _s in LANGS:
        for page in PAGES + slugs:
            urls.append(f"  <url><loc>{SITE_URL}{url(code, page)}</loc><changefreq>monthly</changefreq></url>")
    xml = ('<?xml version="1.0" encoding="UTF-8"?>\n'
           '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
           + "\n".join(urls) + "\n</urlset>\n")
    open(os.path.join(dist, "sitemap.xml"), "w", encoding="utf-8").write(xml)
    open(os.path.join(dist, "robots.txt"), "w", encoding="utf-8").write(
        f"User-agent: *\nAllow: /\nDisallow: /admin/\nSitemap: {SITE_URL}/sitemap.xml\n")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--lang", action="append")
    a = ap.parse_args()
    build(a.lang)
