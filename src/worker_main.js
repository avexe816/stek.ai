
// ------------------------------------------------------------------ ルーティング

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 管理画面 API
    if (url.pathname === "/api/admin" || url.pathname.startsWith("/api/admin/")) {
      return handleAdmin(request, env, url);
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
