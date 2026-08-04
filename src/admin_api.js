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
