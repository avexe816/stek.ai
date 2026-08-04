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
