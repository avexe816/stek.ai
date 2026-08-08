// stek.ai 管理画面 — app.js
// 素の JS（フレームワーク不使用）。状態はメモリ内変数のみ。

(function () {
  "use strict";

  // ============================================================ 状態

  const state = {
    me: null, // {ok,email,mode,configured,translator,repo}
    schema: null,
    original: null, // { "data/site.json": {...}, "data/i18n.json": {...} } 深いコピー
    draft: null,
    images: [],
    imageMeta: {},
    picker: null,
    imgSel: {},
    dragOver: false,
    trans: { stats: null, loading: false, running: false, log: "" },
    head: null,
    i18nByJa: null, // Map ja文字列 -> i18n entry（entry.__key にキーを持たせる）
    i18nEdits: {}, // 訳文の手直し { キー: { 言語: 文字列 or null(再翻訳) } }
    currentGroup: null, // group id | "__images__" | "__i18n__" | "__search__"
    search: "", // 全体検索のキーワード
    jumpTo: null, // 検索結果から移動したときに光らせるパス
    restore: null, // 未保存の下書きの復元候補
    openCards: {}, // "パス#idx" -> bool（配列カードの開閉）
    status: { state: "idle", url: "", at: "", message: "" },
    statusTimer: null,
    loading: true,
    loadError: null,
    loginError: null,
    loggingIn: false,
    saving: false,
    toasts: [],
    modal: null, // "diff" | "conflict" | null
    sideOpen: false,
    transPanel: null, // { ja: string } | null
    upload: { queue: [], problems: {}, busy: false, dragging: false, filter: "", justUploaded: [], seq: 1 },
  };

  let toastSeq = 1;

  // ============================================================ ユーティリティ

  function h(tag, attrs, children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === "class") el.className = v;
        else if (k === "html") el.innerHTML = v;
        else if (k.startsWith("on") && typeof v === "function") {
          el.addEventListener(k.slice(2).toLowerCase(), v);
        } else if (k === "checked" || k === "disabled" || k === "readOnly" || k === "value" || k === "hidden") {
          el[k] = v;
        } else {
          el.setAttribute(k, v);
        }
      }
    }
    (Array.isArray(children) ? children : children != null ? [children] : []).forEach((c) => {
      if (c == null) return;
      el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
    });
    return el;
  }

  function deepClone(obj) {
    return obj === undefined ? undefined : JSON.parse(JSON.stringify(obj));
  }

  function getPath(obj, dotted) {
    if (!dotted) return obj;
    return dotted.split(".").reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
  }

  function setPath(obj, dotted, value) {
    const parts = dotted.split(".");
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i];
      if (cur[k] == null || typeof cur[k] !== "object") cur[k] = /^\d+$/.test(parts[i + 1]) ? [] : {};
      cur = cur[k];
    }
    cur[parts[parts.length - 1]] = value;
  }

  async function api(path, opts) {
    let res;
    try {
      res = await fetch("/api/admin" + path, {
        credentials: "same-origin",
        headers: opts && opts.body ? { "content-type": "application/json" } : undefined,
        ...opts,
      });
    } catch (e) {
      const err = new Error("network");
      err.network = true;
      throw err;
    }
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      data = null;
    }
    if (res.status === 401) {
      state.me = { ok: true, email: null, mode: state.me ? state.me.mode : "password" };
      render();
      const err = new Error("unauthorized");
      err.status = 401;
      throw err;
    }
    return { status: res.status, data };
  }

  function pushToast(message, kind) {
    const id = toastSeq++;
    state.toasts.push({ id, message, kind: kind || "default" });
    render();
    setTimeout(() => {
      state.toasts = state.toasts.filter((t) => t.id !== id);
      render();
    }, 5200);
  }

  function autoGrow(textarea) {
    textarea.style.height = "auto";
    textarea.style.height = textarea.scrollHeight + "px";
  }

  // ============================================================ i18n 参照

  function buildI18nIndex() {
    const map = new Map();
    const dict = (state.draft && state.draft["data/i18n.json"]) || {};
    for (const [key, entry] of Object.entries(dict)) {
      if (entry && typeof entry.ja === "string" && !map.has(entry.ja)) {
        map.set(entry.ja, Object.assign({ __key: key }, entry));
      }
    }
    state.i18nByJa = map;
  }

  function hasI18nEdits() {
    return Object.keys(state.i18nEdits).length > 0;
  }

  function i18nEditValue(key, lang) {
    const row = state.i18nEdits[key];
    return row && lang in row ? row[lang] : undefined;
  }

  function setI18nEdit(key, lang, value) {
    const entry = (state.draft["data/i18n.json"] || {})[key];
    const base = entry ? entry[lang] || "" : "";
    if (value !== null && value === base) {
      if (state.i18nEdits[key]) {
        delete state.i18nEdits[key][lang];
        if (!Object.keys(state.i18nEdits[key]).length) delete state.i18nEdits[key];
      }
      return;
    }
    state.i18nEdits[key] = state.i18nEdits[key] || {};
    state.i18nEdits[key][lang] = value;
  }

  function isConfirmed(entry, lang) {
    if (!entry) return false;
    if (lang === "zh-Hant") return Boolean(entry.hant_manual);
    return Boolean(entry.locked);
  }

  function langLabel(code) {
    const map = (state.schema && state.schema.langLabels) || {};
    return map[code] || code;
  }

  function translatableLangs() {
    const all = (state.schema && state.schema.langs) || ["ja", "en", "zh", "zh-Hant", "ko"];
    return all.filter((l) => l !== "ja");
  }

  // ============================================================ ラベル解決

  // admin-schema.json.labels に無い項目の日本語ラベル（表記の抜け漏れを補う）
  const EXTRA_LABELS = {
    "about.hero_eyebrow": "見出し：小見出し",
    "about.hero_lead": "見出し：本文",
    "common.back_home": "共通：ホームへ戻るリンク",
    "common.close": "共通：閉じるボタン",
    "common.lang_label": "共通：言語切り替えの見出し",
    "common.menu": "共通：メニューボタン",
    "common.page_top": "共通：ページ上部へ戻るリンク",
    "common.skip": "共通：本文へスキップするリンク",
    "contact.hero_eyebrow": "見出し：小見出し",
    "contact.company_label": "フォーム項目名：会社名・施設名",
    "contact.email_label": "フォーム項目名：メールアドレス",
    "contact.info_hours_label": "右側ボックス：受付時間の項目名",
    "contact.info_mail_label": "右側ボックス：メールの項目名",
    "contact.kind_label": "フォーム項目名：お問い合わせ種別",
    "contact.message_label": "フォーム項目名：お問い合わせ内容",
    "contact.message_placeholder": "お問い合わせ内容：入力欄の例文",
    "contact.name_label": "フォーム項目名：お名前",
    "contact.optional": "フォーム表示：任意の項目に付く文字",
    "contact.privacy_link": "プライバシーポリシーへのリンク文言",
    "contact.privacy_note": "送信ボタン付近の同意文",
    "contact.reply_label": "フォーム項目名：ご希望の連絡方法",
    "contact.required": "フォーム表示：必須の項目に付く文字",
    "contact.sending": "送信中に表示する文言",
    "contact.tel_label": "フォーム項目名：電話番号",
    "home.services_eyebrow": "4領域：カード一覧の小見出し",
    "home.services_lead": "4領域：カード一覧の本文",
    "home.services_title": "4領域：カード一覧の見出し",
    "services_page.cta_lead": "末尾の案内：本文",
    "services_page.cta_title": "末尾の案内：見出し",
    "services_page.hero_eyebrow": "見出し：小見出し",
    "services_page.hero_lead": "見出し：本文",
    "services_page.hero_title": "見出し：大見出し（改行はそのまま反映されます）",
    "services_page.items_label": "各カード：内容一覧のラベル",
  };

  function siteLabel(key) {
    const labels = (state.schema && state.schema.labels) || {};
    if (labels[key]) return labels[key];
    if (EXTRA_LABELS[key]) return EXTRA_LABELS[key];
    // itemLabels（配列全体の名前）
    const item = (state.schema && state.schema.itemLabels) || {};
    if (item[key]) return item[key];
    const parts = key.split(".");
    return parts[parts.length - 1];
  }

  function groupNameById(id) {
    if (id === "__images__") return "写真";
    if (id === "__i18n__") return "翻訳の状況";
    const g = (state.schema.groups || []).find((g) => g.id === id);
    return g ? g.name : id;
  }

  function stringify(v) {
    if (v == null) return "";
    if (typeof v === "string") return v;
    try {
      return JSON.stringify(v);
    } catch (e) {
      return String(v);
    }
  }

  // ============================================================ 差分検出

  function collectLeafPaths(obj, prefix, into) {
    if (obj == null || typeof obj !== "object") return;
    if (Array.isArray(obj)) {
      into.add(prefix);
      return;
    }
    const keys = Object.keys(obj);
    if (keys.length === 0) {
      into.add(prefix);
      return;
    }
    for (const k of keys) {
      const p = prefix ? prefix + "." + k : k;
      const v = obj[k];
      if (v != null && typeof v === "object" && !Array.isArray(v)) {
        collectLeafPaths(v, p, into);
      } else {
        into.add(p);
      }
    }
  }

  function isSiteDirty() {
    return JSON.stringify(state.original["data/site.json"]) !== JSON.stringify(state.draft["data/site.json"]);
  }

  function dirtyFiles() {
    const out = [];
    if (isSiteDirty()) out.push("data/site.json");
    return out;
  }

  function computeDiffList() {
    const out = [];
    const before = state.original["data/site.json"] || {};
    const after = state.draft["data/site.json"] || {};
    const allKeys = new Set();
    collectLeafPaths(before, "", allKeys);
    collectLeafPaths(after, "", allKeys);
    const sorted = [...allKeys].sort();
    for (const key of sorted) {
      const b = getPath(before, key);
      const a = getPath(after, key);
      if (JSON.stringify(b) !== JSON.stringify(a)) {
        out.push({ label: fieldLabelForDiff(key), before: stringify(b), after: stringify(a) });
      }
    }
    return out;
  }

  // 配列添字を含むパス（例 "services.0.items.2.title"）を読める見出しにする
  function fieldLabelForDiff(key) {
    const parts = key.split(".");
    const segs = [];
    let acc = "";
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      acc = acc ? acc + "." + p : p;
      if (/^\d+$/.test(p)) {
        const n = Number(p) + 1;
        const arrKey = parts.slice(0, i).join(".");
        segs.push((siteLabel(arrKey) || arrKey) + " #" + n);
      } else if (i === parts.length - 1) {
        segs.push(siteLabel(acc) || p);
      }
    }
    return segs.join(" › ") || key;
  }

  function countDirtyTotal() {
    let n = computeDiffList().length;
    for (const row of Object.values(state.i18nEdits)) n += Object.keys(row).length;
    return n;
  }

  function updateSaveBar() {
    const old = document.querySelector(".savebar");
    if (old && old.parentNode) old.parentNode.replaceChild(renderSaveBar(), old);
  }

  // ============================================================ 翻訳の状況

  const LANG_JA = { en: "英語", zh: "簡体字中国語", ko: "韓国語", "zh-Hant": "繁体字中国語" };

  async function loadTransStats() {
    state.trans.loading = true;
    render();
    try {
      const res = await api("/translate-stats", { method: "GET" });
      state.trans.stats = res.data && res.data.ok ? res.data : null;
      if (!state.trans.stats) state.trans.log = "件数を取得できませんでした。";
    } catch (e) {
      state.trans.log = "サーバーに接続できませんでした。";
    }
    state.trans.loading = false;
    render();
  }

  async function runTransFill() {
    state.trans.running = true;
    state.trans.log = "翻訳しています…";
    render();
    let done = 0;
    for (let round = 0; round < 12; round++) {
      let res;
      try {
        res = await api("/translate-fill", { method: "POST", body: JSON.stringify({ limit: 80 }) });
      } catch (e) {
        state.trans.log = "サーバーに接続できませんでした。";
        break;
      }
      const d = res.data || {};
      if (!d.ok) {
        state.trans.log = d.hint || (d.error === "conflict" ? "ほかの方が先に保存しました。画面を再読み込みしてください。" : "翻訳できませんでした。");
        break;
      }
      done += d.added || 0;
      state.trans.log = `${done}件を翻訳しました。` + (d.pending ? `残り ${d.pending}件…` : "");
      render();
      if (!d.pending || !d.added) break;
    }
    state.trans.running = false;
    state.trans.log = done ? `${done}件の翻訳を追加しました。公開まで数分かかります。` : state.trans.log || "未翻訳はありませんでした。";
    if (done) startStatusPolling();
    render();
    loadTransStats();
  }

  function renderTransPage() {
    const t = state.trans;
    const st = t.stats;
    const rows = st
      ? ["en", "zh", "ko"].map((l) =>
          h("div", { class: "tr-row" }, [
            h("div", { class: "tr-lang" }, LANG_JA[l]),
            h("div", { class: "tr-bar" }, [
              h("span", { style: `width:${st.total ? Math.round(((st.total - st.missing[l]) / st.total) * 100) : 100}%` }),
            ]),
            h("div", { class: "tr-num" + (st.missing[l] ? " is-warn" : "") }, st.missing[l] ? "未翻訳 " + st.missing[l] + "件" : "すべて翻訳済み"),
          ])
        )
      : [];

    return h("main", { class: "main" }, [
      h("div", { class: "main-inner" }, [
        h("div", { class: "group-head" }, [
          h("h1", null, "翻訳の状況"),
          h("p", null, "日本語で書いた文章は、保存するときに英語・簡体字中国語・韓国語へ自動で翻訳されます（繁体字は公開時に簡体字から変換されます）。ここでは残っている未翻訳をまとめて処理できます。"),
        ]),
        h("div", { class: "card" }, [
          h("div", { class: "card-head" }, [h("h3", null, "言語ごとの状況")]),
          t.loading ? h("div", { class: "empty-state" }, "確認しています…") : null,
          st ? h("div", { class: "tr-list" }, rows) : null,
          st ? h("p", { class: "tr-note" }, `文章の総数 ${st.total}件／人が確認済みの訳 ${st.locked}件`) : null,
          h("div", { class: "tr-foot" }, [
            h(
              "button",
              { class: "btn btn-primary", type: "button", disabled: t.running || t.loading, onClick: runTransFill },
              t.running ? "翻訳しています…" : "未翻訳をまとめて翻訳する"
            ),
            h("button", { class: "btn btn-ghost", type: "button", disabled: t.running, onClick: loadTransStats }, "最新の状況を見る"),
          ]),
          t.log ? h("p", { class: "tr-log" }, t.log) : null,
        ]),
        h("div", { class: "card" }, [
          h("div", { class: "card-head" }, [h("h3", null, "個別に訳を直したいとき")]),
          h("p", { class: "tr-note" }, "各入力欄の横にある「訳文」ボタンから、言語ごとの訳を確認・手直しできます。手直しした訳は以後、自動翻訳で上書きされません。もう一度自動翻訳させたい場合は、訳文パネルの「日本語から再翻訳」を押してください。"),
        ]),
      ]),
    ]);
  }

  // ============================================================ 起動

  async function boot() {
    initTheme();
    try {
      const meRes = await api("/me");
      state.me = meRes.data;
    } catch (e) {
      state.loadError = "サーバーに接続できませんでした。通信状況をご確認のうえ、再読み込みしてください。";
      state.loading = false;
      render();
      return;
    }

    if (!state.me || !state.me.email) {
      state.loading = false;
      render();
      return;
    }
    await loadBundleAndStatus();
  }

  async function loadBundleAndStatus() {
    state.loading = true;
    state.loadError = null;
    render();
    try {
      const bRes = await api("/bundle");
      if (bRes.status !== 200 || !bRes.data || !bRes.data.ok) {
        state.loadError = "データの読み込みに失敗しました。しばらくしてから再読み込みしてください。";
        state.loading = false;
        render();
        return;
      }
      state.head = bRes.data.head;
      state.images = bRes.data.images || [];
      state.imageMeta = bRes.data.imageMeta || {};
      state.schema = bRes.data.files["data/admin-schema.json"];
      const files = {};
      files["data/site.json"] = bRes.data.files["data/site.json"] || {};
      files["data/i18n.json"] = bRes.data.files["data/i18n.json"] || {};
      state.original = deepClone(files);
      state.draft = deepClone(files);
      buildI18nIndex();
      checkDraftLocal();

      if (!state.currentGroup && state.schema && state.schema.groups && state.schema.groups[0]) {
        state.currentGroup = state.schema.groups[0].id;
      }
      state.loading = false;
      render();
      pollStatusOnce();
    } catch (e) {
      state.loadError = "データの読み込み中にエラーが発生しました。しばらくしてから再読み込みしてください。";
      state.loading = false;
      render();
    }
  }

  async function pollStatusOnce() {
    try {
      const sRes = await api("/status");
      if (sRes.data && sRes.data.ok) {
        state.status = sRes.data;
        render();
      }
    } catch (e) {
      /* ignore */
    }
  }

  function startStatusPolling() {
    let elapsed = 0;
    const INTERVAL_MS = 20000; // 仕様どおり 20 秒ごと
    if (state.statusTimer) clearInterval(state.statusTimer);
    state.statusTimer = setInterval(async () => {
      elapsed += INTERVAL_MS / 1000;
      try {
        const sRes = await api("/status");
        if (sRes.data && sRes.data.ok) {
          state.status = sRes.data;
          render();
          if (sRes.data.state === "ok" || sRes.data.state === "failed" || elapsed >= 600) {
            clearInterval(state.statusTimer);
            state.statusTimer = null;
            if (sRes.data.state === "ok") pushToast("公開が完了しました。", "ok");
            render();
          }
        }
      } catch (e) {
        if (elapsed >= 600) {
          clearInterval(state.statusTimer);
          state.statusTimer = null;
        }
      }
    }, INTERVAL_MS);
  }

  // ---- テーマ（本体サイトと localStorage を共有） ----
  function initTheme() {
    let saved = null;
    try {
      saved = localStorage.getItem("stek-theme");
    } catch (e) {}
    if (saved === "dark" || saved === "light") {
      document.documentElement.dataset.theme = saved;
    } else if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
      document.documentElement.dataset.theme = "dark";
    }
  }

  function toggleTheme() {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("stek-theme", next);
    } catch (e) {}
    render();
  }

  // ============================================================ ログイン

  async function handleLoginSubmit(email, password) {
    state.loginError = null;
    state.loggingIn = true;
    render();
    try {
      const res = await api("/login", { method: "POST", body: JSON.stringify({ email, password }) });
      if (res.data && res.data.ok) {
        state.me = { ...state.me, email: res.data.email };
        state.loggingIn = false;
        await loadBundleAndStatus();
      } else {
        state.loginError =
          res.status === 401
            ? "メールアドレスまたはパスワードが正しくありません。"
            : res.data && res.data.error === "not_configured"
            ? "ログイン機能がまだ設定されていません。管理者にお問い合わせください。"
            : "ログインできませんでした。しばらくしてから再度お試しください。";
        state.loggingIn = false;
        render();
      }
    } catch (e) {
      state.loginError = "サーバーに接続できませんでした。通信状況をご確認ください。";
      state.loggingIn = false;
      render();
    }
  }

  async function handleLogout() {
    try {
      await api("/logout");
    } catch (e) {
      /* ignore */
    }
    state.me = { ...state.me, email: null };
    state.original = null;
    state.draft = null;
    render();
  }

  // ============================================================ 保存

  function buildSavePayload() {
    const files = {};
    for (const key of dirtyFiles()) files[key] = state.draft[key];
    return files;
  }

  async function doSave(message) {
    const files = buildSavePayload();
    const i18nEdits = state.i18nEdits;
    if (Object.keys(files).length === 0 && !hasI18nEdits()) return;
    state.saving = true;
    render();
    try {
      const res = await api("/save", {
        method: "POST",
        body: JSON.stringify({
          head: state.head,
          message: message || "管理画面から更新",
          files,
          i18n: i18nEdits,
          autoTranslate: true,
        }),
      });
      if (res.status === 200 && res.data && res.data.ok) {
        state.head = res.data.sha;
        state.original = deepClone(state.draft);
        state.i18nEdits = {};
        clearDraftLocal();
        state.saving = false;
        state.modal = null;
        const tr = res.data.translated;
        if (tr && tr.error) {
          pushToast("保存しました。ただし自動翻訳に失敗しました（" + tr.error + "）。", "error");
        } else if (tr && tr.added) {
          const n = Object.values(tr.langs || {}).reduce((a, b) => a + b, 0);
          pushToast("保存しました。" + n + "件を自動翻訳しました。公開まで数分かかります。", "ok");
        } else {
          pushToast("保存しました。公開まで数分かかります。", "ok");
        }
        render();
        try {
          const immediateStatusRes = await api("/status");
          if (immediateStatusRes.data && immediateStatusRes.data.ok) {
            state.status = immediateStatusRes.data;
            render();
          }
        } catch (e) {
          /* ポーリングに任せる */
        }
        startStatusPolling();
      } else if (res.status === 409) {
        state.saving = false;
        state.modal = "conflict";
        render();
      } else {
        state.saving = false;
        pushToast("保存に失敗しました。時間をおいて再度お試しください。", "error");
        render();
      }
    } catch (e) {
      state.saving = false;
      pushToast("サーバーに接続できませんでした。", "error");
      render();
    }
  }

  // ============================================================ beforeunload

  window.addEventListener("beforeunload", (e) => {
    if (state.draft && (dirtyFiles().length > 0 || hasI18nEdits())) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  // ============================================================ 描画：ルート

  // ============================================================ 下書きの自動保存

  const DRAFT_KEY = "stek-admin-draft";
  let draftTimer = null;

  function saveDraftLocal() {
    if (!state.draft || !state.original) return;
    try {
      if (!dirtyFiles().length && !hasI18nEdits()) {
        localStorage.removeItem(DRAFT_KEY);
        return;
      }
      localStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({ head: state.head, at: new Date().toISOString(), draft: state.draft, i18nEdits: state.i18nEdits })
      );
    } catch (e) {
      /* 容量超過などは無視する */
    }
  }

  function scheduleDraftSave() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraftLocal, 600);
  }

  function clearDraftLocal() {
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch (e) {}
  }

  function checkDraftLocal() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
    } catch (e) {}
    if (!saved || !saved.draft) return;
    if (saved.head && state.head && saved.head !== state.head) {
      clearDraftLocal();
      return;
    }
    if (JSON.stringify(saved.draft) === JSON.stringify(state.original)) {
      clearDraftLocal();
      return;
    }
    state.restore = saved;
  }

  function renderRestoreBar() {
    if (!state.restore) return null;
    let when = "";
    try {
      when = new Date(state.restore.at).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    } catch (e) {}
    return h("div", { class: "restore-bar" }, [
      h("span", null, "保存されていない編集内容がこの端末に残っています" + (when ? "（" + when + "）" : "") + "。"),
      h(
        "button",
        {
          class: "btn btn-sm",
          type: "button",
          onClick: () => {
            state.draft = deepClone(state.restore.draft);
            state.i18nEdits = state.restore.i18nEdits || {};
            state.restore = null;
            pushToast("編集内容を復元しました", "ok");
            render();
          },
        },
        "復元する"
      ),
      h(
        "button",
        {
          class: "btn btn-sm btn-ghost",
          type: "button",
          onClick: () => {
            state.restore = null;
            clearDraftLocal();
            render();
          },
        },
        "破棄する"
      ),
    ]);
  }

  // ============================================================ 全体検索

  function searchHits(q) {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    const site = state.draft["data/site.json"] || {};
    const hits = [];
    const walk = (val, path) => {
      if (hits.length >= 60) return;
      if (Array.isArray(val)) {
        val.forEach((v, i) => walk(v, path.concat(String(i))));
      } else if (val && typeof val === "object") {
        Object.entries(val).forEach(([k, v]) => walk(v, path.concat(k)));
      } else if (typeof val === "string" || typeof val === "number") {
        const s = String(val);
        const label = searchLabel(site, path);
        if (s.toLowerCase().includes(needle) || label.toLowerCase().includes(needle)) {
          hits.push({ path: path.join("."), value: s, label: label, group: path[0] });
        }
      }
    };
    Object.entries(site).forEach(([k, v]) => walk(v, [k]));
    return hits;
  }

  // 検索結果に出す場所の名前（例：選ばれる3つの理由 › 運営者としての視点 › 本文）
  function searchLabel(site, path) {
    const titleKeys = (state.schema && state.schema.titleKeys) || ["label", "name", "title", "q", "h", "k", "t", "no"];
    const parts = [];
    for (let i = 1; i < path.length; i++) {
      const seg = path[i];
      if (/^\d+$/.test(seg)) {
        const item = getPath(site, path.slice(0, i + 1).join("."));
        let title = "";
        if (item && typeof item === "object") {
          for (const k of titleKeys) {
            if (typeof item[k] === "string" && item[k].trim()) {
              title = item[k];
              break;
            }
          }
        }
        parts.push(title ? (title.length > 24 ? title.slice(0, 24) + "…" : title) : "#" + (Number(seg) + 1));
      } else if (i === path.length - 1) {
        parts.push(SUBFIELD_LABELS[seg] ? String(SUBFIELD_LABELS[seg]).split("（")[0] : siteLabel(path.join(".")));
      } else {
        parts.push(siteLabel(path.slice(0, i + 1).join(".")));
      }
    }
    return parts.join("　›　");
  }

  function jumpToPath(path) {
    const seg = path.split(".");
    state.currentGroup = (state.schema.groups || []).map((g) => g.id).includes(seg[0]) ? seg[0] : state.currentGroup;
    // 途中の配列カードをすべて開く
    for (let i = 1; i < seg.length; i++) {
      if (/^\d+$/.test(seg[i])) state.openCards[seg.slice(0, i).join(".") + "#" + seg[i]] = true;
    }
    state.jumpTo = path;
    state.sideOpen = false;
    render();
  }

  function renderSearchPage() {
    const hits = searchHits(state.search);
    const body = [
      h("h1", { class: "page-title" }, "検索結果"),
      h("p", { class: "page-desc" }, "「" + state.search + "」を含む項目：" + hits.length + "件" + (hits.length >= 60 ? "（上位60件）" : "")),
    ];
    if (!hits.length) {
      body.push(h("div", { class: "empty-state" }, "見つかりませんでした。別の言葉でお試しください。"));
    }
    const re = new RegExp(state.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    for (const hit of hits) {
      const snippet = hit.value.length > 160 ? hit.value.slice(0, 160) + "…" : hit.value;
      body.push(
        h("button", { class: "hit", type: "button", onClick: () => jumpToPath(hit.path) }, [
          h("div", { class: "hit-where" }, groupNameById(hit.group) + "　›　" + hit.label),
          h("div", { class: "hit-text", html: escapeHtml(snippet).replace(re, (m) => "<mark>" + m + "</mark>") }),
        ])
      );
    }
    return h("main", { class: "main" }, [h("div", { class: "main-inner" }, body)]);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  // 再描画で「スクロール位置が先頭に戻る」「入力中のカーソルが外れる」のを防ぐ。
  // 描画前に位置と入力状態を控え、描画後に同じ場所へ戻す。
  function captureUiState(root) {
    const snap = { win: window.scrollY || 0, panes: [], path: null, selStart: null, selEnd: null };
    root.querySelectorAll(".main, .side, .modal-body, .trans-panel-body").forEach((el, i) => {
      snap.panes.push({ i: i, cls: el.className, top: el.scrollTop });
    });
    const a = document.activeElement;
    if (a && a !== document.body && root.contains(a)) {
      const path = [];
      let cur = a;
      while (cur && cur !== root) {
        const par = cur.parentNode;
        if (!par) return snap;
        path.unshift([].indexOf.call(par.childNodes, cur));
        cur = par;
      }
      snap.path = path;
      try {
        if (typeof a.selectionStart === "number") {
          snap.selStart = a.selectionStart;
          snap.selEnd = a.selectionEnd;
        }
      } catch (e) {}
    }
    return snap;
  }

  function restoreUiState(root, snap) {
    if (!snap) return;
    const panes = root.querySelectorAll(".main, .side, .modal-body, .trans-panel-body");
    snap.panes.forEach((p) => {
      const el = panes[p.i];
      if (el && el.className === p.cls) el.scrollTop = p.top;
    });
    if (window.scrollY !== snap.win) window.scrollTo(0, snap.win);
    if (!snap.path) return;
    let cur = root;
    for (const idx of snap.path) {
      cur = cur.childNodes[idx];
      if (!cur) return;
    }
    if (cur === document.activeElement) return;
    if (typeof cur.focus !== "function") return;
    try {
      cur.focus({ preventScroll: true });
      if (snap.selStart !== null && typeof cur.setSelectionRange === "function") {
        cur.setSelectionRange(snap.selStart, snap.selEnd);
      }
    } catch (e) {}
  }

  function render() {
    const root = document.getElementById("app");
    const snap = captureUiState(root);
    const hadJump = !!state.jumpTo;
    root.innerHTML = "";

    if (state.loading) {
      root.appendChild(renderSkeleton());
      return;
    }
    if (state.loadError) {
      root.appendChild(renderFatalError(state.loadError));
      return;
    }
    if (!state.me || !state.me.email) {
      root.appendChild(renderLogin());
      return;
    }
    root.appendChild(renderShell());
    root.appendChild(renderToasts());
    if (state.modal === "diff") root.appendChild(renderDiffModal());
    if (state.modal === "conflict") root.appendChild(renderConflictModal());
    if (state.modal === "picker") root.appendChild(renderPickerModal());
    if (state.transPanel) {
      root.appendChild(renderTransOverlay());
      root.appendChild(renderTransPanel());
    }

    root.querySelectorAll("textarea[data-autogrow]").forEach((t) => autoGrow(t));

    if (!hadJump) restoreUiState(root, snap);

    if (state.jumpTo) {
      const target = root.querySelector('[data-path="' + state.jumpTo.replace(/"/g, '\\"') + '"]');
      state.jumpTo = null;
      if (target) {
        target.classList.add("field--flash");
        target.scrollIntoView({ block: "center", behavior: "smooth" });
        setTimeout(() => target.classList.remove("field--flash"), 2200);
      }
    }

    scheduleDraftSave();
  }

  function renderSkeleton() {
    return h("div", { class: "boot-skeleton" }, [
      h("div", { class: "boot-skeleton__bar" }),
      h("div", { class: "boot-skeleton__row" }, [
        h("div", { class: "boot-skeleton__side" }),
        h("div", { class: "boot-skeleton__main" }, [
          h("div", { class: "sk-line", style: "width:40%" }),
          h("div", { class: "sk-line", style: "width:70%" }),
          h("div", { class: "sk-block" }),
        ]),
      ]),
    ]);
  }

  function logoMark() {
    return h("img", { src: "/assets/favicon.svg", alt: "", width: "24", height: "24" });
  }

  function renderFatalError(message) {
    return h("div", { class: "login-screen" }, [
      h("div", { class: "login-card" }, [
        h("div", { class: "login-logo" }, [logoMark(), h("b", null, "stek.ai"), h("span", null, "サイト管理")]),
        h("div", { class: "error-state" }, message),
        h("div", { style: "margin-top:16px" }, [h("button", { class: "btn btn-primary", onClick: () => location.reload() }, "再読み込み")]),
      ]),
    ]);
  }

  // ============================================================ 描画：ログイン

  function renderLogin() {
    const mode = state.me ? state.me.mode : "password";

    if (mode === "access") {
      return h("div", { class: "login-screen" }, [
        h("div", { class: "login-card" }, [
          h("div", { class: "login-logo" }, [logoMark(), h("b", null, "stek.ai"), h("span", null, "サイト管理")]),
          h("div", { class: "login-note" }, "アクセス権がありません。管理者にお問い合わせください。"),
        ]),
      ]);
    }

    let emailVal = "";
    let pwVal = "";

    const emailInput = h("input", {
      type: "email",
      id: "loginEmail",
      placeholder: "yamada@stek.ai",
      autocomplete: "username",
      required: true,
      value: emailVal,
      onInput: (e) => (emailVal = e.target.value),
    });
    const pwInput = h("input", {
      type: "password",
      id: "loginPw",
      placeholder: "パスワード",
      autocomplete: "current-password",
      required: true,
      value: pwVal,
      onInput: (e) => (pwVal = e.target.value),
    });

    const form = h(
      "form",
      {
        onSubmit: (e) => {
          e.preventDefault();
          if (state.loggingIn) return;
          if (!emailVal.trim() || !pwVal) {
            state.loginError = "メールアドレスとパスワードを入力してください。";
            render();
            return;
          }
          handleLoginSubmit(emailVal.trim(), pwVal);
        },
      },
      [
        h("div", { class: "login-field" }, [
          h("label", { for: "loginEmail" }, "メールアドレス"),
          emailInput,
          h("div", { class: "login-hint" }, "登録済みのアドレスのみログインできます。"),
        ]),
        h("div", { class: "login-field" }, [h("label", { for: "loginPw" }, "パスワード"), pwInput]),
        state.loginError ? h("div", { class: "login-error" }, state.loginError) : null,
        h(
          "button",
          { class: "btn btn-primary", type: "submit", style: "width:100%", disabled: state.loggingIn },
          state.loggingIn ? "ログインしています…" : "ログイン"
        ),
      ]
    );

    return h("div", { class: "login-screen" }, [
      h("div", { class: "login-card" }, [
        h("div", { class: "login-logo" }, [logoMark(), h("b", null, "stek.ai"), h("span", null, "サイト管理")]),
        h("div", { class: "login-title" }, "管理画面にログイン"),
        form,
      ]),
    ]);
  }

  // ============================================================ 描画：全体シェル

  function renderShell() {
    return h("div", { class: "app" }, [
      renderHeader(),
      renderRestoreBar(),
      h("div", { class: "shell" }, [
        renderSidebar(),
        h("div", { class: "side-backdrop" + (state.sideOpen ? " open" : ""), onClick: () => ((state.sideOpen = false), render()) }),
        renderMain(),
      ]),
      renderSaveBar(),
    ]);
  }

  function renderHeader() {
    return h("header", { class: "hdr" }, [
      h(
        "button",
        {
          class: "btn btn-ghost burger-btn",
          "aria-label": "メニューを開く",
          onClick: () => {
            state.sideOpen = !state.sideOpen;
            render();
          },
        },
        "☰"
      ),
      h("div", { class: "hdr-logo" }, [logoMark(), h("b", null, "stek.ai"), h("span", null, "サイト管理")]),
      h("div", { class: "hdr-spacer" }),
      h("div", { class: "hdr-user", title: state.me.email }, state.me.email),
      h(
        "button",
        {
          class: "btn btn-ghost theme-toggle",
          title: "画面の色を切り替える",
          "aria-label": "画面の色を切り替える",
          onClick: toggleTheme,
        },
        [
          h("svg", { class: "i-moon", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.8", html: '<path d="M21 12.6A9 9 0 1 1 11.4 3 7 7 0 0 0 21 12.6Z"/>' }),
          h("svg", { class: "i-sun", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.8", html: '<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>' }),
        ]
      ),
      h("button", { class: "btn btn-ghost btn-sm", onClick: onLogoutClick }, "ログアウト"),
    ]);
  }

  function onLogoutClick() {
    if (dirtyFiles().length > 0 || hasI18nEdits()) {
      if (!confirm("保存されていない変更があります。ログアウトしてもよろしいですか？")) return;
    }
    handleLogout();
  }

  function renderStatusBadge() {
    const st = state.status.state;
    if (st === "ok") return h("span", { class: "badge badge-ok" }, [h("span", { class: "badge-dot" }), "公開済み"]);
    if (st === "building") return h("span", { class: "badge badge-building" }, [h("span", { class: "spin" }, "⟳"), "公開中…"]);
    if (st === "failed") return h("span", { class: "badge badge-failed" }, [h("span", { class: "badge-dot" }), "公開に失敗しました"]);
    return h("span", { class: "badge badge-idle" }, [h("span", { class: "badge-dot" }), "未公開"]);
  }

  // ============================================================ 描画：サイドバー

  function renderSidebar() {
    const items = [];
    items.push(
      h("div", { class: "side-search" }, [
        h("input", {
          type: "search",
          class: "side-search-input",
          placeholder: "サイト内の文章を探す",
          value: state.search,
          onInput: (e) => {
            state.search = e.target.value;
            state.currentGroup = state.search.trim() ? "__search__" : (state.schema.groups[0] || {}).id;
            const pos = e.target.selectionStart;
            render();
            const box = document.querySelector(".side-search-input");
            if (box) {
              box.focus();
              try {
                box.setSelectionRange(pos, pos);
              } catch (err) {}
            }
          },
        }),
      ])
    );
    for (const group of state.schema.groups || []) {
      items.push(
        h(
          "button",
          {
            class: "side-item" + (state.currentGroup === group.id ? " active" : ""),
            onClick: () => {
              state.currentGroup = group.id;
              state.sideOpen = false;
              render();
            },
          },
          [group.name, groupHasChanges(group.id) ? h("span", { class: "side-dot" }) : null]
        )
      );
    }
    items.push(h("div", { class: "side-sep" }));
    items.push(
      h(
        "button",
        {
          class: "side-item" + (state.currentGroup === "__images__" ? " active" : ""),
          onClick: () => {
            state.currentGroup = "__images__";
            state.sideOpen = false;
            render();
          },
        },
        ["写真", state.upload.queue.length ? h("span", { class: "side-dot" }) : null]
      )
    );
    items.push(
      h(
        "button",
        {
          class: "side-item" + (state.currentGroup === "__i18n__" ? " active" : ""),
          onClick: () => {
            state.currentGroup = "__i18n__";
            state.sideOpen = false;
            render();
            loadTransStats();
          },
        },
        ["翻訳の状況", state.trans.stats && state.trans.stats.missingTotal ? h("span", { class: "side-dot" }) : null]
      )
    );

    const statusBox = h("div", { class: "side-status" }, [
      h("div", { class: "side-status-label" }, "公開状況"),
      renderStatusBadge(),
      state.status.url ? h("a", { class: "side-status-link", href: state.status.url, target: "_blank", rel: "noopener" }, "詳しく見る") : null,
    ]);

    return h("nav", { class: "side" + (state.sideOpen ? " open" : "") }, [h("div", { class: "side-list" }, items), statusBox]);
  }

  function groupHasChanges(groupId) {
    const before = state.original["data/site.json"] || {};
    const after = state.draft["data/site.json"] || {};
    const beforeSub = getPath(before, groupId);
    const afterSub = getPath(after, groupId);
    return JSON.stringify(beforeSub) !== JSON.stringify(afterSub);
  }

  // ============================================================ 描画：メインエリア

  function renderMain() {
    if (!state.currentGroup) {
      return h("main", { class: "main" }, [h("div", { class: "main-inner" }, [h("div", { class: "empty-state" }, "編集する項目を左のメニューから選んでください。")])]);
    }
    if (state.currentGroup === "__search__") return renderSearchPage();
    if (state.currentGroup === "__images__") return renderImagesPage();
    if (state.currentGroup === "__i18n__") return renderTransPage();
    return renderGroupPage();
  }

  // ------------------------------------------------------------ グループページ

  function renderGroupPage() {
    const group = (state.schema.groups || []).find((g) => g.id === state.currentGroup);
    if (!group) {
      return h("main", { class: "main" }, [h("div", { class: "main-inner" }, [h("div", { class: "error-state" }, "グループが見つかりません。")])]);
    }

    const siteRoot = state.draft["data/site.json"] || {};
    const groupData = getPath(siteRoot, group.id);

    const fields = [];
    if (Array.isArray(groupData)) {
      // グループの直下がいきなり配列（例: services）
      fields.push(renderArrayField(group.id, groupData));
    } else if (groupData !== undefined) {
      renderFieldsFor(group.id, groupData, fields);
    }

    if (fields.length === 0) {
      return h("main", { class: "main" }, [
        h("div", { class: "main-inner" }, [
          h("div", { class: "group-head" }, [h("h1", null, group.name), h("p", null, group.desc)]),
          h("div", { class: "empty-state" }, "このグループに編集できる項目はまだありません。"),
        ]),
      ]);
    }

    return h("main", { class: "main" }, [
      h("div", { class: "main-inner" }, [
        h("div", { class: "group-head" }, [h("h1", null, group.name), h("p", null, group.desc), renderPreviewLink(group.id)]),
        ...fields,
      ]),
    ]);
  }

  // 編集中の内容が載るページを別タブで確認
  const GROUP_PREVIEW = {
    home: "/",
    services: "/services",
    services_page: "/services",
    news: "/news",
    posts: "/news",
    about: "/about",
    contact: "/contact",
    privacy: "/privacy",
    brand: "/",
    menu: "/",
    nav: "/",
    footer: "/",
    common: "/",
  };

  function renderPreviewLink(groupId) {
    const url = GROUP_PREVIEW[groupId];
    if (!url) return null;
    return h(
      "a",
      { class: "preview-link", href: url, target: "_blank", rel: "noopener" },
      "公開中のページを見る ↗"
    );
  }

  /** key配下（オブジェクト）を再帰的に走査してフィールドを積む */
  function renderFieldsFor(basePath, value, out) {
    if (value == null || typeof value !== "object" || Array.isArray(value)) return;
    for (const [k, v] of Object.entries(value)) {
      const path = basePath ? basePath + "." + k : k;
      if (Array.isArray(v)) {
        out.push(renderArrayField(path, v));
      } else if (v != null && typeof v === "object") {
        renderFieldsFor(path, v, out);
      } else {
        out.push(renderScalarField(path, v));
      }
    }
  }

  function isAdvancedKey(key) {
    const last = key.split(".").pop();
    return last === "id" || last === "no";
  }

  function renderScalarField(path, value) {
    const advanced = isAdvancedKey(path);
    const before = getPath(state.original["data/site.json"] || {}, path);
    const dirty = JSON.stringify(before) !== JSON.stringify(value);
    const label = siteLabel(path);

    const onChange = (val) => {
      setPath(state.draft["data/site.json"], path, val);
      render();
    };

    const isMultiline = typeof value === "string" && (value.length > 48 || value.includes("\n"));
    let control;
    if (isImageKey(path)) {
      control = renderImageControl(value, onChange);
    } else if (typeof value === "number") {
      control = h("input", { type: "number", value: value, onInput: (e) => onChange(e.target.value === "" ? "" : Number(e.target.value)) });
    } else if (isMultiline) {
      control = h("textarea", {
        "data-autogrow": "1",
        value: value == null ? "" : String(value),
        onInput: (e) => {
          onChange(e.target.value);
          autoGrow(e.target);
        },
      });
    } else {
      control = h("input", { type: "text", value: value == null ? "" : String(value), onInput: (e) => onChange(e.target.value) });
    }

    const labelRow = h("div", { class: "field-label-row" }, [
      h("span", { class: "field-label" + (advanced ? " field-label--adv" : "") }, advanced ? "上級者向け：" + label : label),
      dirty ? h("span", { class: "dirty-dot" }) : null,
      typeof value === "string" && value.trim() && !isImageKey(path)
        ? h("button", { type: "button", class: "trans-btn", onClick: () => openTransPanel(value) }, "訳文")
        : null,
    ]);

    return h("div", { class: "field" + (advanced ? " field--adv" : ""), "data-path": path }, [labelRow, control, seoHint(path, value)]);
  }

  // 検索結果に出る文章は長さの目安を表示する
  const SEO_RANGE = { title: [20, 32], desc: [70, 120] };

  function seoHint(path, value) {
    if (typeof value !== "string") return null;
    const m = /^meta\.[a-z0-9_]+_(title|desc)$/.exec(path);
    if (!m) return null;
    const [lo, hi] = SEO_RANGE[m[1]];
    const n = Array.from(value).length;
    const state_ = n === 0 ? "warn" : n < lo ? "warn" : n > hi ? "warn" : "ok";
    const note = n > hi ? "長すぎると検索結果で途切れます" : n < lo ? "もう少し詳しく書くと効果的です" : "ちょうどよい長さです";
    return h("div", { class: "seo-hint seo-hint--" + state_ }, n + "文字（目安 " + lo + "〜" + hi + "文字）・" + note);
  }

  function renderArrayField(path, arr) {
    const before = getPath(state.original["data/site.json"] || {}, path);
    const dirty = JSON.stringify(before) !== JSON.stringify(arr);
    const label = siteLabel(path);
    const isObjArr = arr.length > 0 && typeof arr[0] === "object" && arr[0] !== null && !Array.isArray(arr[0]);
    // 空配列は最初の要素の型が分からないので、既知のオブジェクト配列パスを推測する
    const looksLikeObjArr = isObjArr || (arr.length === 0 && guessArrayIsObjFromSchema(path));

    const onChange = (newArr) => {
      setPath(state.draft["data/site.json"], path, newArr);
      render();
    };

    const labelRow = h("div", { class: "field-label-row" }, [h("span", { class: "field-label" }, label), dirty ? h("span", { class: "dirty-dot" }) : null]);

    const control = looksLikeObjArr ? renderListObj(path, arr, onChange) : renderListText(arr, onChange);

    return h("div", { class: "field", "data-path": path }, [labelRow, control]);
  }

  function guessArrayIsObjFromSchema(path) {
    // 文字列配列として知られているキーの一覧（admin-schema.itemLabels 由来 + 慣習）
    const textArrayKeys = ["contact.kinds", "contact.reply_options", "about.purpose"];
    return !textArrayKeys.includes(path);
  }

  // ---- 文字列配列（1行1項目） ----
  function renderListText(arr, onChange) {
    const rows = arr.map((val, idx) => {
      const isLong = typeof val === "string" && val.length > 48;
      const input = isLong
        ? h("textarea", {
            "data-autogrow": "1",
            value: val,
            onInput: (e) => {
              const copy = arr.slice();
              copy[idx] = e.target.value;
              onChange(copy);
              autoGrow(e.target);
            },
          })
        : h("input", {
            type: "text",
            value: val,
            onInput: (e) => {
              const copy = arr.slice();
              copy[idx] = e.target.value;
              onChange(copy);
            },
          });
      const controls = [
        h(
          "button",
          {
            class: "btn btn-icon btn-ghost",
            disabled: idx === 0,
            title: "上へ",
            type: "button",
            onClick: () => {
              const copy = arr.slice();
              [copy[idx - 1], copy[idx]] = [copy[idx], copy[idx - 1]];
              onChange(copy);
            },
          },
          "↑"
        ),
        h(
          "button",
          {
            class: "btn btn-icon btn-ghost",
            disabled: idx === arr.length - 1,
            title: "下へ",
            type: "button",
            onClick: () => {
              const copy = arr.slice();
              [copy[idx + 1], copy[idx]] = [copy[idx], copy[idx + 1]];
              onChange(copy);
            },
          },
          "↓"
        ),
        h(
          "button",
          {
            class: "btn btn-icon btn-ghost",
            title: "削除",
            type: "button",
            onClick: () => {
              const copy = arr.slice();
              copy.splice(idx, 1);
              onChange(copy);
            },
          },
          "×"
        ),
        typeof val === "string" && val.trim() ? h("button", { class: "btn btn-icon btn-ghost", title: "訳文", type: "button", onClick: () => openTransPanel(val) }, "訳") : null,
      ];
      return h("div", { class: "list-row" }, [input, h("div", { class: "list-row-controls" }, controls)]);
    });
    const addBtn = h("button", { class: "btn btn-sm add-row-btn", type: "button", onClick: () => onChange(arr.concat([""])) }, "＋ 追加");
    return h("div", null, [h("div", { class: "list-rows" }, rows), addBtn]);
  }

  // ---- オブジェクト配列（折りたたみカード） ----
  function cardTitleFor(item) {
    const titleKeys = (state.schema && state.schema.titleKeys) || ["label", "name", "title", "q", "h", "k", "no"];
    for (const key of titleKeys) {
      if (item && typeof item[key] === "string" && item[key].trim()) return item[key];
    }
    return "";
  }

  function renderListObj(path, arr, onChange) {
    const cards = arr.map((item, idx) => {
      const cardKey = path + "#" + idx;
      const open = Boolean(state.openCards[cardKey]);
      const title = cardTitleFor(item);
      const no = item && item.no != null ? String(item.no) : String(idx + 1);

      const fieldEls = [];
      if (item && typeof item === "object") {
        for (const [subKey, subVal] of Object.entries(item)) {
          fieldEls.push(renderObjSubField(path, arr, idx, subKey, subVal, onChange));
        }
      }

      const controls = [
        h(
          "button",
          {
            class: "btn btn-icon btn-ghost",
            disabled: idx === 0,
            title: "上へ",
            type: "button",
            onClick: (e) => {
              e.stopPropagation();
              const copy = arr.map((x) => x);
              [copy[idx - 1], copy[idx]] = [copy[idx], copy[idx - 1]];
              onChange(copy);
            },
          },
          "↑"
        ),
        h(
          "button",
          {
            class: "btn btn-icon btn-ghost",
            disabled: idx === arr.length - 1,
            title: "下へ",
            type: "button",
            onClick: (e) => {
              e.stopPropagation();
              const copy = arr.map((x) => x);
              [copy[idx + 1], copy[idx]] = [copy[idx], copy[idx + 1]];
              onChange(copy);
            },
          },
          "↓"
        ),
        h(
          "button",
          {
            class: "btn btn-icon btn-ghost",
            title: "複製",
            type: "button",
            onClick: (e) => {
              e.stopPropagation();
              const copy = arr.slice();
              copy.splice(idx + 1, 0, deepClone(item));
              onChange(copy);
            },
          },
          "⧉"
        ),
        h(
          "button",
          {
            class: "btn btn-icon btn-ghost",
            title: "削除",
            type: "button",
            onClick: (e) => {
              e.stopPropagation();
              if (!confirm("「" + (title || "（未入力）") + "」を削除します。この操作は取り消せません（未保存なら「変更を取り消す」で戻せます）。よろしいですか？")) return;
              const copy = arr.slice();
              copy.splice(idx, 1);
              onChange(copy);
            },
          },
          "×"
        ),
      ];

      const head = h(
        "div",
        {
          class: "obj-card-head",
          onClick: () => {
            state.openCards[cardKey] = !open;
            render();
          },
        },
        [
          h("div", { class: "obj-card-title" }, [h("b", null, "#" + no), h("span", null, title || "（未入力）")]),
          h("div", { class: "obj-card-controls" }, controls),
          h("span", { class: "obj-card-chevron" }),
        ]
      );

      return h("div", { class: "obj-card" + (open ? " open" : "") }, [head, h("div", { class: "obj-card-body" }, fieldEls)]);
    });

    const addBtn = h(
      "button",
      {
        class: "btn btn-sm add-card-btn",
        type: "button",
        onClick: () => {
          const tpl = (state.schema.templates || {})[path.replace(/\.\d+\./g, ".")];
          const template = tpl ? deepClone(tpl) : arr.length ? deepClone(arr[0]) : {};
          if (tpl) {
            const copy0 = arr.concat([template]);
            onChange(copy0);
            state.openCards[path + "#" + (copy0.length - 1)] = true;
            return;
          }
          for (const k of Object.keys(template)) {
            template[k] = typeof template[k] === "string" ? "" : Array.isArray(template[k]) ? [] : typeof template[k] === "number" ? 0 : template[k];
          }
          const copy = arr.concat([template]);
          onChange(copy);
          state.openCards[path + "#" + (copy.length - 1)] = true;
        },
      },
      "＋ 末尾に追加"
    );

    return h("div", null, [h("div", { class: "obj-cards" }, cards), addBtn]);
  }

  const SUBFIELD_LABELS = {
    label: "表示名",
    link: "リンク先（例：index / services / about / contact / privacy / #flow / https://…）",
    q: "質問",
    a: "回答",
    k: "項目名",
    v: "内容",
    h: "見出し",
    b: "本文",
    title: "見出し",
    body: "本文",
    name: "名称",
    lead: "リード文",
    date: "日付（例：2026-04-01）",
    category: "カテゴリー（例：会社 / サービス / 採用）",
    items: "サービス項目",
    img: "写真",
  };

  // 選択式にする項目（パスは番号を除いた形）
  const SUBFIELD_OPTIONS = {
    "footer.columns.auto": [
      { v: "", l: "手入力（下のリンク一覧を使います）" },
      { v: "services", l: "事業内容を自動表示" },
      { v: "posts", l: "お知らせの新しい5件を自動表示" },
    ],
  };

  /** "footer.columns.0.items" -> "footer.columns.items"（番号を除いた形） */
  function genericPath(path) {
    return String(path || "")
      .split(".")
      .filter((seg) => !/^\d+$/.test(seg))
      .join(".");
  }

  function subFieldLabel(path, subKey) {
    const item = (state.schema && state.schema.itemLabels) || {};
    const key = genericPath(path) + "." + subKey;
    if (item[key]) return item[key];
    return SUBFIELD_LABELS[subKey] || subKey;
  }

  function renderObjSubField(path, arr, idx, subKey, value, onChange) {
    const advanced = subKey === "id" || subKey === "no";
    const label = subFieldLabel(path, subKey);
    const options = SUBFIELD_OPTIONS[genericPath(path) + "." + subKey];

    const update = (val) => {
      const copy = arr.map((x) => x);
      copy[idx] = { ...copy[idx], [subKey]: val };
      onChange(copy);
    };

    let control;
    if (options) {
      control = h(
        "select",
        { onChange: (e) => update(e.target.value) },
        options.map((o) =>
          h("option", { value: o.v, selected: String(value || "") === o.v }, o.l)
        )
      );
    } else if (isImageKey(subKey)) {
      control = renderImageControl(value, (val) => update(val));
    } else if (Array.isArray(value)) {
      const isObjArr = value.length > 0
        ? typeof value[0] === "object" && value[0] !== null && !Array.isArray(value[0])
        : guessArrayIsObjFromSchema(genericPath(path + "." + idx + "." + subKey));
      control = isObjArr
        ? h("div", null, [renderListObj(path + "." + idx + "." + subKey, value, (newArr) => update(newArr))])
        : h("div", null, [renderListText(value, (newArr) => update(newArr))]);
    } else if (typeof value === "number") {
      control = h("input", { type: "text", value: advanced ? String(value) : String(value), onInput: (e) => update(e.target.value) });
    } else if (typeof value === "string" && (value.length > 48 || value.includes("\n"))) {
      control = h("textarea", {
        "data-autogrow": "1",
        value: value || "",
        onInput: (e) => {
          update(e.target.value);
          autoGrow(e.target);
        },
      });
    } else {
      control = h("input", { type: "text", value: value == null ? "" : String(value), onInput: (e) => update(e.target.value) });
    }

    const labelRow = h("label", { class: advanced ? "field-label--adv" : "" }, [
      advanced ? "上級者向け：" + label : label,
      typeof value === "string" && value.trim() && !options && subKey !== "link" && subKey !== "date" && subKey !== "slug" && !isImageKey(subKey)
        ? h("button", { type: "button", class: "trans-btn", style: "margin-left:8px", onClick: (e) => (e.preventDefault(), openTransPanel(value)) }, "訳文")
        : null,
    ]);

    return h("div", { class: "obj-card-field", "data-path": path + "." + idx + "." + subKey }, [labelRow, control]);
  }

  // ============================================================ 訳文パネル

  function openTransPanel(jaText) {
    const ja = String(jaText == null ? "" : jaText).trim();
    if (!ja) return;
    state.transPanel = { ja };
    render();
  }

  function closeTransPanel() {
    state.transPanel = null;
    render();
  }

  function renderTransOverlay() {
    return h("div", { class: "trans-overlay", onClick: closeTransPanel });
  }

  function renderTransPanel() {
    const ja = state.transPanel.ja;
    const entry = state.i18nByJa ? state.i18nByJa.get(ja) : null;
    const langs = translatableLangs();

    let body;
    if (!entry) {
      const hasJa = /[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff]/.test(ja);
      body = h("div", { class: "trans-note" }, [
        h("span", null, hasJa ? "この文はまだ翻訳ライブラリにありません。" : "英字・数字だけの文なので、翻訳せずそのまま表示されます。"),
        hasJa ? h("span", { class: "trans-note-sub" }, "「保存して公開」を押すと自動翻訳が作られます。") : null,
      ]);
    } else {
      const key = entry.__key;
      body = h(
        "div",
        null,
        langs.map((lang) => {
          const edited = i18nEditValue(key, lang);
          const isReset = edited === null;
          const value = isReset ? "" : edited !== undefined ? edited : entry[lang] || "";
          const confirmed = isConfirmed(entry, lang) && !isReset;
          const changed = edited !== undefined;

          const onInput = (e) => {
            setI18nEdit(key, lang, e.target.value);
            if (e.target.tagName === "TEXTAREA") autoGrow(e.target);
            const row = e.target.closest(".trans-row");
            const marks = row && row.querySelector(".trans-row-head");
            if (marks) {
              const already = marks.querySelector(".trans-badge--edit");
              const nowEdited = i18nEditValue(key, lang) !== undefined;
              if (nowEdited && !already) marks.appendChild(h("span", { class: "trans-badge trans-badge--edit" }, "手直しあり"));
              if (!nowEdited && already) already.remove();
            }
            updateSaveBar();
          };

          const isLong = value.length > 48;
          const control = isLong
            ? h("textarea", { "data-autogrow": "1", value: value, onInput: onInput })
            : h("input", { type: "text", value: value, onInput: onInput });

          const marks = [h("span", { class: "trans-row-lang" }, langLabel(lang))];
          if (confirmed) marks.push(h("span", { class: "trans-badge trans-badge--ok" }, "人工確認済み"));
          else if (value) marks.push(h("span", { class: "trans-badge" }, "自動翻訳"));
          if (changed) marks.push(h("span", { class: "trans-badge trans-badge--edit" }, isReset ? "再翻訳します" : "手直しあり"));

          return h("div", { class: "trans-row" }, [
            h("div", { class: "trans-row-head" }, marks),
            control,
            h(
              "button",
              {
                type: "button",
                class: "trans-retrans",
                onClick: () => {
                  setI18nEdit(key, lang, null);
                  render();
                  // 再オープン
                  const rebuilt = document.querySelector(".trans-panel");
                  if (rebuilt) rebuilt.classList.add("open");
                },
              },
              "日本語から作り直す"
            ),
          ]);
        })
      );
    }

    const panel = h("div", { class: "trans-panel" }, [
      h("div", { class: "trans-panel-head" }, [h("h2", null, "訳文の編集"), h("button", { class: "btn btn-icon btn-ghost", type: "button", onClick: closeTransPanel }, "×")]),
      h("div", { class: "trans-panel-body" }, [
        h("div", { class: "trans-panel-source-label" }, "日本語（原文）"),
        h("div", { class: "trans-panel-source" }, ja),
        body,
      ]),
      h("div", { class: "trans-panel-foot" }, "手で直した訳文は「人工確認済み」になり、以後は自動翻訳で上書きされません。文章そのものの追加・削除は各グループの入力欄で行ってください。"),
    ]);

    requestAnimationFrame(() => panel.classList.add("open"));
    return panel;
  }

  // ============================================================ 描画：下部バー

  function renderSaveBar() {
    const total = countDirtyTotal();
    return h("div", { class: "savebar" }, [
      h("span", { class: "savebar-status" + (total > 0 ? " has-changes" : "") }, total > 0 ? `未保存の変更 ${total}件` : "未保存の変更はありません"),
      h("span", { class: "savebar-spacer" }),
      h(
        "button",
        {
          class: "btn",
          type: "button",
          disabled: total === 0,
          onClick: () => {
            state.modal = "diff";
            render();
          },
        },
        "変更を取り消す・確認する"
      ),
      h(
        "button",
        {
          class: "btn btn-primary",
          type: "button",
          disabled: total === 0 || state.saving,
          onClick: () => {
            state.modal = "diff";
            render();
          },
        },
        state.saving ? "保存中…" : "保存して公開"
      ),
    ]);
  }

  // ============================================================ 描画：モーダル

  let commitMessageDraft = "";

  function renderDiffModal() {
    const list = computeDiffList();
    return h("div", { class: "modal-overlay", onClick: (e) => e.target === e.currentTarget && closeModal() }, [
      h("div", { class: "modal" }, [
        h("div", { class: "modal-head" }, [h("h2", null, "変更内容の確認"), h("button", { class: "btn btn-icon btn-ghost", type: "button", onClick: closeModal }, "×")]),
        h("div", { class: "modal-body" }, [
          list.length
            ? h(
                "div",
                null,
                list.map((d) =>
                  h("div", { class: "diff-item" }, [
                    h("div", { class: "diff-item-label" }, d.label),
                    h("div", { class: "diff-vals" }, [
                      h("div", null, [h("div", { class: "diff-arrow-label" }, "変更前"), h("div", { class: "diff-before" }, d.before || "（空）")]),
                      h("div", null, [h("div", { class: "diff-arrow-label" }, "変更後"), h("div", { class: "diff-after" }, d.after || "（空）")]),
                    ]),
                  ])
                )
              )
            : null,
          hasI18nEdits()
            ? h("div", { class: "diff-item" }, [h("div", { class: "diff-item-label" }, "訳文の手直し"), h("div", { class: "modal-note" }, Object.keys(state.i18nEdits).length + " 件の訳文を手直ししました。")])
            : null,
          !list.length && !hasI18nEdits() ? h("div", { class: "empty-state" }, "変更はありません。") : null,
          h("div", { class: "modal-field", style: "margin-top:18px" }, [
            h("label", { for: "commitMsg" }, "この変更のメモ（あとで見返すときの目印。省略できます）"),
            h("input", {
              type: "text",
              id: "commitMsg",
              placeholder: "例：トップページの見出しを直した",
              value: commitMessageDraft,
              onInput: (e) => (commitMessageDraft = e.target.value),
            }),
          ]),
        ]),
        h("div", { class: "modal-foot" }, [
          h("button", { class: "btn", type: "button", onClick: closeModal }, "閉じる"),
          h(
            "button",
            {
              class: "btn btn-primary",
              type: "button",
              disabled: (list.length === 0 && !hasI18nEdits()) || state.saving,
              onClick: () => {
                const msg = commitMessageDraft.trim() || "管理画面から更新（" + groupNameById(state.currentGroup) + "）";
                doSave(msg);
              },
            },
            state.saving ? "保存しています…" : "この内容で保存して公開"
          ),
        ]),
      ]),
    ]);
  }

  function renderConflictModal() {
    return h("div", { class: "modal-overlay" }, [
      h("div", { class: "modal", style: "max-width:420px" }, [
        h("div", { class: "modal-head" }, [h("h2", null, "保存できませんでした")]),
        h("div", { class: "modal-body" }, [h("p", { class: "modal-note" }, "ほかの方が先に保存しました。お手数ですが、画面を再読み込みしてから、もう一度編集してください。")]),
        h("div", { class: "modal-foot" }, [h("button", { class: "btn btn-primary", type: "button", onClick: () => location.reload() }, "再読み込み")]),
      ]),
    ]);
  }

  function closeModal() {
    state.modal = null;
    state.picker = null;
    render();
  }

  // ============================================================ 描画：トースト

  function renderToasts() {
    return h(
      "div",
      { class: "toast-wrap" },
      state.toasts.map((t) => h("div", { class: "toast" + (t.kind === "ok" ? " toast-ok" : t.kind === "error" ? " toast-error" : "") }, t.message))
    );
  }

  // ============================================================ 画像：変換とアップロード

  const IMG_VARIANTS = [
    { suffix: "", maxSide: 1920, quality: 0.82, key: "full" },
    { suffix: "-sm", maxSide: 900, quality: 0.78, key: "sm" },
  ];
  const IMG_NAME_OK = /^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]$/;

  function suggestImageName(fileName) {
    let base = String(fileName).replace(/\.[^.]+$/, "");
    base = base
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/-{2,}/g, "-")
      .replace(/-sm$/, "-sm2")
      .slice(0, 60);
    return IMG_NAME_OK.test(base) ? base : "";
  }

  const blobToB64 = (blob) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
      reader.onerror = () => reject(new Error("read failed"));
      reader.readAsDataURL(blob);
    });

  function canvasToWebp(canvas, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => (blob && blob.type === "image/webp" ? resolve(blob) : reject(new Error("webp_unsupported"))), "image/webp", quality);
    });
  }

  async function convertImage(file) {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const out = { width: bitmap.width, height: bitmap.height, originalBytes: file.size };
    try {
      for (const v of IMG_VARIANTS) {
        const scale = Math.min(1, v.maxSide / Math.max(bitmap.width, bitmap.height));
        const w = Math.max(1, Math.round(bitmap.width * scale));
        const hh = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = hh;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, w, hh);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(bitmap, 0, 0, w, hh);
        const blob = await canvasToWebp(canvas, v.quality);
        out[v.key] = await blobToB64(blob);
        out[v.key + "Bytes"] = blob.size;
        if (v.key === "sm") out.previewUrl = URL.createObjectURL(blob);
      }
    } finally {
      if (bitmap.close) bitmap.close();
    }
    return out;
  }

  const fmtKB = (n) => (n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + " MB" : Math.round(n / 1024) + " KB");

  async function addFilesToQueue(fileList, forcedName) {
    const files = [...fileList].filter((f) => /^image\//.test(f.type));
    const skipped = [...fileList].length - files.length;
    if (skipped > 0) pushToast(`画像でないファイル ${skipped} 件は除きました。`, "error");
    if (!files.length) return;

    for (const file of files) {
      const base = forcedName || suggestImageName(file.name);
      const entry = { id: `u${state.upload.seq++}`, fileName: file.name, name: base, status: "converting", error: null, forced: Boolean(forcedName) };
      state.upload.queue.push(entry);
      render();

      try {
        const conv = await convertImage(file);
        Object.assign(entry, conv, { status: "ready" });
      } catch (e) {
        entry.status = "error";
        entry.error =
          String(e).indexOf("webp_unsupported") >= 0
            ? "このブラウザは画像変換に対応していません。最新の Chrome / Edge / Safari をお使いください。"
            : "画像を読み込めませんでした。ファイルが壊れていないかご確認ください。";
      }
      render();
    }
  }

  function removeFromQueue(id) {
    const i = state.upload.queue.findIndex((q) => q.id === id);
    if (i < 0) return;
    const entry = state.upload.queue[i];
    if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
    state.upload.queue.splice(i, 1);
    render();
  }

  function clearQueue() {
    for (const q of state.upload.queue) if (q.previewUrl) URL.revokeObjectURL(q.previewUrl);
    state.upload.queue = [];
  }

  function validateQueue() {
    const problems = [];
    const seen = new Map();
    for (const q of state.upload.queue) {
      if (q.status === "error") continue;
      if (!q.name) {
        problems.push({ id: q.id, message: "画像ファイル名を確認してください。" });
        continue;
      }
      if (!IMG_NAME_OK.test(q.name)) {
        problems.push({ id: q.id, message: "半角小文字・数字・ハイフンのみ、2〜60文字にしてください。" });
        continue;
      }
      if (q.name.endsWith("-sm")) {
        problems.push({ id: q.id, message: "末尾の -sm は自動で作られるため使えません。" });
        continue;
      }
      if (seen.has(q.name)) {
        problems.push({ id: q.id, message: "同じファイル名が重複しています。" });
        continue;
      }
      seen.set(q.name, true);
    }
    return problems;
  }

  async function submitUpload() {
    if (state.upload.busy) return;
    const problems = validateQueue();
    state.upload.problems = {};
    for (const p of problems) state.upload.problems[p.id] = p.message;
    if (problems.length) {
      render();
      pushToast("画像のファイル名をご確認ください。", "error");
      return;
    }
    const ready = state.upload.queue.filter((q) => q.status === "ready");
    if (!ready.length) {
      pushToast("アップロードできる画像がありません。", "error");
      return;
    }
    state.upload.busy = true;
    render();
    try {
      const res = await api("/upload", { method: "POST", body: JSON.stringify({ items: ready.map((q) => ({ name: q.name, full: q.full, sm: q.sm })) }) });
      if (!res.data || !res.data.ok) {
        const d = res.data || {};
        pushToast(d.hint || (d.error === "conflict" ? "ほかの方が先に保存しました。画面を再読み込みしてください。" : "アップロードできませんでした。"), "error");
        state.upload.busy = false;
        render();
        return;
      }
      const names = res.data.names || [];
      const merged = new Set([...state.images, ...names]);
      state.images = [...merged].sort();
      clearQueue();
      state.upload.busy = false;
      state.upload.justUploaded = names;
      pushToast(`${names.length}枚を差し替えました。公開まで数分かかります。`, "ok");
      render();
      startStatusPolling();
    } catch (e) {
      state.upload.busy = false;
      pushToast("サーバーに接続できませんでした。", "error");
      render();
    }
  }

  // ============================================================ 画像ライブラリ

  /** その項目が「写真を選ぶ欄」かどうか */
  function isImageKey(path) {
    const last = String(path || "").split(".").pop();
    return last === "img" || last === "hero_img" || last === "og_img" || /_img$/.test(last);
  }

  /** 画像が使われている場所を洗い出す（削除前の確認に使う） */
  function groupLabelForKey(key) {
    const g = (state.schema.groups || []).find((x) => x.key === key);
    return g ? g.name : key;
  }

  function imageUsage() {
    const used = {};
    const walk = (obj, trail) => {
      if (obj == null) return;
      if (Array.isArray(obj)) {
        obj.forEach((v, i) => walk(v, trail.concat(["#" + (i + 1)])));
        return;
      }
      if (typeof obj !== "object") return;
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === "string" && isImageKey(k) && v.trim()) {
          const top = groupLabelForKey(trail[0] || k);
          const idx = trail.find((t) => t.startsWith("#"));
          const title = obj.title || obj.name || "";
          const where = top + (title ? "：" + title : idx ? " " + idx : "");
          (used[v.trim()] = used[v.trim()] || []).push(where);
        } else {
          walk(v, trail.concat([k]));
        }
      }
    };
    walk(state.draft["data/site.json"] || {}, []);
    return used;
  }

  /** 画像が差し替わったときに古いキャッシュを見せないための版番号 */
  function imgVer(name) {
    const m = (state.imageMeta && state.imageMeta[name]) || null;
    if (m && m.bytes) return String(m.bytes);
    return String(state.head || "").slice(0, 8) || "1";
  }

  function thumbUrl(name) {
    return "/assets/img/" + name + "-sm.webp?v=" + imgVer(name);
  }

  function fullUrl(name) {
    return "/assets/img/" + name + ".webp?v=" + imgVer(name);
  }

  /** 写真を選ぶ欄（サムネイル＋選び直し） */
  function renderImageControl(value, onChange) {
    const name = String(value || "").trim();
    const known = state.images.includes(name);
    const thumb = name
      ? known
        ? h("img", { class: "imgpick-thumb", src: thumbUrl(name), alt: "", loading: "lazy", onError: (e) => { const el = e.target; if (!el.dataset.fb) { el.dataset.fb = "1"; el.src = fullUrl(name); } } })
        : h("div", { class: "imgpick-thumb imgpick-thumb-missing" }, "見つかりません")
      : h("div", { class: "imgpick-thumb imgpick-thumb-empty" }, "写真なし");

    return h("div", { class: "imgpick" }, [
      thumb,
      h("div", { class: "imgpick-body" }, [
        h("div", { class: "imgpick-name" }, name ? name + ".webp" : "（設定されていません）"),
        h("div", { class: "imgpick-btns" }, [
          h(
            "button",
            { class: "btn btn-sm", type: "button", onClick: () => openPicker(name, (picked) => onChange(picked)) },
            name ? "写真を選び直す" : "写真を選ぶ"
          ),
          name ? h("button", { class: "btn btn-ghost btn-sm", type: "button", onClick: () => onChange("") }, "写真を外す") : null,
        ]),
      ]),
    ]);
  }

  function openPicker(current, cb) {
    state.picker = { current: current || "", cb: cb, q: "" };
    state.modal = "picker";
    render();
  }

  function renderPickerModal() {
    const p = state.picker || { current: "", cb: () => {} };
    const q = (p.q || "").trim().toLowerCase();
    const list = state.images.filter((n) => !q || n.includes(q));

    const pick = (name) => {
      const cb = p.cb;
      state.modal = null;
      state.picker = null;
      cb(name);
    };

    const cells = list.map((n) =>
      h(
        "button",
        {
          class: "pick-cell" + (n === p.current ? " is-current" : ""),
          type: "button",
          onClick: () => pick(n),
        },
        [h("img", { src: thumbUrl(n), alt: "", loading: "lazy", onError: (e) => { const el = e.target; if (!el.dataset.fb) { el.dataset.fb = "1"; el.src = fullUrl(n); } } }), h("span", { class: "pick-name" }, n)]
      )
    );

    const fileId = "pickerUpload";
    return h("div", { class: "modal-overlay", onClick: (e) => e.target === e.currentTarget && closeModal() }, [
      h("div", { class: "modal modal-wide" }, [
        h("div", { class: "modal-head" }, [
          h("h2", null, "写真を選ぶ"),
          h("button", { class: "btn btn-icon btn-ghost", type: "button", onClick: closeModal }, "×"),
        ]),
        h("div", { class: "modal-body" }, [
          h("div", { class: "pick-toolbar" }, [
            h("input", {
              type: "text",
              placeholder: "名前でしぼり込む",
              value: p.q || "",
              onInput: (e) => {
                state.picker.q = e.target.value;
                render();
              },
            }),
            h("input", {
              type: "file",
              accept: "image/*",
              multiple: true,
              id: fileId,
              style: "display:none",
              onChange: (e) => {
                if (e.target.files && e.target.files.length) addFilesToQueue(e.target.files);
                e.target.value = "";
                state.modal = null;
                state.picker = null;
                state.currentGroup = "__images__";
                render();
              },
            }),
            h(
              "button",
              { class: "btn btn-sm", type: "button", onClick: () => document.getElementById(fileId).click() },
              "パソコンから写真を追加する"
            ),
          ]),
          list.length ? h("div", { class: "pick-grid" }, cells) : h("div", { class: "empty-state" }, "写真がありません。上のボタンから追加してください。"),
        ]),
        h("div", { class: "modal-foot" }, [
          h("button", { class: "btn btn-ghost", type: "button", onClick: () => pick("") }, "写真を使わない"),
          h("button", { class: "btn", type: "button", onClick: closeModal }, "閉じる"),
        ]),
      ]),
    ]);
  }

  /** 画像の削除 */
  async function deleteImages(names) {
    if (!names.length) return;
    state.upload.busy = true;
    render();
    try {
      const res = await api("/images/delete", { method: "POST", body: JSON.stringify({ names }) });
      if (!res.data || !res.data.ok) {
        pushToast((res.data && res.data.hint) || "削除できませんでした。", "error");
      } else {
        state.images = state.images.filter((n) => !names.includes(n));
        pushToast(names.length + "枚を削除しました。公開まで数分かかります。", "ok");
        startStatusPolling();
      }
    } catch (e) {
      pushToast("サーバーに接続できませんでした。", "error");
    }
    state.upload.busy = false;
    render();
  }

  // ------------------------------------------------------------ 画像ページ

  function renderImagesPage() {
    const q = state.upload;
    const usage = imageUsage();
    const sel = state.imgSel || (state.imgSel = {});

    const fileId = "libUpload";
    const fileInput = h("input", {
      type: "file",
      accept: "image/*",
      multiple: true,
      id: fileId,
      style: "display:none",
      onChange: (e) => {
        if (e.target.files && e.target.files.length) addFilesToQueue(e.target.files);
        e.target.value = "";
      },
    });

    const dropZone = h(
      "div",
      {
        class: "drop-zone" + (state.dragOver ? " is-over" : ""),
        onDragOver: (e) => {
          e.preventDefault();
          if (!state.dragOver) {
            state.dragOver = true;
            render();
          }
        },
        onDragLeave: () => {
          state.dragOver = false;
          render();
        },
        onDrop: (e) => {
          e.preventDefault();
          state.dragOver = false;
          if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) addFilesToQueue(e.dataTransfer.files);
          render();
        },
      },
      [
        h("p", { class: "drop-title" }, "ここに写真をドラッグしてください"),
        h("p", { class: "drop-note" }, "JPEG・PNG・HEIC などをそのまま入れられます。パソコン用（長辺1920px）とスマートフォン用（長辺900px）の2種類が自動で作られます。"),
        fileInput,
        h("button", { class: "btn", type: "button", disabled: q.busy, onClick: () => document.getElementById(fileId).click() }, "パソコンから選ぶ"),
      ]
    );

    const selected = Object.keys(sel).filter((k) => sel[k]);
    const cells = state.images.map((n) => {
      const where = usage[n] || [];
      const checked = !!sel[n];
      return h("div", { class: "lib-cell" + (checked ? " is-sel" : "") + (q.justUploaded.includes(n) ? " lib-cell-new" : "") }, [
        h("label", { class: "lib-thumb" }, [
          h("input", {
            type: "checkbox",
            checked: checked,
            onChange: (e) => {
              sel[n] = e.target.checked;
              render();
            },
          }),
          h("img", { src: thumbUrl(n), alt: "", loading: "lazy", onError: (e) => { const el = e.target; if (!el.dataset.fb) { el.dataset.fb = "1"; el.src = fullUrl(n); } } }),
        ]),
        h("div", { class: "lib-name" }, n + ".webp"),
        where.length
          ? h("div", { class: "lib-use" }, where.map((w) => h("span", { class: "lib-tag" }, w)))
          : h("div", { class: "lib-use lib-use-none" }, "どこにも使われていません"),
        h("div", { class: "lib-btns" }, [
          h(
            "button",
            {
              class: "btn btn-ghost btn-sm",
              type: "button",
              disabled: q.busy,
              onClick: () => {
                const id = "swap_" + n.replace(/[^a-z0-9]/g, "_");
                let el = document.getElementById(id);
                if (!el) {
                  el = document.createElement("input");
                  el.type = "file";
                  el.accept = "image/*";
                  el.id = id;
                  el.style.display = "none";
                  el.addEventListener("change", (e) => {
                    if (e.target.files && e.target.files.length) addFilesToQueue(e.target.files, n);
                    e.target.value = "";
                    render();
                  });
                  document.body.appendChild(el);
                }
                el.click();
              },
            },
            "同じ名前で差し替える"
          ),
        ]),
      ]);
    });

    const bulkBar = selected.length
      ? h("div", { class: "lib-bulk" }, [
          h("span", null, selected.length + "枚を選択中"),
          h(
            "button",
            {
              class: "btn btn-danger btn-sm",
              type: "button",
              disabled: q.busy,
              onClick: () => {
                const inUse = selected.filter((n) => (usage[n] || []).length);
                const warn = inUse.length ? "\n\nこのうち " + inUse.length + "枚はページで使われています。削除するとその場所の写真が消えます。" : "";
                if (!confirm(selected.length + "枚の写真を削除します。元に戻せません。" + warn)) return;
                state.imgSel = {};
                deleteImages(selected);
              },
            },
            "選んだ写真を削除する"
          ),
          h("button", { class: "btn btn-ghost btn-sm", type: "button", onClick: () => ((state.imgSel = {}), render()) }, "選択をやめる"),
        ])
      : null;

    const queueRows = q.queue.map((entry) =>
      h("div", { class: "up-row" + (entry.status === "error" || q.problems[entry.id] ? " up-row-err" : "") }, [
        entry.previewUrl
          ? h("img", { class: "up-thumb", src: entry.previewUrl, alt: "" })
          : h("div", { class: "up-thumb up-thumb-empty" }, entry.status === "converting" ? h("span", { class: "spin" }, "⟳") : "—"),
        h("div", { class: "up-body" }, [
          h("div", { class: "up-file" }, entry.fileName + " → " + entry.name + ".webp"),
          entry.status === "error" ? h("div", { class: "up-err" }, entry.error) : null,
          q.problems[entry.id] ? h("div", { class: "up-err" }, q.problems[entry.id]) : null,
          entry.status === "ready"
            ? h("div", { class: "up-meta" }, [
                `${entry.width}×${entry.height}px`,
                h("span", { class: "up-sep" }, "・"),
                `元 ${fmtKB(entry.originalBytes)} → ${fmtKB(entry.fullBytes)} + ${fmtKB(entry.smBytes)}`,
              ])
            : null,
        ]),
        h("button", { class: "btn btn-ghost btn-sm", type: "button", onClick: () => removeFromQueue(entry.id) }, "取り消す"),
      ])
    );

    const readyCount = q.queue.filter((x) => x.status === "ready").length;
    const queuePanel = q.queue.length
      ? h("div", { class: "card" }, [
          h("div", { class: "card-head" }, [h("h3", null, `差し替える写真（${readyCount}枚）`)]),
          h("div", { class: "up-list" }, queueRows),
          h("div", { class: "up-foot" }, [
            h(
              "button",
              { class: "btn btn-primary", type: "button", disabled: q.busy || !readyCount, onClick: submitUpload },
              q.busy ? "アップロードしています…" : `${readyCount}枚を保存して公開`
            ),
            h("button", { class: "btn btn-ghost", type: "button", disabled: q.busy, onClick: () => (clearQueue(), render()) }, "すべて取り消す"),
          ]),
        ])
      : null;

    return h("main", { class: "main" }, [
      h("div", { class: "main-inner" }, [
        h("div", { class: "group-head" }, [
          h("h1", null, "写真"),
          h("p", null, "サイトで使う写真をここでまとめて管理します。追加した写真は、各ページの「写真を選ぶ」から呼び出せます。"),
        ]),
        dropZone,
        queuePanel,
        h("div", { class: "lib-head" }, [h("h2", null, "写真ライブラリ（" + state.images.length + "枚）"), bulkBar]),
        state.images.length ? h("div", { class: "lib-grid" }, cells) : h("div", { class: "empty-state" }, "まだ写真がありません。"),
      ]),
    ]);
  }

  // ============================================================ 起動

  boot();
})();
