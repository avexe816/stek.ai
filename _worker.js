/* ============================================================================
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

// ==== src/admin_translate.js ==========================================
// ============================================================================
// 自動翻訳（Cloudflare Workers AI）
//
//   日本語だけを人が書き、ほかの 4 言語は保存時に自動生成する。
//   ・zh / en / ko … Workers AI の指示モデルで翻訳する
//   ・zh-Hant     … 空のまま保存し、GitHub Actions 側で tools/zh_hant.py が
//                   簡体字から変換して埋める（OpenCC + 用語表のほうが精度が高い）
//
//   env.AI（Workers AI バインディング）が必要。名前は必ず AI にする。
//   任意: env.AI_MODEL でモデルを差し替えられる。
// ============================================================================

const AI_MODEL_DEFAULT = "@cf/qwen/qwen3-30b-a3b-fp8";
const AI_MODEL_FALLBACK = "@cf/meta/m2m100-1.2b";

// 自動翻訳する言語。zh-Hant はビルド時に簡体字から変換するのでここには入れない。
const AUTO_LANGS = ["zh", "en", "ko"];

// 固有名詞の対訳表。地名・駅名はモデルが誤読しやすいので必ず渡す。
// 「日本語 | 簡体字 | English | 한국어」の順。
const GLOSSARY = [
  // 会社名・ブランド（人が確認済みの表記。ここは絶対に変えない）
  ["株式会社ステック", "株式会社STEK", "stek Inc.", "주식회사 스텍"],
  ["ステック", "STEK", "stek", "스텍"],
  // 業界用語
  ["宿泊施設", "住宿设施", "lodging facility", "숙박시설"],
  ["客室清掃", "客房清洁", "guest room cleaning", "객실 청소"],
  ["ベッドメイキング", "铺床服务", "bed making", "베드 메이킹"],
  ["リネン", "布草", "linen", "리넨"],
  ["運営受託", "运营受托", "operation contracting", "운영 수탁"],
  ["管理受託", "管理受托", "management contracting", "관리 수탁"],
  ["開業支援", "开业支持", "pre-opening support", "개업 지원"],
  ["稼働率", "入住率", "occupancy rate", "가동률"],
  ["平均単価", "平均房价", "average daily rate", "평균 객단가"],
  ["レベニューマネジメント", "收益管理", "revenue management", "레비뉴 매니지먼트"],
  ["サイトコントローラー", "渠道管理系统", "channel manager", "채널 매니저"],
  ["宿泊施設管理システム", "住宿设施管理系统", "property management system", "숙박시설 관리 시스템"],
  ["自動調価", "自动调价", "automated pricing", "자동 요금 조정"],
  ["旅館業法", "旅馆业法", "Hotel Business Act", "여관업법"],
  ["宅地建物取引業法", "宅地建物交易业法", "Real Estate Brokerage Act", "택지건물거래업법"],
  ["旅行業法", "旅行业法", "Travel Agency Act", "여행업법"],
  ["古物営業法", "古物营业法", "Secondhand Goods Business Act", "고물영업법"],
  ["定款", "公司章程", "articles of incorporation", "정관"],
  ["フランチャイズ", "特许加盟", "franchise", "프랜차이즈"],
  ["加盟店", "加盟店", "franchisee", "가맹점"],
  ["カーリース", "汽车租赁", "car leasing", "카 리스"],
  ["東京都", "东京都", "Tokyo", "도쿄도"],
  ["首都圏", "首都圈", "Greater Tokyo Area", "수도권"],
];

const GLOSSARY_COL = { zh: 1, en: 2, ko: 3 };

/** 原文に出てくる固有名詞だけを対訳表として抜き出す（プロンプトを短く保つため） */
function glossaryFor(lang, texts) {
  const joined = texts.join("\n");
  const col = GLOSSARY_COL[lang];
  const used = [];
  for (const row of [...GLOSSARY].sort((a, b) => b[0].length - a[0].length)) {
    if (!joined.includes(row[0])) continue;
    // すでに採用した長い語に含まれている短い語は出さない（銀座イースト があれば 銀座 は不要）
    if (used.some((u) => u[0].includes(row[0]))) continue;
    used.push(row);
  }
  if (!used.length) return [];
  return [
    "MANDATORY GLOSSARY — these proper nouns must appear exactly as given, no other spelling is acceptable:",
    ...used.map((row) => `- 「${row[0]}」 -> ${row[col]}`),
    "",
  ];
}

const LANG_INFO = {
  zh: { label: "Simplified Chinese (as used in mainland China)", m2m: "chinese" },
  en: { label: "English", m2m: "english" },
  ko: { label: "Korean", m2m: "korean" },
};

// build.py / tools/i18n.py の JP_RE と同じ範囲
const JP_RE = /[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff\u3000-\u303f\uff01-\uff60\u3005\u30fc]/;

const ALL_LANGS = ["zh", "zh-Hant", "en", "ko", "th"];

/** 翻訳が必要な文字列か（日本語の文字を含むか）。ブランド名や数字だけの行は対象外。 */
export function needsTranslation(s) {
  return typeof s === "string" && JP_RE.test(s);
}

/** tools/i18n.py の key_of と完全に同じ値を返す（sha1 の先頭 16 桁）。 */
export async function keyOf(text) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

/** データツリーの中の日本語文字列をすべて集める。 */
export function collectStrings(node, out = new Set()) {
  if (typeof node === "string") {
    if (needsTranslation(node)) out.add(node);
  } else if (Array.isArray(node)) {
    for (const v of node) collectStrings(v, out);
  } else if (node && typeof node === "object") {
    for (const v of Object.values(node)) collectStrings(v, out);
  }
  return out;
}

// ------------------------------------------------------------ 訳文の検品
//
//  モデルが日本語をそのまま返してくることがあるため、必ず機械的に検品する。
//  ・かな（ー と ・ は中国語でも使うので除外）が残っていたら中国語として失敗
//  ・ハングルが無ければ韓国語として失敗
//  ・英語に漢字・かな・ハングルが混ざっていたら失敗
//  ・原文と同一なら失敗

const HAS_KANA = /[\u3040-\u309f\u30a1-\u30fa\u30fd\u30fe]/;
const HAS_HANGUL = /[\uac00-\ud7af]/;
const HAS_CJK = /[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/;

function looksValid(lang, src, out) {
  if (!out || !out.trim()) return false;
  if (out.trim() === src.trim()) return false;
  if (lang === "zh") return !HAS_KANA.test(out);
  if (lang === "ko") return HAS_HANGUL.test(out);
  if (lang === "en") return !HAS_CJK.test(out);
  return true;
}

// -------------------------------------------------------------- モデル呼び出し

const stripThink = (s) => String(s).replace(/<think>[\s\S]*?<\/think>/g, "").trim();

// 指示は英語で書く。日本語で書くと、モデルが原文をそのまま返す事故が起きやすい。
const RULES = (label) => [
  `Translate the Japanese lines below into ${label}.`,
  "",
  "Rules:",
  `- The output MUST be written entirely in ${label}. Never copy or leave the Japanese text.`,
  "- These lines are from the corporate website of a Japanese B2B hotel-technology and hotel-operations company. Keep the wording concise, factual and businesslike.",
  "- Do NOT add, remove, guess or invent any information. Translate only what is written.",
  "- Vague quantities stay vague: 「数分」 means \"a few minutes\", not a specific number.",
  "- Keep Latin brand names and terms exactly as written: stek, stek.ai, PMS, OTA, RevPAR, AI, FC.",
  "- Keep all numbers, times, prices and symbols exactly as in the source.",
  "- Keep \\n where it appears, at the same position.",
  "- Output the translation only. No preamble, no notes, no explanation, no romanisation.",
];

function buildPrompt(lang, texts) {
  return [
    ...glossaryFor(lang, texts),
    ...RULES(LANG_INFO[lang].label),
    `- Output exactly ${texts.length} line(s), each formatted as "<number>. <translation>".`,
    "",
    "Japanese:",
    texts.map((t, i) => `${i + 1}. ${t.replace(/\n/g, "\\n")}`).join("\n"),
  ].join("\n");
}

function buildSinglePrompt(lang, text) {
  return [...glossaryFor(lang, [text]), ...RULES(LANG_INFO[lang].label), "", "Japanese:", text.replace(/\n/g, "\\n")].join("\n");
}

function parseNumbered(raw, count) {
  const lines = stripThink(raw).split("\n");
  const out = new Array(count).fill(null);
  for (const line of lines) {
    const m = line.match(/^\s*(\d+)\s*[.．、:：]\s*(.+)$/);
    if (!m) continue;
    const i = parseInt(m[1], 10) - 1;
    if (i >= 0 && i < count && out[i] === null) out[i] = m[2].trim().replace(/\\n/g, "\n");
  }
  return out;
}

async function ask(env, prompt, maxTokens) {
  const res = await env.AI.run(env.AI_MODEL || AI_MODEL_DEFAULT, {
    messages: [
      { role: "system", content: "You are a professional translator for Japanese corporate websites in the hospitality industry. Reply with the translation only. /no_think" },
      { role: "user", content: prompt },
    ],
    max_tokens: maxTokens,
    temperature: 0.2,
  });
  return res.response || (res.result && res.result.response) || "";
}

/** まとめ訳し。検品を通らなかったところは null で返す。 */
async function runBatch(env, lang, texts) {
  try {
    const raw = await ask(env, buildPrompt(lang, texts), Math.min(4000, 300 + texts.join("").length * 3));
    const parsed = parseNumbered(raw, texts.length);
    return parsed.map((v, i) => (looksValid(lang, texts[i], v) ? v : null));
  } catch (err) {
    console.log(`translate ${lang} batch failed:`, String(err).slice(0, 200));
    return texts.map(() => null);
  }
}

/** 1文ずつ訳す。まとめ訳しで失敗したものだけに使う。 */
async function runSingle(env, lang, text) {
  try {
    const raw = stripThink(await ask(env, buildSinglePrompt(lang, text), Math.min(1500, 200 + text.length * 4)));
    // 番号付きで返ってくることもあるので落とす
    const cleaned = raw.replace(/^\s*\d+\s*[.．、:：]\s*/, "").trim().replace(/\\n/g, "\n");
    if (looksValid(lang, text, cleaned)) return cleaned;
  } catch (err) {
    console.log(`translate ${lang} single failed:`, String(err).slice(0, 160));
  }
  return null;
}

/** 旧来の翻訳専用モデル。指示モデルが何度やっても駄目なときの最後の保険。 */
async function runM2M(env, lang, text) {
  try {
    const res = await env.AI.run(AI_MODEL_FALLBACK, {
      text,
      source_lang: "japanese",
      target_lang: LANG_INFO[lang].m2m,
    });
    const out = (res.translated_text || "").trim();
    return looksValid(lang, text, out) ? out : null;
  } catch (_) {
    return null;
  }
}

/**
 * 日本語の配列を 1 言語ぶん訳す。
 * まとめ訳し → 残りを1文ずつ → それでも駄目なら翻訳専用モデル、の3段構え。
 * 最後まで検品を通らなかったものは null のまま返し、書き込まない（誤訳を残さない）。
 */
async function translateInto(env, lang, texts) {
  const out = new Array(texts.length).fill(null);

  for (let i = 0; i < texts.length; i += 12) {
    const idx = [];
    for (let j = i; j < Math.min(i + 12, texts.length); j++) idx.push(j);
    const got = await runBatch(env, lang, idx.map((j) => texts[j]));
    idx.forEach((j, k) => (out[j] = got[k]));
  }

  for (let j = 0; j < texts.length; j++) {
    if (out[j] === null) out[j] = await runSingle(env, lang, texts[j]);
    if (out[j] === null) out[j] = await runM2M(env, lang, texts[j]);
  }

  return out;
}

// ------------------------------------------------------------------- 本体

/**
 * データツリーを見て、翻訳記憶（i18n.json）に足りない訳を自動で埋める。
 *
 * @param env       Worker の環境
 * @param mem       i18n.json の中身（この関数が直接書き換える）
 * @param trees     翻訳対象のデータツリーの配列（site.json / hotels.json / grand.json）
 * @param limit     1回で訳す最大件数
 * @returns {{added:number, langs:object, pending:number, skippedLocked:number}}
 */
export async function fillTranslations(env, mem, trees, limit = 80) {
  if (!env.AI) throw new Error("no_ai_binding");

  // 日本語 → キー の対応表をつくる
  const strings = new Set();
  for (const t of trees) collectStrings(t, strings);

  const jobs = [];       // 訳が足りない項目
  let skippedLocked = 0;

  for (const ja of strings) {
    const key = await keyOf(ja);
    const entry = mem[key];
    if (entry && entry.locked) {
      // 人が確認済みの文言。足りない言語だけは補う。
      const holes = AUTO_LANGS.filter((l) => !entry[l]);
      if (!holes.length) {
        skippedLocked++;
        continue;
      }
      jobs.push({ ja, key, langs: holes });
      continue;
    }
    const holes = AUTO_LANGS.filter((l) => !(entry && entry[l]));
    if (holes.length) jobs.push({ ja, key, langs: holes });
  }

  const pending = Math.max(0, jobs.length - limit);
  const batch = jobs.slice(0, limit);
  if (!batch.length) return { added: 0, langs: {}, pending: 0, skippedLocked };

  // 言語ごとにまとめて投げる
  const perLang = {};
  for (const lang of AUTO_LANGS) {
    const items = batch.filter((j) => j.langs.includes(lang));
    if (items.length) perLang[lang] = { items, results: await translateInto(env, lang, items.map((j) => j.ja)) };
  }

  // 記憶に書き戻す
  const counts = {};
  const failed = {};
  for (const [lang, { items, results }] of Object.entries(perLang)) {
    counts[lang] = 0;
    failed[lang] = 0;
    items.forEach((job, i) => {
      const text = results[i];
      if (!text) {
        failed[lang]++;
        return;
      }
      const entry = (mem[job.key] = mem[job.key] || { ja: job.ja, locked: false });
      entry.ja = job.ja;
      for (const l of ALL_LANGS) if (!(l in entry)) entry[l] = "";
      if (!("locked" in entry)) entry.locked = false;
      entry[lang] = text;
      counts[lang]++;
    });
  }

  const failTotal = Object.values(failed).reduce((a, b) => a + b, 0);
  return { added: batch.length, langs: counts, failed: failTotal, pending, skippedLocked };
}

/** tools/i18n.py の save_memory と同じ並び順（ja の辞書順）で書き出す。 */
export function sortMemory(mem) {
  // Python 側は文字コード順（sorted）なので、JS も同じ比較にする
  const keys = Object.keys(mem).sort((a, b) => {
    const x = String(mem[a].ja), y = String(mem[b].ja);
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const out = {};
  for (const k of keys) out[k] = mem[k];
  return out;
}

// ==== src/admin_api.js ================================================
// ============================================================================
// stek.ai 管理画面 API
//   /api/admin/* を処理する。データの実体は GitHub リポジトリの data/*.json。
//   保存すると GitHub にコミット → GitHub Actions がビルド → Pages へ公開。
//
//   必要な環境変数:
//     GH_REPO             例: avexe816/stek.ai
//     GH_TOKEN            GitHub の細粒度 PAT（Contents: 読み書き / Actions: 読み取り）
//     ADMIN_PASSWORD      パスワード方式のときのログインパスワード
//     ADMIN_SECRET        セッション署名用のランダム文字列
//     AI                  Workers AI バインディング（自動翻訳に使う。名前は必ず AI）
//   任意:
//     ACCESS_TEAM_DOMAIN  例: tej.cloudflareaccess.com（Cloudflare Access 方式）
//     ACCESS_AUD          Access アプリケーションの Audience タグ
//     AI_MODEL            翻訳に使うモデルの差し替え
// ============================================================================

const J = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const COOKIE = "__Host-steksid";
const SESSION_HOURS = 12;
const DATA_FILES = ["data/site.json", "data/i18n.json", "data/admin-schema.json"];
const TRANSLATABLE = ["zh", "zh-Hant", "en", "ko"];

// ---------------------------------------------------------------- utilities

const enc = new TextEncoder();
const dec = new TextDecoder();

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const unb64url = (s) => {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

const b64utf8 = (str) => {
  const bytes = enc.encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

const utf8b64 = (b64) => {
  const bin = atob(b64.replace(/\s/g, ""));
  return dec.decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// -------------------------------------------------------------------- 認証

async function makeSession(env, email) {
  const payload = b64url(enc.encode(JSON.stringify({ email, exp: Date.now() + SESSION_HOURS * 3600e3 })));
  return `${payload}.${await hmac(env.ADMIN_SECRET, payload)}`;
}

async function readSession(env, request) {
  const raw = (request.headers.get("cookie") || "").match(new RegExp(`${COOKIE}=([^;]+)`));
  if (!raw) return null;
  const [payload, sig] = raw[1].split(".");
  if (!payload || !sig) return null;
  if (!timingSafeEqual(sig, await hmac(env.ADMIN_SECRET, payload))) return null;
  try {
    const data = JSON.parse(dec.decode(unb64url(payload)));
    if (!data.exp || data.exp < Date.now()) return null;
    return data.email;
  } catch (_) {
    return null;
  }
}

// Cloudflare Access の JWT を検証してメールアドレスを取り出す
async function verifyAccess(env, request) {
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return null;

  let head, body;
  try {
    head = JSON.parse(dec.decode(unb64url(h)));
    body = JSON.parse(dec.decode(unb64url(p)));
  } catch (_) {
    return null;
  }
  if (body.exp * 1000 < Date.now()) return null;
  const auds = Array.isArray(body.aud) ? body.aud : [body.aud];
  if (!auds.includes(env.ACCESS_AUD)) return null;

  const res = await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`, { cf: { cacheTtl: 3600 } });
  if (!res.ok) return null;
  const { keys } = await res.json();
  const jwk = keys.find((k) => k.kid === head.kid);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, unb64url(s), enc.encode(`${h}.${p}`));
  return ok ? body.email || null : null;
}

// 認証済みのメールアドレスを返す。未認証なら null。
// 許可リストから外れたメールは、有効なクッキーを持っていても通さない
//（担当者が代わったら ADMIN_EMAILS から消すだけで即座に無効になる）。
async function whoami(env, request) {
  const email = (await verifyAccess(env, request)) || (await readSession(env, request));
  if (!email) return null;
  return allowedEmails(env).includes(String(email).toLowerCase()) ? email : null;
}

// ------------------------------------------------------------------ GitHub

function gh(env, path, init = {}) {
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.GH_TOKEN}`,
      accept: "application/vnd.github+json",
      "user-agent": "stek-admin",
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });
}

async function ghJson(env, path, init) {
  const res = await gh(env, path, init);
  if (!res.ok) throw new Error(`GitHub ${res.status} ${path}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

const repo = (env) => env.GH_REPO || "avexe816/stek.ai";

// 画像名は URL とファイル名にそのまま使うので、半角小文字・数字・ハイフンだけに限る
const IMG_NAME_RE = /^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]$/;
const MAX_IMG_BYTES = 4 * 1024 * 1024;

// ログインを許可するメールアドレス。Cloudflare の ADMIN_EMAILS（カンマ区切り）で設定する。
// 未設定のときは締め出されないように最低限の1件だけを既定値にする。
const DEFAULT_ADMIN_EMAILS = ["ukh816@gmail.com"];

function allowedEmails(env) {
  const raw = String(env.ADMIN_EMAILS || "").trim();
  const list = raw ? raw.split(/[,\s;]+/) : DEFAULT_ADMIN_EMAILS;
  return list.map((x) => x.trim().toLowerCase()).filter(Boolean);
}

// 一度に必要なファイルをまとめて読む
async function loadBundle(env) {
  const ref = await ghJson(env, `/repos/${repo(env)}/git/ref/heads/main`);
  const head = ref.object.sha;
  const tree = await ghJson(env, `/repos/${repo(env)}/git/trees/${head}?recursive=1`);
  const byPath = Object.fromEntries(tree.tree.map((t) => [t.path, t]));

  const out = { head, files: {} };
  await Promise.all(
    DATA_FILES.map(async (p) => {
      const node = byPath[p];
      if (!node) return;
      const blob = await ghJson(env, `/repos/${repo(env)}/git/blobs/${node.sha}`);
      out.files[p] = JSON.parse(utf8b64(blob.content));
    })
  );
  // 画像一覧（管理画面の画像選択用）
  out.images = tree.tree
    .filter((t) => t.path.startsWith("assets/img/") && t.path.endsWith(".webp") && !t.path.endsWith("-sm.webp"))
    .map((t) => t.path.replace("assets/img/", "").replace(".webp", ""))
    .sort();
  return out;
}

// 複数ファイルを 1 コミットで保存する（Git Data API）
async function commitFiles(env, { files, message, author, expectHead }) {
  const R = repo(env);
  const ref = await ghJson(env, `/repos/${R}/git/ref/heads/main`);
  const head = ref.object.sha;
  if (expectHead && expectHead !== head) {
    const err = new Error("conflict");
    err.code = "conflict";
    throw err;
  }
  const base = await ghJson(env, `/repos/${R}/git/commits/${head}`);

  // content が {b64: "..."} の形なら画像などのバイナリとして、そのまま送る
  const blobs = await Promise.all(
    Object.entries(files).map(async ([path, content]) => {
      const payload = content && typeof content === "object" && typeof content.b64 === "string" ? content.b64 : b64utf8(String(content));
      const blob = await ghJson(env, `/repos/${R}/git/blobs`, {
        method: "POST",
        body: JSON.stringify({ content: payload, encoding: "base64" }),
      });
      return { path, mode: "100644", type: "blob", sha: blob.sha };
    })
  );

  const tree = await ghJson(env, `/repos/${R}/git/trees`, {
    method: "POST",
    body: JSON.stringify({ base_tree: base.tree.sha, tree: blobs }),
  });

  const commit = await ghJson(env, `/repos/${R}/git/commits`, {
    method: "POST",
    body: JSON.stringify({
      message,
      tree: tree.sha,
      parents: [head],
      author: { name: author.split("@")[0], email: author, date: new Date().toISOString() },
    }),
  });

  await ghJson(env, `/repos/${R}/git/refs/heads/main`, {
    method: "PATCH",
    body: JSON.stringify({ sha: commit.sha }),
  });
  return commit.sha;
}

// 公開状況（GitHub Actions の実行状態）
async function buildStatus(env) {
  const runs = await ghJson(env, `/repos/${repo(env)}/actions/runs?per_page=3`);
  const r = runs.workflow_runs && runs.workflow_runs[0];
  if (!r) return { state: "idle" };
  const state =
    r.status !== "completed" ? "building" : r.conclusion === "success" ? "ok" : "failed";
  return { state, url: r.html_url, at: r.updated_at, message: (r.display_title || "").slice(0, 120) };
}

// -------------------------------------------------------------------- ルート

async function handleAdmin(request, env, url) {
  const path = url.pathname.replace(/^\/api\/admin/, "") || "/";
  const usingAccess = Boolean(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD);

  // --- ログイン（パスワード方式のみ）
  if (path === "/login" && request.method === "POST") {
    if (usingAccess) return J({ ok: false, error: "use_access" }, 400);
    if (!env.ADMIN_PASSWORD || !env.ADMIN_SECRET) return J({ ok: false, error: "not_configured" }, 503);
    let body = {};
    try {
      body = await request.json();
    } catch (_) {}
    const pw = String(body.password || "");
    const email = String(body.email || "").trim().slice(0, 120).toLowerCase();
    const allow = allowedEmails(env);

    // メールとパスワードの両方を確認する。どちらが違うかは返さない（総当たりの手がかりを与えない）。
    const emailOk = allow.includes(email);
    const pwOk = pw.length <= 200 && timingSafeEqual(pw.padEnd(200, "\0"), String(env.ADMIN_PASSWORD).padEnd(200, "\0"));
    if (!emailOk || !pwOk) {
      await new Promise((r) => setTimeout(r, 1200));
      return J({ ok: false, error: "bad_credentials" }, 401);
    }
    const token = await makeSession(env, email);
    return new Response(JSON.stringify({ ok: true, email }), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "set-cookie": `${COOKIE}=${token}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_HOURS * 3600}`,
      },
    });
  }

  if (path === "/logout") {
    return new Response(JSON.stringify({ ok: true }), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "set-cookie": `${COOKIE}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
      },
    });
  }

  const email = await whoami(env, request);

  if (path === "/me") {
    return J({
      ok: true,
      email,
      mode: usingAccess ? "access" : "password",
      configured: Boolean(env.GH_TOKEN),
      translator: Boolean(env.AI),
      hasSecret: Boolean(env.ADMIN_SECRET),
      hasPassword: Boolean(env.ADMIN_PASSWORD),
      emailsConfigured: Boolean(String(env.ADMIN_EMAILS || "").trim()),
      repo: repo(env),
    });
  }

  // 翻訳の動作確認だけは ADMIN_SECRET を知っていればログインなしでも叩ける（設定確認用）
  const probe = url.searchParams.get("secret");
  const isProbe = (path === "/translate-test" || path === "/diag") && probe && env.ADMIN_SECRET && probe === env.ADMIN_SECRET;

  if (!email && !isProbe) return J({ ok: false, error: "unauthorized" }, 401);
  if (!env.GH_TOKEN && !isProbe) return J({ ok: false, error: "no_github_token" }, 503);

  // 読み込みの不具合を切り分けるための診断（ADMIN_SECRET 必須）
  if (path === "/diag") {
    const steps = [];
    // トークン自体の状態（値は出さない。長さと種別だけ）
    const tok = String(env.GH_TOKEN || "");
    steps.push({
      step: "token",
      ok: Boolean(tok),
      length: tok.length,
      kind: tok.startsWith("github_pat_") ? "fine-grained" : tok.startsWith("ghp_") ? "classic" : tok ? "unknown" : "missing",
      trimmedDiffers: tok !== tok.trim(),
    });
    for (const probePath of ["/user", `/repos/${repo(env)}`]) {
      const t = Date.now();
      try {
        const res = await gh(env, probePath);
        const body = await res.text();
        let note = "";
        try {
          const j = JSON.parse(body);
          note = j.login || j.full_name || j.message || "";
        } catch (_) {
          note = body.slice(0, 120);
        }
        steps.push({ step: probePath, ok: res.ok, status: res.status, note: String(note).slice(0, 160), ms: Date.now() - t });
      } catch (e) {
        steps.push({ step: probePath, ok: false, error: String(e).slice(0, 200) });
      }
    }
    try {
      const t0 = Date.now();
      const ref = await ghJson(env, `/repos/${repo(env)}/git/ref/heads/main`);
      steps.push({ step: "ref", ok: true, sha: ref.object.sha.slice(0, 8), ms: Date.now() - t0 });
      const t1 = Date.now();
      const tree = await ghJson(env, `/repos/${repo(env)}/git/trees/${ref.object.sha}?recursive=1`);
      steps.push({ step: "tree", ok: true, count: tree.tree.length, truncated: Boolean(tree.truncated), ms: Date.now() - t1 });
      const byPath = Object.fromEntries(tree.tree.map((t) => [t.path, t]));
      for (const p of DATA_FILES) {
        const node = byPath[p];
        if (!node) {
          steps.push({ step: p, ok: false, error: "not in tree" });
          continue;
        }
        const t2 = Date.now();
        try {
          const blob = await ghJson(env, `/repos/${repo(env)}/git/blobs/${node.sha}`);
          const text = utf8b64(blob.content);
          JSON.parse(text);
          steps.push({ step: p, ok: true, bytes: text.length, ms: Date.now() - t2 });
        } catch (e) {
          steps.push({ step: p, ok: false, error: String(e).slice(0, 300), ms: Date.now() - t2 });
        }
      }
    } catch (e) {
      steps.push({ step: "fatal", ok: false, error: String(e).slice(0, 500) });
    }
    return J({ ok: steps.every((s) => s.ok), dataFiles: DATA_FILES, steps });
  }

  try {
    // --- 全データ読み込み
    if (path === "/bundle") {
      const b = await loadBundle(env);
      return J({ ok: true, head: b.head, files: b.files, images: b.images });
    }

    // --- 画像アップロード（ブラウザ側で webp に変換済みのものを受け取る）
    if (path === "/upload" && request.method === "POST") {
      const body = await request.json();
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length) return J({ ok: false, error: "no_items" }, 400);
      if (items.length > 20) return J({ ok: false, error: "too_many", hint: "一度に20枚までにしてください。" }, 400);

      const files = {};
      const names = [];
      for (const it of items) {
        const name = String(it.name || "").trim();
        if (!IMG_NAME_RE.test(name) || name.endsWith("-sm")) {
          return J({ ok: false, error: "bad_name", name, hint: "半角小文字・数字・ハイフンのみ、2〜60文字。末尾の -sm は使えません。" }, 400);
        }
        for (const [suffix, key] of [["", "full"], ["-sm", "sm"]]) {
          const b64 = String(it[key] || "").replace(/^data:[^,]*,/, "").replace(/\s/g, "");
          if (!b64) return J({ ok: false, error: "missing_data", name, which: key }, 400);
          // base64 の 4 文字 = 3 バイト
          if (b64.length * 0.75 > MAX_IMG_BYTES) {
            return J({ ok: false, error: "too_large", name, which: key, hint: "1枚あたり 4MB までです。" }, 400);
          }
          files[`assets/img/${name}${suffix}.webp`] = { b64 };
        }
        names.push(name);
      }

      const message =
        names.length === 1 ? `画像を追加: ${names[0]}` : `画像を追加: ${names.length}枚（${names.slice(0, 3).join(", ")}${names.length > 3 ? " ほか" : ""}）`;
      try {
        const sha = await commitFiles(env, { files, message, author: email });
        return J({ ok: true, sha, names });
      } catch (e) {
        if (e.code === "conflict") return J({ ok: false, error: "conflict" }, 409);
        throw e;
      }
    }

    // --- 公開状況
    if (path === "/status") return J({ ok: true, ...(await buildStatus(env)) });

    // --- 保存（日本語を保存 → 足りない訳を自動生成 → まとめて 1 コミット）
    if (path === "/save" && request.method === "POST") {
      const body = await request.json();
      const edited = body.files || {};
      for (const p of Object.keys(edited)) {
        if (!DATA_FILES.includes(p)) return J({ ok: false, error: "bad_path", path: p }, 400);
      }
      if (!Object.keys(edited).length && !body.i18n) return J({ ok: false, error: "no_files" }, 400);

      // 翻訳記憶と、翻訳対象の全データを揃える
      const current = await loadBundle(env);
      if (body.head && body.head !== current.head)
        return J({ ok: false, error: "conflict", hint: "ほかの方が先に保存しました。画面を再読み込みしてください。" }, 409);

      const mem = current.files["data/i18n.json"] || {};
      let report = null;

      // 画面で人が直接直した訳文を反映し、人工確認済みにする
      let manual = 0;
      for (const [key, langs] of Object.entries(body.i18n || {})) {
        const entry = mem[key];
        if (!entry) continue;
        for (const [lang, text] of Object.entries(langs)) {
          if (!TRANSLATABLE.includes(lang)) continue;
          if (text === null) {
            // 「日本語から再翻訳」… 一度空にし、この後の自動翻訳で作り直してもらう
            entry[lang] = "";
            entry.locked = false;
            if (lang === "zh-Hant") entry.hant_manual = false;
          } else {
            entry[lang] = String(text).slice(0, 4000);
            entry.locked = true;
            if (lang === "zh-Hant") entry.hant_manual = true;
          }
          manual++;
        }
      }

      // 自動翻訳（zh / en / ko。zh-Hant は公開時に簡体字から変換される）
      if (body.autoTranslate !== false && env.AI) {
        const trees = ["data/site.json"].map(
          (p) => (p in edited ? edited[p] : current.files[p])
        );
        try {
          report = await fillTranslations(env, mem, trees);
        } catch (err) {
          console.log("auto translate failed:", String(err).slice(0, 200));
          report = { error: String(err).slice(0, 120), added: 0, langs: {}, pending: 0 };
        }
      }

      const files = {};
      for (const [p, val] of Object.entries(edited)) files[p] = JSON.stringify(val, null, 2) + "\n";
      if ((report && report.added) || manual)
        files["data/i18n.json"] = JSON.stringify(sortMemory(mem), null, 2) + "\n";

      const sha = await commitFiles(env, {
        files,
        message: String(body.message || "管理画面から更新").slice(0, 200),
        author: email,
        expectHead: current.head,
      });
      return J({ ok: true, sha, translated: report, manual });
    }

    // --- 翻訳の動作確認（設定が正しいか見るための小さなテスト）
    if (path === "/translate-test") {
      if (!env.AI) return J({ ok: false, error: "no_ai_binding" }, 503);
      const samples = [
        "宿泊事業の収益を、設計から運用まで引き上げる。",
        "株式会社ステックは、宿泊施設の運営とシステム開発を同じ社内で行っています。",
        "客室清掃とリネン供給は請負方式でお受けします。",
      ];
      const mem = {};
      const t0 = Date.now();
      const out = await fillTranslations(env, mem, [samples]);
      return J({ ok: true, model: env.AI_MODEL || AI_MODEL_DEFAULT, ms: Date.now() - t0, out, results: Object.values(mem) });
    }
  } catch (err) {
    if (err.code === "conflict")
      return J({ ok: false, error: "conflict", hint: "ほかの人が先に保存しました。画面を再読み込みしてください。" }, 409);
    console.log("admin error:", String(err));
    return J({ ok: false, error: "server_error", detail: String(err).slice(0, 300) }, 500);
  }

  return J({ ok: false, error: "not_found" }, 404);
}

// ==== src/worker_contact.js ===========================================
/**
 * stek.ai — Cloudflare Pages advanced-mode worker.
 *
 * Serves the static site and handles the contact form:
 *   POST /api/contact  ->  sends an e-mail to info@stek.ai
 *
 * ---------------------------------------------------------------------------
 * 発信方法は 3 通り。上から順に、設定されているものが使われます。
 *
 *  A) 自社メールサーバー（Lark / 飛書）— DNS 変更不要・推奨
 *       SMTP_HOST   smtp.larksuite.com          (国内版 飛書 は smtp.feishu.cn)
 *       SMTP_PORT   465                          (465 = 暗黙 TLS / 587 = STARTTLS)
 *       SMTP_USER   noreplay@stek.ai        Lark の「公共メールボックス」アドレス
 *       SMTP_PASS   Lark 管理画面で発行する IMAP/SMTP 専用パスワード
 *  B) Resend        RESEND_API_KEY
 *  C) Brevo         BREVO_API_KEY
 *
 * 共通の任意設定:
 *       CONTACT_TO    既定 info@stek.ai
 *       CONTACT_FROM  既定 "株式会社ステック <SMTP_USER または noreplay@stek.ai>"
 * ---------------------------------------------------------------------------
 */


const DEFAULT_TO = "info@stek.ai";
const DEFAULT_FROM_ADDR = "noreplay@stek.ai";
const FROM_NAME = "株式会社ステック";
const LIMIT = { name: 120, company: 160, email: 200, tel: 60, kind: 120, reply: 40, lang: 16, page: 120, message: 6000 };

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const clean = (v, max) =>
  typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, max) : "";

const escapeHtml = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const addrOf = (s) => {
  const m = /<([^>]+)>/.exec(s || "");
  return (m ? m[1] : s || "").trim();
};

const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

/* ------------------------------------------------------------------ message */

function buildMail(d) {
  const rows = [
    ["お問い合わせ種別", d.kind],
    ["お名前", d.name],
    ["会社名・団体名", d.company],
    ["メールアドレス", d.email],
    ["電話番号", d.tel],
    ["ご希望の連絡方法", d.reply],
    ["言語", d.lang],
    ["送信元ページ", d.page],
  ].filter((r) => r[1]);

  const text =
    "stek.ai 公式サイトのお問い合わせフォームから送信されました。\n\n" +
    rows.map(([k, v]) => `${k}: ${v}`).join("\n") +
    "\n\n----- お問い合わせ内容 -----\n" +
    d.message +
    "\n---------------------------\n\n受信日時: " +
    new Date().toISOString();

  const html =
    '<div style="font-family:-apple-system,BlinkMacSystemFont,Hiragino Sans,Meiryo,sans-serif;font-size:14px;line-height:1.8;color:#222">' +
    '<p style="margin:0 0 16px">stek.ai 公式サイトのお問い合わせフォームから送信されました。</p>' +
    '<table cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:14px">' +
    rows
      .map(
        ([k, v]) =>
          `<tr><th align="left" style="background:#f6f2ec;border:1px solid #e6ded2;white-space:nowrap">${escapeHtml(
            k
          )}</th><td style="border:1px solid #e6ded2">${escapeHtml(v)}</td></tr>`
      )
      .join("") +
    "</table>" +
    '<p style="margin:18px 0 6px;font-weight:600">お問い合わせ内容</p>' +
    `<div style="white-space:pre-wrap;border:1px solid #e6ded2;padding:12px;background:#fffdf9">${escapeHtml(
      d.message
    )}</div>` +
    "</div>";

  const subject = `【stek.ai お問い合わせ】${d.kind || "その他"} / ${d.name}`;
  return { subject, text, html };
}

/* --------------------------------------------------------------- A) own SMTP */

function mimeMessage({ fromName, fromAddr, to, replyTo, replyName, subject, text, html }) {
  const enc = (s) => "=?UTF-8?B?" + b64(s) + "?=";
  const bd = "stek" + Math.random().toString(36).slice(2, 12);
  const head = [
    `From: ${enc(fromName)} <${fromAddr}>`,
    `To: <${to}>`,
    replyTo ? `Reply-To: ${replyName ? enc(replyName) + " " : ""}<${replyTo}>` : null,
    `Subject: ${enc(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@stek.ai>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${bd}"`,
  ]
    .filter(Boolean)
    .join("\r\n");

  const part = (type, body) =>
    `--${bd}\r\nContent-Type: text/${type}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n` +
    (b64(body).match(/.{1,76}/g) || []).join("\r\n") +
    "\r\n";

  return head + "\r\n\r\n" + part("plain", text) + part("html", html) + `--${bd}--\r\n`;
}

async function sendSmtp(env, d) {
  const host = env.SMTP_HOST;
  const port = Number(env.SMTP_PORT || 465);
  const user = env.SMTP_USER;
  const pass = env.SMTP_PASS;
  const to = env.CONTACT_TO || DEFAULT_TO;
  const fromAddr = addrOf(env.CONTACT_FROM) || user || DEFAULT_FROM_ADDR;
  const { subject, text, html } = buildMail(d);

  const starttls = port === 587;
  let socket = connect({ hostname: host, port }, { secureTransport: starttls ? "starttls" : "on" });
  let writer = socket.writable.getWriter();
  let reader = socket.readable.getReader();
  const dec = new TextDecoder();
  const encoder = new TextEncoder();
  let buf = "";

  const read = async () => {
    // read until a complete final reply line ("250 ..." rather than "250-...")
    for (;;) {
      const m = /^(?:\d{3}-[^\r\n]*\r?\n)*(\d{3}) [^\r\n]*\r?\n/.exec(buf);
      if (m) {
        const line = buf.slice(0, m[0].length);
        buf = buf.slice(m[0].length);
        return { code: Number(m[1]), line };
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("smtp closed: " + buf.slice(0, 120));
      buf += dec.decode(value, { stream: true });
    }
  };
  const say = async (cmd, expect) => {
    if (cmd !== null) await writer.write(encoder.encode(cmd + "\r\n"));
    const r = await read();
    if (expect && !expect.includes(r.code)) throw new Error("smtp " + r.code + ": " + r.line.trim().slice(0, 160));
    return r;
  };

  try {
    await say(null, [220]);
    await say("EHLO stek.ai", [250]);

    if (starttls) {
      await say("STARTTLS", [220]);
      reader.releaseLock();
      writer.releaseLock();
      socket = socket.startTls();
      writer = socket.writable.getWriter();
      reader = socket.readable.getReader();
      buf = "";
      await say("EHLO stek.ai", [250]);
    }

    await say("AUTH LOGIN", [334]);
    await say(b64(user), [334]);
    await say(b64(pass), [235]);
    await say(`MAIL FROM:<${fromAddr}>`, [250]);
    await say(`RCPT TO:<${to}>`, [250, 251]);
    await say("DATA", [354]);

    const body = mimeMessage({
      fromName: FROM_NAME,
      fromAddr,
      to,
      replyTo: d.email,
      replyName: d.name,
      subject,
      text,
      html,
    }).replace(/\r?\n\./g, "\r\n..");
    await writer.write(encoder.encode(body + "\r\n.\r\n"));
    await say(null, [250]);
    try {
      await say("QUIT", [221]);
    } catch (_) {
      /* some servers close hard after QUIT */
    }
    return "smtp";
  } finally {
    try {
      await socket.close();
    } catch (_) {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------ B/C) HTTP APIs */

async function sendResend(env, d) {
  const to = env.CONTACT_TO || DEFAULT_TO;
  const from = env.CONTACT_FROM || `${FROM_NAME} <${DEFAULT_FROM_ADDR}>`;
  const { subject, text, html } = buildMail(d);
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from, to: [to], reply_to: d.email, subject, text, html }),
  });
  if (!r.ok) throw new Error("resend " + r.status + " " + (await r.text()).slice(0, 300));
  return "resend";
}

async function sendBrevo(env, d) {
  const to = env.CONTACT_TO || DEFAULT_TO;
  const from = addrOf(env.CONTACT_FROM) || DEFAULT_FROM_ADDR;
  const { subject, text, html } = buildMail(d);
  const r = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": env.BREVO_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      sender: { email: from, name: FROM_NAME },
      to: [{ email: to }],
      replyTo: { email: d.email, name: d.name },
      subject,
      textContent: text,
      htmlContent: html,
    }),
  });
  if (!r.ok) throw new Error("brevo " + r.status + " " + (await r.text()).slice(0, 300));
  return "brevo";
}

async function send(env, d) {
  if (env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS) return sendSmtp(env, d);
  if (env.RESEND_API_KEY) return sendResend(env, d);
  if (env.BREVO_API_KEY) return sendBrevo(env, d);
  throw new Error("no_mail_transport_configured");
}

/* ------------------------------------------------------------------- handler */

// ==== src/worker_main.js ==============================================

// ------------------------------------------------------------------ ルーティング

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 管理画面 API
    if (url.pathname === "/api/admin" || url.pathname.startsWith("/api/admin/")) {
      return handleAdmin(request, env, url);
    }

    // メール送信の診断（ADMIN_SECRET を知っている場合のみ。原因文字列をそのまま返す）
    if (url.pathname === "/api/contact-diag") {
      const secret = url.searchParams.get("secret");
      if (!env.ADMIN_SECRET || secret !== env.ADMIN_SECRET) return json({ ok: false, error: "forbidden" }, 403);
      const envx = Object.assign({}, env);
      const ovHost = url.searchParams.get("host");
      const ovPort = url.searchParams.get("port");
      const ovUser = url.searchParams.get("user");
      if (ovHost) envx.SMTP_HOST = ovHost;
      if (ovPort) envx.SMTP_PORT = ovPort;
      if (ovUser) envx.SMTP_USER = ovUser;
      let fp = null;
      if (env.SMTP_PASS) {
        const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(env.SMTP_PASS)));
        fp = Array.from(new Uint8Array(buf).slice(0, 4))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      }
      const cfg = {
        SMTP_HOST: envx.SMTP_HOST || null,
        SMTP_PORT: envx.SMTP_PORT || null,
        SMTP_USER: envx.SMTP_USER || null,
        SMTP_PASS_len: env.SMTP_PASS ? String(env.SMTP_PASS).length : 0,
        SMTP_PASS_fp: fp,
        SMTP_PASS_trimmed_differs: env.SMTP_PASS ? String(env.SMTP_PASS) !== String(env.SMTP_PASS).trim() : null,
        CONTACT_TO: env.CONTACT_TO || null,
        CONTACT_FROM: env.CONTACT_FROM || null,
        RESEND: !!env.RESEND_API_KEY,
        BREVO: !!env.BREVO_API_KEY,
      };
      const dry = url.searchParams.get("send") !== "1";
      if (dry) return json({ ok: true, cfg, note: "設定のみ確認しました。実際に送信するには &send=1 を付けてください。" });
      try {
        const via = await send(envx, {
          kind: "動作確認",
          name: "配信テスト",
          email: env.CONTACT_TO || "info@stek.ai",
          company: "株式会社ステック",
          phone: "",
          message: "SMTP 設定の動作確認です（管理者による手動テスト）。",
        });
        return json({ ok: true, via, cfg });
      } catch (err) {
        return json({ ok: false, cfg, detail: String(err && err.message ? err.message : err).slice(0, 400) }, 502);
      }
    }

    // お問い合わせフォーム
    if (url.pathname === "/api/contact") {
      if (request.method !== "POST") return json({ ok: false, error: "method" }, 405);
      let body;
      try {
        body = await request.json();
      } catch (_) {
        return json({ ok: false, error: "bad_json" }, 400);
      }
      if (clean(body._gotcha, 40)) return json({ ok: true, skipped: true });

      const d = {};
      for (const k of Object.keys(LIMIT)) d[k] = clean(body[k], LIMIT[k]);
      if (!d.kind || !d.name || !d.email || !d.message) return json({ ok: false, error: "required" }, 400);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.email)) return json({ ok: false, error: "email" }, 400);

      try {
        const via = await send(env, d);
        return json({ ok: true, via });
      } catch (err) {
        console.log("contact mail failed:", String(err));
        return json({ ok: false, error: "send_failed" }, 502);
      }
    }

    return env.ASSETS.fetch(request);
  },
};
