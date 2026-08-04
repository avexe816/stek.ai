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
    ("zh",       "zh-Hans", "简体中文",   "简"),
    ("zh-Hant",  "zh-Hant", "繁體中文",   "繁"),
    ("ko",       "ko",      "한국어",     "KO"),
]
LANG_DIR = {"ja": "", "en": "en", "zh": "zh", "zh-Hant": "zh-hant", "ko": "ko"}

PAGES = ["index", "services", "about", "contact", "privacy"]
NAV = [("index", "home"), ("services", "services"), ("about", "about"), ("contact", "contact")]

SERVICE_IMG = {"tech": "tech", "operation": "operation", "facility": "facility", "asset": "asset"}


def e(s):
    return html.escape(str(s), quote=True)


def nl2br(s):
    return "<br>".join(e(p) for p in str(s).split("\n"))


def para(s):
    return "".join(f"<p>{nl2br(p)}</p>" for p in str(s).split("\n\n") if p.strip())


def url(lang, page):
    d = LANG_DIR[lang]
    base = f"/{d}/" if d else "/"
    return base if page == "index" else f"{base}{page}.html"


# ------------------------------------------------------------------ chunks
LOGO_SVG = """<svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M16 27.2c-4.9 0-9.4-2.1-9.4-7.2 0-6.1 4.2-11.4 9.4-16 5.2 4.6 9.4 9.9 9.4 16 0 5.1-4.5 7.2-9.4 7.2Z" fill="currentColor" opacity=".16"/><path d="M16 26.4c-4.6 0-8.8-2-8.8-6.7 0-5.8 4-10.9 8.8-15.3 4.8 4.4 8.8 9.5 8.8 15.3 0 4.7-4.2 6.7-8.8 6.7Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M16 26.4V4.4" stroke="currentColor" stroke-width="1.2" opacity=".55"/><path d="M11 24.6c1.4-4.3 2.6-8.4 3.2-12.4M21 24.6c-1.4-4.3-2.6-8.4-3.2-12.4" stroke="currentColor" stroke-width="1.1" opacity=".4" stroke-linecap="round"/></svg>"""

ARROW = """<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.5 8h11m0 0L9 3.5M13.5 8 9 12.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>"""

THEME_SVG = """<svg class="i-moon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg><svg class="i-sun" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="4.2" stroke="currentColor" stroke-width="1.6"/><path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4 17 7M7 17l-1.6 1.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>"""

GLOBE_SVG = """<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" style="width:15px;height:15px"><circle cx="12" cy="12" r="8.6" stroke="currentColor" stroke-width="1.5"/><path d="M3.5 12h17M12 3.4c2.3 2.4 3.4 5.4 3.4 8.6S14.3 18.2 12 20.6c-2.3-2.4-3.4-5.4-3.4-8.6S9.7 5.8 12 3.4Z" stroke="currentColor" stroke-width="1.5"/></svg>"""


def head(t, page, lang, s):
    key = {"index": "home", "services": "services", "about": "about",
           "contact": "contact", "privacy": "privacy"}[page]
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
  <meta property="og:image" content="{SITE_URL}/assets/img/hero.webp">
  <meta name="theme-color" content="#0F3A2C">
  <link rel="canonical" href="{SITE_URL}{url(lang, page)}">
  {alts}
  <link rel="alternate" hreflang="x-default" href="{SITE_URL}{url('ja', page)}">
  <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700&family=Shippori+Mincho:wght@500;600;700&family=Outfit:wght@400;500;600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/assets/style.css">
  <script>(function(){{try{{var t=localStorage.getItem('stek-theme');if(!t)t=matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light';document.documentElement.dataset.theme=t;}}catch(e){{}}}})();</script>
</head>
<body>
<a class="skip" href="#main">{e(t['common']['skip'])}</a>
"""


def header(t, page, lang, s):
    nav = "".join(
        f'<a href="{url(lang, p)}"{" aria-current=\"page\"" if p == page else ""}>{e(t["nav"][k])}</a>'
        for p, k in NAV
    )
    langs = "".join(
        f'<a href="{url(c, page)}" hreflang="{h}"{" aria-current=\"true\"" if c == lang else ""}>{e(l)}<i>{e(sh)}</i></a>'
        for c, h, l, sh in LANGS
    )
    cur = next(sh for c, _h, _l, sh in LANGS if c == lang)
    mob = "".join(f'<a href="{url(lang, p)}">{e(t["nav"][k])}</a>' for p, k in NAV)
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


def footer(t, page, lang, s):
    nav = "".join(f'<li><a href="{url(lang, p)}">{e(t["nav"][k])}</a></li>' for p, k in NAV)
    langs = "".join(f'<li><a href="{url(c, page)}" hreflang="{h}">{e(l)}</a></li>' for c, h, l, _s in LANGS)
    return f"""<footer class="ft">
  <div class="wrap">
    <div class="ft-in">
      <div>
        <a class="logo" href="{url(lang, 'index')}">{LOGO_SVG}<b>stek</b><span>{e(s['brand']['tagline'])}</span></a>
        <p>{e(t['footer']['tagline'])}</p>
      </div>
      <div><h3>{e(t['footer']['nav_title'])}</h3><ul>{nav}</ul></div>
      <div><h3>{e(t['footer']['contact_title'])}</h3><ul>
        <li><a href="mailto:{e(s['brand']['email'])}">{e(s['brand']['email'])}</a></li>
        <li>{e(t['brand']['hours'])}</li>
        <li>{e(t['brand']['address'])}</li>
      </ul></div>
      <div><h3>{e(t['footer']['lang_title'])}</h3><ul>{langs}</ul></div>
    </div>
    <div class="ft-btm">
      <span>© {e(t['footer']['copyright'])}</span>
      <a href="{url(lang, 'privacy')}">{e(t['footer']['privacy'])}</a>
    </div>
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
def page_index(t, lang, s):
    h = t["home"]
    cards = "".join(f"""<a class="scard rv" href="{url(lang, 'services')}#{sv['id']}">
      <span class="num">{e(sv['no'])}</span>
      <h3>{e(sv['name'])}</h3>
      <p>{e(sv['lead'])}</p>
      <span class="more">{e(h['services_more'])}{ARROW}</span></a>""" for sv in t["services"])
    why = "".join(f"""<li class="rv"><span class="num">{e(w['no'])}</span>
      <div><h3>{e(w['title'])}</h3><p>{e(w['body'])}</p></div></li>""" for w in h["why"])
    flow = "".join(f"""<li class="rv"><span class="num">{e(f['no'])}</span>
      <h3>{e(f['title'])}</h3><p>{e(f['body'])}</p></li>""" for f in h["flow"])
    faq = "".join(f"""<details><summary>{e(q['q'])}</summary><div class="a"><p>{e(q['a'])}</p></div></details>""" for q in h["faq"])
    return f"""<main id="main">
<section class="hero"><div class="wrap hero-in">
  <div>
    <p class="eyebrow">{e(h['hero_eyebrow'])}</p>
    <h1>{nl2br(h['hero_title'])}</h1>
    <p class="lead">{e(h['hero_lead'])}</p>
    <div class="hero-cta">
      <a class="btn btn-p btn-lg" href="{url(lang, 'contact')}">{e(h['hero_cta1'])}{ARROW}</a>
      <a class="btn btn-o btn-lg" href="{url(lang, 'services')}">{e(h['hero_cta2'])}</a>
    </div>
    <p class="small hero-note">{e(h['hero_note'])}</p>
  </div>
  <figure class="hero-fig">
    <img src="/assets/img/hero.webp" alt="" width="1200" height="960" fetchpriority="high">
  </figure>
</div></section>

<section class="sec sec-alt"><div class="wrap">
  <div class="sec-head">
    <p class="eyebrow">{e(h['pillars_eyebrow'])}</p>
    <h2 class="h-sec">{e(h['pillars_title'])}</h2>
    <p class="lead">{e(h['pillars_lead'])}</p>
  </div>
  <div class="grid-4">{cards}</div>
</div></section>

<section class="sec"><div class="wrap">
  <div class="sec-head">
    <p class="eyebrow">{e(h['why_eyebrow'])}</p>
    <h2 class="h-sec">{e(h['why_title'])}</h2>
  </div>
  <ul class="why">{why}</ul>
</div></section>

<section class="sec sec-alt"><div class="wrap">
  <div class="sec-head">
    <p class="eyebrow">{e(h['flow_eyebrow'])}</p>
    <h2 class="h-sec">{e(h['flow_title'])}</h2>
    <p class="lead">{e(h['flow_lead'])}</p>
  </div>
  <ol class="flow">{flow}</ol>
</div></section>

<section class="sec"><div class="wrap">
  <div class="sec-head">
    <p class="eyebrow">{e(h['faq_eyebrow'])}</p>
    <h2 class="h-sec">{e(h['faq_title'])}</h2>
  </div>
  <div class="faq">{faq}</div>
</div></section>
{cta_band(t, lang)}
</main>"""


def page_services(t, lang, s):
    p = t["services_page"]
    blocks = []
    for sv in t["services"]:
        items = "".join(f"<li><h3>{e(i['title'])}</h3><p>{e(i['body'])}</p></li>" for i in sv["items"])
        blocks.append(f"""<section class="svc" id="{sv['id']}"><div class="wrap">
  <div class="svc-top">
    <div>
      <span class="num">{e(sv['no'])}</span>
      <h2>{e(sv['name'])}</h2>
      <p class="sub">{e(sv['lead'])}</p>
      <p class="lead">{e(sv['body'])}</p>
    </div>
    <img src="/assets/img/{SERVICE_IMG[sv['id']]}.webp" alt="" width="1200" height="750" loading="lazy">
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
    lic = "".join(f"<div><dt>{e(r['k'])}</dt><dd>{nl2br(r['v'])}</dd></div>" for r in a["license"])
    purpose = "".join(f"<li>{e(x)}</li>" for x in a["purpose"])
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

<section class="sec"><div class="wrap">
  <div class="sec-head">
    <h2 class="h-sec" style="margin:0">{e(a['purpose_title'])}</h2>
    <p class="lead">{e(a['purpose_lead'])}</p>
  </div>
  <ol class="purpose">{purpose}</ol>
</div></section>

<section class="sec sec-alt"><div class="wrap">
  <div class="sec-head">
    <h2 class="h-sec" style="margin:0">{e(a['license_title'])}</h2>
    <p class="lead">{e(a['license_lead'])}</p>
  </div>
  <dl class="table">{lic}</dl>
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
      <div><dt>{e(c['info_mail_label'])}</dt><dd><a href="mailto:{e(s['brand']['email'])}">{e(s['brand']['email'])}</a></dd></div>
      <div><dt>{e(c['info_hours_label'])}</dt><dd>{e(t['brand']['hours'])}</dd></div>
    </dl>
    <p class="small" style="margin-top:1.2rem">{e(c['info_note'])}</p>
  </aside>
</div></section>
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


BUILDERS = {"index": page_index, "services": page_services, "about": page_about,
            "contact": page_contact, "privacy": page_privacy}


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
            name = "index.html" if page == "index" else f"{page}.html"
            with open(os.path.join(outdir, name), "w", encoding="utf-8") as f:
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
    miss = r.report()
    if miss:
        print("translation gaps:", miss)
        for lg, d in r.missing.items():
            for k, v in list(d.items())[:5]:
                print(f"  [{lg}] {v['ja'][:40]}")
    return count


def sitemap(dist):
    urls = []
    for code, _h, _l, _s in LANGS:
        for page in PAGES:
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
