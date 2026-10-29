# راه‌اندازی

1. `npm install`
2. `npx wrangler login`
3. `npx wrangler d1 create archive-bot` ← `database_id` را در wrangler.toml بگذارید
4. `npx wrangler d1 execute archive-bot --remote --file=schema.sql`
5. در wrangler.toml مقدار `ADMIN_IDS` را بگذارید (آیدی عددی خودتان از @userinfobot)
6. `npx wrangler secret put BOT_TOKEN`  (توکن از @BotFather)
7. `npx wrangler secret put WEBHOOK_SECRET`  (یک رشتهٔ تصادفی، فقط حروف و عدد)
8. `npx wrangler deploy`
9. یک‌بار در مرورگر باز کنید:
   https://archive-bot.<subdomain>.workers.dev/setup?key=<WEBHOOK_SECRET>

# استفاده
- `/panel` را به ربات بفرستید.
- ربات را در کانال مقصد ادمین کنید (دسترسی ارسال پیام).
- «مدیریت آرشیو ← انتخاب کانال مقصد» را بزنید.
- فایل‌های آرشیو را به ترتیب (اولین تا آخرین) به ربات فوروارد کنید.
- «تنظیمات ارسال» ← تأخیر، «کنترل ارسال» ← شروع.

# نکته‌ها
- فایل تکراری (همان file_unique_id) فقط یک‌بار ثبت می‌شود.
- ارسال با copyMessage انجام می‌شود (بدون برچسب «فوروارد از…» و با حفظ کپشن).
- پیام‌های فوروارد‌شده را در چت ربات پاک نکنید؛ ربات از همان‌ها کپی می‌کند.
- تأخیر ۱ تا ۵ ثانیه است؛ محدودیت تلگرام برای کانال حدود ۲۰ پیام در دقیقه است و ربات خودش 429 را مدیریت می‌کند.
