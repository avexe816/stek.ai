
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

    // 公開停止した言語（簡体字・繁体字・韓国語）は日本語版へ恒久リダイレクト
    const gone = url.pathname.match(/^\/(zh|zh-hant|ko)(\/.*)?$/);
    if (gone) {
      const rest = (gone[2] || "/").replace(/^\/+/, "");
      return Response.redirect(new URL("/" + rest, url).toString(), 301);
    }

    return env.ASSETS.fetch(request);
  },
};
