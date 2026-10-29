/// <reference types="@cloudflare/workers-types" />

export interface Env {
  DB: D1Database;
  BOT_TOKEN: string;      // secret
  WEBHOOK_SECRET: string; // secret
  ADMIN_IDS: string;      // "12345,67890"
}

type Row = [string, string][];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ───────────── Telegram helpers ───────────── */

async function tg(env: Env, method: string, body: Record<string, unknown>): Promise<any> {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

const kb = (rows: Row[]) => ({
  inline_keyboard: rows.map((r) => r.map(([text, data]) => ({ text, callback_data: data }))),
});

async function show(env: Env, chatId: number, msgId: number | null, text: string, rows: Row[]) {
  const reply_markup = kb(rows);
  if (msgId) {
    const res = await tg(env, "editMessageText", { chat_id: chatId, message_id: msgId, text, reply_markup });
    if (res.ok || String(res.description).includes("not modified")) return;
  }
  await tg(env, "sendMessage", { chat_id: chatId, text, reply_markup });
}

/* ───────────── DB helpers ───────────── */

async function getSetting(env: Env, key: string, def = ""): Promise<string> {
  const r = await env.DB.prepare("SELECT value FROM settings WHERE key=?").bind(key).first<{ value: string }>();
  return r?.value ?? def;
}
async function setSetting(env: Env, key: string, value: string) {
  await env.DB.prepare(
    "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).bind(key, value).run();
}

async function stats(env: Env) {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) total,
            COALESCE(SUM(status='sent'),0) sent,
            COALESCE(SUM(status='pending'),0) pending,
            COALESCE(SUM(status='failed'),0) failed
     FROM files`
  ).first<{ total: number; sent: number; pending: number; failed: number }>();
  return r ?? { total: 0, sent: 0, pending: 0, failed: 0 };
}

const STATE_LABEL: Record<string, string> = {
  idle: "⚪️ آماده",
  running: "🟢 در حال ارسال",
  paused: "🟡 متوقف‌شده",
  cancelled: "🔴 لغو‌شده",
};

const bar = (p: number) => "█".repeat(Math.round(p / 10)) + "░".repeat(10 - Math.round(p / 10));

function fmtDur(sec: number) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return h ? `${h} ساعت و ${m} دقیقه` : m ? `${m} دقیقه و ${s} ثانیه` : `${s} ثانیه`;
}

/* ───────────── Screens ───────────── */

async function mainScreen(env: Env) {
  const s = await stats(env);
  const state = await getSetting(env, "state", "idle");
  return {
    text:
      `🤖 پنل مدیریت ربات\n\n` +
      `📦 کل فایل‌ها: ${s.total}\n✅ ارسال‌شده: ${s.sent}\n⏳ باقی‌مانده: ${s.pending}` +
      (s.failed ? `\n⚠️ ناموفق: ${s.failed}` : "") +
      `\nوضعیت: ${STATE_LABEL[state] ?? state}`,
    rows: [
      [["📦 مدیریت آرشیو", "a:menu"]],
      [["⏱️ تنظیمات ارسال", "s:menu"]],
      [["🎮 کنترل ارسال", "c:menu"]],
    ] as Row[],
  };
}

function archiveScreen() {
  return {
    text: "📦 مدیریت آرشیو\n\nفایل‌ها را از آرشیو به همین چت فوروارد کنید (به ترتیب از اولین تا آخرین).",
    rows: [
      [["🔍 بررسی فایل‌ها", "a:check"], ["📋 نمایش فهرست", "a:list:0"]],
      [["🔄 بررسی مجدد", "a:rescan"], ["📢 انتخاب کانال مقصد", "a:chan"]],
      [["🔙 بازگشت", "m:main"]],
    ] as Row[],
  };
}

async function settingsScreen(env: Env) {
  const s = await stats(env);
  const delay = Number(await getSetting(env, "delay", "2"));
  const dest = await getSetting(env, "dest_title", "— انتخاب نشده —");
  return {
    text:
      `⏱️ تنظیمات ارسال\n\n📢 مقصد: ${dest}\n⏱️ تأخیر بین فایل‌ها: ${delay} ثانیه\n\n` +
      `📦 کل: ${s.total}\n✅ ارسال‌شده: ${s.sent}\n⏳ باقی‌مانده: ${s.pending}\n\nتأخیر را انتخاب کنید:`,
    rows: [
      [1, 2, 3, 4, 5].map((n) => [(n === delay ? "✅ " : "") + n, `s:delay:${n}`] as [string, string]),
      [["🔙 بازگشت", "m:main"]],
    ] as Row[],
  };
}

function controlScreen() {
  return {
    text: "🎮 کنترل ارسال",
    rows: [
      [["▶️ شروع ارسال", "c:start"]],
      [["⏸️ توقف موقت", "c:pause"], ["▶️ ادامه ارسال", "c:resume"]],
      [["🛑 لغو عملیات", "c:cancel"]],
      [["🔄 شروع مجدد", "c:restart"], ["📊 وضعیت ارسال", "c:status"]],
      [["🔙 بازگشت", "m:main"]],
    ] as Row[],
  };
}

async function statusScreen(env: Env) {
  const s = await stats(env);
  const state = await getSetting(env, "state", "idle");
  const delay = Number(await getSetting(env, "delay", "2"));
  const pct = s.total ? Math.round((s.sent / s.total) * 100) : 0;
  return {
    text:
      `📊 وضعیت ارسال\n\n${bar(pct)} ${pct}%\n\n` +
      `وضعیت: ${STATE_LABEL[state] ?? state}\n✅ ارسال‌شده: ${s.sent} از ${s.total}\n⏳ باقی‌مانده: ${s.pending}` +
      (s.failed ? `\n⚠️ ناموفق: ${s.failed}` : "") +
      (s.pending ? `\n🕒 زمان تقریبی باقی‌مانده: ${fmtDur(s.pending * (delay + 0.7))}` : ""),
    rows: [[["🔄 تازه‌سازی", "c:status"]], [["🔙 بازگشت", "c:menu"]]] as Row[],
  };
}

async function confirmScreen(env: Env) {
  const s = await stats(env);
  const delay = await getSetting(env, "delay", "2");
  const dest = await getSetting(env, "dest_title", "—");
  return {
    text:
      `✅ تأیید نهایی\n\n📢 مقصد: ${dest}\n⏱️ تأخیر: ${delay} ثانیه\n` +
      `📦 کل: ${s.total}\n✅ ارسال‌شده: ${s.sent}\n⏳ ارسال می‌شود: ${s.pending}\n\nشروع شود؟`,
    rows: [[["✅ تأیید و شروع", "c:go"]], [["❌ بازگشت", "c:menu"]]] as Row[],
  };
}

async function listScreen(env: Env, page: number) {
  const PAGE = 10;
  const s = await stats(env);
  const { results } = await env.DB.prepare(
    "SELECT kind,name,status FROM files ORDER BY message_id LIMIT ? OFFSET ?"
  ).bind(PAGE, page * PAGE).all<{ kind: string; name: string | null; status: string }>();
  const icon: Record<string, string> = { pending: "⏳", sent: "✅", failed: "⚠️" };
  const lines = (results ?? []).map(
    (f, i) => `${page * PAGE + i + 1}. ${icon[f.status] ?? ""} ${f.name || f.kind}`
  );
  const pages = Math.max(1, Math.ceil(s.total / PAGE));
  const nav: [string, string][] = [];
  if (page > 0) nav.push(["◀️ قبلی", `a:list:${page - 1}`]);
  if (page + 1 < pages) nav.push(["بعدی ▶️", `a:list:${page + 1}`]);
  return {
    text: `📋 فهرست فایل‌ها (صفحه ${page + 1} از ${pages})\n\n${lines.join("\n") || "فایلی ثبت نشده."}`,
    rows: [...(nav.length ? [nav] : []), [["🔙 بازگشت", "a:menu"]]] as Row[],
  };
}

/* ───────────── Sender loop ───────────── */

async function notify(env: Env, text: string) {
  const chat = await getSetting(env, "notify_chat");
  if (chat) await tg(env, "sendMessage", { chat_id: Number(chat), text });
}

async function runSender(env: Env, budgetMs: number) {
  const start = Date.now();
  const lock = await env.DB.prepare(
    "UPDATE settings SET value=? WHERE key='lock_until' AND CAST(value AS INTEGER) < ?"
  ).bind(String(start + 20000), start).run();
  if (!lock.meta.changes) return; // another runner is active

  try {
    while (Date.now() - start < budgetMs) {
      if ((await getSetting(env, "state")) !== "running") break;
      const dest = await getSetting(env, "dest_channel");
      const delay = Number(await getSetting(env, "delay", "2"));
      const src = await getSetting(env, "src_chat");

      const f = await env.DB.prepare(
        "SELECT id,message_id FROM files WHERE status='pending' ORDER BY message_id LIMIT 1"
      ).first<{ id: number; message_id: number }>();

      if (!f) {
        await setSetting(env, "state", "idle");
        const s = await stats(env);
        await notify(env, `🏁 ارسال تمام شد.\n✅ ارسال‌شده: ${s.sent}` + (s.failed ? `\n⚠️ ناموفق: ${s.failed}` : ""));
        break;
      }

      const res = await tg(env, "copyMessage", {
        chat_id: Number(dest),
        from_chat_id: Number(src),
        message_id: f.message_id,
      });

      if (res.ok) {
        await env.DB.prepare("UPDATE files SET status='sent', sent_at=datetime('now'), error=NULL WHERE id=?").bind(f.id).run();
      } else if (res.error_code === 429) {
        await sleep(((res.parameters?.retry_after as number) ?? 5) * 1000 + 500);
        continue; // retry same file
      } else {
        const desc = String(res.description ?? "");
        if (res.error_code === 403 || /chat not found|not enough rights|have no rights/i.test(desc)) {
          await setSetting(env, "state", "paused");
          await notify(env, `⚠️ ارسال به کانال مقصد ممکن نیست و صف متوقف شد.\nربات را در کانال ادمین کنید و «ادامه ارسال» بزنید.\n${desc}`);
          break;
        }
        await env.DB.prepare("UPDATE files SET status='failed', error=? WHERE id=?").bind(desc, f.id).run();
      }

      await setSetting(env, "lock_until", String(Date.now() + 20000)); // renew
      await sleep(delay * 1000);
    }
  } finally {
    await setSetting(env, "lock_until", "0");
  }
}

/* ───────────── Ingest (forwarded files) ───────────── */

function extractMedia(m: any): { kind: string; uid: string; name: string | null } | null {
  if (m.document) return { kind: "document", uid: m.document.file_unique_id, name: m.document.file_name ?? null };
  if (m.video) return { kind: "video", uid: m.video.file_unique_id, name: m.video.file_name ?? null };
  if (m.audio) return { kind: "audio", uid: m.audio.file_unique_id, name: m.audio.file_name ?? m.audio.title ?? null };
  if (m.voice) return { kind: "voice", uid: m.voice.file_unique_id, name: null };
  if (m.animation) return { kind: "animation", uid: m.animation.file_unique_id, name: m.animation.file_name ?? null };
  if (m.video_note) return { kind: "video_note", uid: m.video_note.file_unique_id, name: null };
  if (m.photo?.length) return { kind: "photo", uid: m.photo[m.photo.length - 1].file_unique_id, name: null };
  return null;
}

/* ───────────── Updates ───────────── */

const isAdmin = (env: Env, id: number) =>
  env.ADMIN_IDS.split(",").map((s) => s.trim()).includes(String(id));

async function handleMessage(env: Env, m: any) {
  if (!isAdmin(env, m.from?.id)) return;
  const chatId: number = m.chat.id;
  await setSetting(env, "notify_chat", String(chatId));
  await setSetting(env, "src_chat", String(chatId));

  // انتظار برای انتخاب کانال
  if ((await getSetting(env, "pending_action")) === "await_channel") {
    const origin = m.forward_origin?.chat ?? m.forward_from_chat;
    let target: string | number | null = origin?.id ?? null;
    if (!target && m.text) {
      const t = m.text.trim();
      if (/^@\w+$/.test(t) || /^-?\d+$/.test(t)) target = t;
    }
    if (!target) {
      await tg(env, "sendMessage", { chat_id: chatId, text: "❗️ یک پیام از کانال فوروارد کنید، یا @username / آیدی عددی کانال را بفرستید." });
      return;
    }
    const chat = await tg(env, "getChat", { chat_id: target });
    const me = await tg(env, "getMe", {});
    const member = chat.ok ? await tg(env, "getChatMember", { chat_id: chat.result.id, user_id: me.result.id }) : null;
    const ok =
      member?.ok &&
      ["administrator", "creator"].includes(member.result.status) &&
      member.result.can_post_messages !== false;
    if (!ok) {
      await tg(env, "sendMessage", { chat_id: chatId, text: "❌ کانال پیدا نشد یا ربات در آن ادمین (با دسترسی ارسال پیام) نیست. بعد از ادمین کردن دوباره بفرستید." });
      return;
    }
    await setSetting(env, "dest_channel", String(chat.result.id));
    await setSetting(env, "dest_title", chat.result.title ?? String(chat.result.id));
    await setSetting(env, "pending_action", "");
    const a = archiveScreen();
    await tg(env, "sendMessage", { chat_id: chatId, text: `✅ کانال مقصد: ${chat.result.title}` });
    await show(env, chatId, null, a.text, a.rows);
    return;
  }

  // دستورات
  if (m.text && /^\/(start|panel)/.test(m.text)) {
    const s = await mainScreen(env);
    await show(env, chatId, null, s.text, s.rows);
    return;
  }

  // دریافت فایل
  const media = extractMedia(m);
  if (media) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO files(chat_id,message_id,file_unique_id,kind,name) VALUES(?,?,?,?,?)"
    ).bind(chatId, m.message_id, media.uid, media.kind, media.name).run();
  }
}

async function handleCallback(env: Env, ctx: ExecutionContext, cq: any) {
  if (!isAdmin(env, cq.from?.id)) {
    await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "دسترسی ندارید" });
    return;
  }
  const chatId: number = cq.message.chat.id;
  const mid: number = cq.message.message_id;
  const [g, act, arg] = String(cq.data).split(":");
  let toast = "";
  const go = (s: { text: string; rows: Row[] }) => show(env, chatId, mid, s.text, s.rows);
  const state = await getSetting(env, "state", "idle");

  switch (`${g}:${act}`) {
    case "m:main": await go(await mainScreen(env)); break;

    case "a:menu": await go(archiveScreen()); break;
    case "a:check": {
      const s = await stats(env);
      const { results } = await env.DB.prepare("SELECT kind, COUNT(*) n FROM files GROUP BY kind").all<{ kind: string; n: number }>();
      await setSetting(env, "last_check_total", String(s.total));
      await go({
        text:
          `🔍 بررسی فایل‌ها\n\n📦 کل: ${s.total}\n✅ ارسال‌شده: ${s.sent}\n⏳ باقی‌مانده: ${s.pending}\n⚠️ ناموفق: ${s.failed}\n\n` +
          (results ?? []).map((r) => `• ${r.kind}: ${r.n}`).join("\n"),
        rows: [[["🔙 بازگشت", "a:menu"]]],
      });
      break;
    }
    case "a:rescan": {
      const s = await stats(env);
      const last = Number(await getSetting(env, "last_check_total", "0"));
      await setSetting(env, "last_check_total", String(s.total));
      await go({
        text: `🔄 بررسی مجدد\n\n🆕 فایل جدید از آخرین بررسی: ${Math.max(0, s.total - last)}\n📦 کل: ${s.total}`,
        rows: [[["🔙 بازگشت", "a:menu"]]],
      });
      break;
    }
    case "a:list": await go(await listScreen(env, Number(arg ?? 0))); break;
    case "a:chan":
      await setSetting(env, "pending_action", "await_channel");
      await go({
        text: "📢 انتخاب کانال مقصد\n\nربات را در کانال ادمین کنید، سپس یک پیام از آن کانال فوروارد کنید یا @username / آیدی عددی را بفرستید.",
        rows: [[["❌ انصراف", "a:cancelchan"]]],
      });
      break;
    case "a:cancelchan":
      await setSetting(env, "pending_action", "");
      await go(archiveScreen());
      break;

    case "s:menu": await go(await settingsScreen(env)); break;
    case "s:delay":
      await setSetting(env, "delay", String(Math.min(5, Math.max(1, Number(arg)))));
      await go(await settingsScreen(env));
      break;

    case "c:menu": await go(controlScreen()); break;
    case "c:status": await go(await statusScreen(env)); break;

    case "c:start": {
      const s = await stats(env);
      if (state === "running") toast = "ارسال در حال انجام است";
      else if (state === "paused") toast = "متوقف شده؛ «ادامه ارسال» را بزنید";
      else if (!(await getSetting(env, "dest_channel"))) toast = "اول کانال مقصد را انتخاب کنید";
      else if (!s.pending) toast = "فایل در صف نیست";
      else await go(await confirmScreen(env));
      break;
    }
    case "c:go":
      if (state === "running") { toast = "در حال ارسال"; break; }
      await setSetting(env, "state", "running");
      ctx.waitUntil(runSender(env, 25000));
      await go(await statusScreen(env));
      toast = "ارسال شروع شد";
      break;

    case "c:pause":
      if (state !== "running") toast = "ارسالی در جریان نیست";
      else { await setSetting(env, "state", "paused"); toast = "متوقف شد (صف حفظ شد)"; await go(await statusScreen(env)); }
      break;

    case "c:resume":
      if (state !== "paused") toast = state === "running" ? "در حال ارسال" : "برای ادامه ابتدا «شروع ارسال» را بزنید";
      else {
        await setSetting(env, "state", "running");
        ctx.waitUntil(runSender(env, 25000));
        toast = "ادامه یافت";
        await go(await statusScreen(env));
      }
      break;

    case "c:cancel":
      await setSetting(env, "state", "cancelled");
      toast = "لغو شد";
      await go({
        text: "🛑 عملیات لغو شد.\nفایل‌های آرشیو و وضعیت ارسال‌شده‌ها حفظ شده‌اند.",
        rows: [[["🔙 بازگشت", "c:menu"]]],
      });
      break;

    case "c:restart":
      await go({
        text: "🔄 شروع مجدد از اولین فایل\n\nفایل‌هایی که قبلاً ارسال شده‌اند چه شوند؟",
        rows: [
          [["🔁 همه را دوباره بفرست", "c:rall"]],
          [["⏭️ فقط ارسال‌نشده‌ها (و ناموفق‌ها)", "c:runsent"]],
          [["❌ بازگشت", "c:menu"]],
        ],
      });
      break;
    case "c:rall":
      await setSetting(env, "state", "idle");
      await env.DB.prepare("UPDATE files SET status='pending', error=NULL, sent_at=NULL").run();
      await go(await confirmScreen(env));
      break;
    case "c:runsent":
      await setSetting(env, "state", "idle");
      await env.DB.prepare("UPDATE files SET status='pending', error=NULL WHERE status='failed'").run();
      await go(await confirmScreen(env));
      break;
  }

  await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, ...(toast ? { text: toast } : {}) });
}

/* ───────────── Entry ───────────── */

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/webhook" && req.method === "POST") {
      if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET)
        return new Response("forbidden", { status: 403 });
      const update: any = await req.json();
      ctx.waitUntil(
        (update.callback_query
          ? handleCallback(env, ctx, update.callback_query)
          : update.message
          ? handleMessage(env, update.message)
          : Promise.resolve()
        ).catch((e) => console.error(e))
      );
      return new Response("ok");
    }

    if (url.pathname === "/setup" && url.searchParams.get("key") === env.WEBHOOK_SECRET) {
      const res = await tg(env, "setWebhook", {
        url: `${url.origin}/webhook`,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ["message", "callback_query"],
      });
      return Response.json(res);
    }

    return new Response("Archive bot is running");
  },

  // Cron هر دقیقه: ارسال را ادامه می‌دهد
  async scheduled(_e: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runSender(env, 50000));
  },
};
