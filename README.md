# stek.ai 公式サイト

株式会社ステックのコーポレートサイト。日本語で原稿を書き、英語は
翻訳メモリから自動で組み上げる静的サイトです。Cloudflare Pages（advanced mode）で公開します。

- 公開ページ: 10 ページ × 2 言語 = 20 ページ
- 管理画面: `/admin`（日本語 UI。文章・画像を編集して GitHub にコミット → 自動で再公開）
- お問い合わせフォーム: `/api/contact`（自社 SMTP から送信）

## ページ

| URL | 内容 |
| --- | --- |
| `/` | トップページ。段の並びと表示・非表示は `data/site.json` の `sections[]` が正 |
| `/products/proofkeeping/` | ProofKeeping（客室清掃・点検・証跡管理） |
| `/products/stek-ops/` | STEK OPS（ホテル現場運営プラットフォームの構想） |
| `/services/it-support/` | Web・IT支援 |
| `/pricing.html` | 料金（Base / Pro / Enterprise）。方針は `docs/stek_pricing_plans.md` |
| `/services.html` | 事業内容（4 領域） |
| `/about.html` `/news.html` `/contact.html` `/privacy.html` | 会社情報・お知らせ・お問い合わせ・プライバシー |

`data/site.json` の `pages[]` から増やした自由ページは `/<slug>.html` に出ます。

## 構成

```
data/site.json           すべての原稿（日本語のみ）
data/i18n.json           翻訳メモリ  {"<sha1[:16]>": {"ja","en","zh","zh-Hant","ko","locked"}}
data/admin-schema.json   管理画面の作り方（グループ・日本語ラベル・選択肢・画像スロット）
build.py                 静的サイト生成（dist/ に出力）
tools/i18n.py            翻訳メモリの解決
tools/zh_hant.py         簡体字 → 繁体字（OpenCC s2twp ＋ 用語表）
tools/extract_ja.py      原稿の日本語文字列を洗い出す（翻訳作業用）
tools/check_words.py     公開文言の禁止語チェック（build.py からも呼ばれる）
tools/check_site.py      dist/ の静的チェック（リンク切れ・title・description・sitemap）
tools/build_worker.py    src/*.js を _worker.js に連結
src/worker_main.js       ルーティング
src/worker_contact.js    お問い合わせメール送信（SMTP / Resend / Brevo）
src/admin_api.js         管理画面 API（/api/admin/*）
src/admin_translate.js   保存時の自動翻訳（Cloudflare Workers AI）
admin/                   管理画面（静的ファイル）
assets/                  CSS・JS・画像
_worker.js               自動生成。直接編集しないこと
```

## ローカルで動かす

```bash
python3 build.py                  # dist/ を作り直す
python3 tools/check_site.py       # リンク切れ・title・description・sitemap を確認
cd dist && python3 -m http.server 8099
```

Python は 3.11 以上で動きます（GitHub Actions は 3.13）。

`/api/*` はローカルの簡易サーバーでは動きません（Cloudflare Workers 上でのみ動作）。

## 公開

`main` に push すると GitHub Actions が `build.py` を実行し、`dist/` を Cloudflare Pages
（プロジェクト名 `stek-ai`）へ deploy します。

必要な GitHub Secrets:

| 名前 | 内容 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare の API トークン（Pages 編集権限） |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare のアカウント ID |

## Cloudflare Pages の環境変数

| 変数 | 用途 |
| --- | --- |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | お問い合わせメールの送信元（Lark の場合 `smtp.larksuite.com` / `465`） |
| `CONTACT_TO` | 受信先（既定 `info@stek.ai`） |
| `CONTACT_FROM` | 差出人表記（既定 `株式会社ステック <noreplay@stek.ai>`） |
| `ADMIN_PASSWORD` | 管理画面のパスワード |
| `ADMIN_SECRET` | 管理画面のセッション署名鍵（長いランダム文字列） |
| `ADMIN_EMAILS` | 管理画面に入れるメールアドレス（カンマ区切り） |
| `GH_TOKEN` | このリポジトリに書き込める GitHub トークン |
| `GH_REPO` | `avexe816/stek.ai` |
| `AI`（バインディング） | Workers AI。保存時の自動翻訳に使用 |

## 原稿を直す

1. 管理画面 `/admin` から直す（推奨）。保存すると自動翻訳 → コミット → 公開まで進みます。
2. または `data/site.json` を直接編集して push。新しい日本語には訳が無いので、
   `python3 tools/extract_ja.py` で洗い出して `data/i18n.json` に足してください。
   訳が無い場合は日本語のまま表示され、ビルド時に「translation gaps」として報告されます。
   管理画面の「翻訳の状況」から一括生成することもできます。

## 書いてはいけない言葉

製品 ProofKeeping 側（`avexe816/proofkeeping`）の実装契約は、禁止語の規則を
**顧客向け文書にも当てる**ことを求めています（PK-IMPL-CONTRACT 第5章 / DECISIONS #174）。
否定形（「不正ではありません」）も使いません。抜粋されて回ったときに、
製品が主張していない意味になるためです。

- 使わない語: 不正 / 無断宿泊 / 検知 / 監視 / 不審 / 疑い / 異常 / 報告義務 / 不備あり
- 使わない説明: 「不正を検出します」「生産性を可視化します」「作業時間を短縮します」「差異率を0%にできます」
- 未実装の機能を「提供中」と書かない。提供状況ラベルは
  **提供中 / 開発中 / 準備中 / 構想中** から選ぶ（管理画面では選択式）

`python3 tools/check_words.py` で確認できます。`build.py` からも自動で走ります。
