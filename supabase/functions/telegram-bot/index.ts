// index.ts — הבוט של GB Wigs: ניתוב, פקודות, כפתורים ושיחה עם המודל
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { cfg, isMultiPartner, linkWithCode, type Partner, partnerByChat, sb } from "./db.ts";
import {
  BOT_USERNAME, COMMANDS, downloadFile, MAIN_KEYBOARD, send, tg, toBase64, typing, webhookSecret, type Button,
} from "./tg.ts";
import { getLLM, type Media, type Msg } from "./llm.ts";
import {
  type Ctx, freeTimeText, hardDelete, openBalances, runTool, systemPrompt, toolDeclarations,
} from "./tools.ts";
import { runCron } from "./cron.ts";
import { calendarSync, ensureCalendar } from "./gcal.ts";
import { accessToken, buildAuthUrl, handleOAuthCallback } from "./google.ts";
import { addDays, fmtDay, fmtDT, fmtTime, localParts, localToUtc, money, todayStr } from "./util.ts";

const llm = getLLM();

// ───────────── שיחה עם המודל ─────────────
async function loadHistory(chatId: number): Promise<Msg[]> {
  const { data } = await sb.from("bot_messages").select("role, content").eq("chat_id", chatId).order("id", { ascending: false }).limit(16);
  const msgs = (data ?? []).reverse().map((m) => ({ role: m.role as "user" | "model", text: m.content }));
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  return msgs;
}

async function converse(ctx: Ctx, user: Msg, historyText: string): Promise<string> {
  const [history, system, tools] = await Promise.all([loadHistory(ctx.chatId), systemPrompt(ctx.partner), toolDeclarations()]);
  const msgs: Msg[] = [...history, user];
  const internal: string[] = [];
  let final = "";
  for (let i = 0; i < 10; i++) {
    const r = await llm.generate(system, msgs, tools);
    if (!r.toolCalls.length) { final = r.text; break; }
    msgs.push({ role: "model", text: r.text, toolCalls: r.toolCalls, raw: r.raw });
    const results = [];
    for (const c of r.toolCalls) {
      let out: unknown;
      try { out = await runTool(c.name, c.args, ctx); } catch (e) { out = { error: String((e as Error).message ?? e) }; }
      results.push({ name: c.name, result: out });
      internal.push(`${c.name}(${JSON.stringify(c.args).slice(0, 200)}) → ${JSON.stringify(out).slice(0, 700)}`);
    }
    msgs.push({ role: "user", toolResults: results });
    if (i === 9) final = r.text || "ביצעתי את מה שיכולתי. אפשר לבקש שוב אם משהו חסר.";
  }
  if (!final) final = "בוצע ✅";
  await sb.from("bot_messages").insert([
    { chat_id: ctx.chatId, role: "user", content: historyText },
    { chat_id: ctx.chatId, role: "model", content: final + (internal.length ? `\n[מידע פנימי: ${internal.join(" | ").slice(0, 2500)}]` : "") },
  ]);
  return final;
}

function undoRows(ctx: Ctx): Button[][] {
  const rows: Button[][] = ctx.created.slice(0, 4).map((c) => [{ text: `↩️ ביטול ${c.label}`.slice(0, 60), data: `undo:${c.table}:${c.id}` }]);
  return [...ctx.buttons, ...rows];
}

// ───────────── קבצים: חשבונית / קול ─────────────
async function handleMedia(ctx: Ctx, m: any): Promise<void> {
  const caption: string = m.caption ?? "";
  let fileId: string | null = null, mime = "", kind: "image" | "audio" = "image", ext = "jpg";
  if (m.photo?.length) { fileId = m.photo[m.photo.length - 1].file_id; mime = "image/jpeg"; }
  else if (m.voice) { fileId = m.voice.file_id; mime = m.voice.mime_type ?? "audio/ogg"; kind = "audio"; }
  else if (m.audio) { fileId = m.audio.file_id; mime = m.audio.mime_type ?? "audio/mpeg"; kind = "audio"; }
  else if (m.document) {
    mime = m.document.mime_type ?? "";
    if (mime === "application/pdf") { ext = "pdf"; }
    else if (mime.startsWith("image/")) { ext = mime.split("/")[1] ?? "jpg"; }
    else if (mime.startsWith("audio/")) { kind = "audio"; }
    else { await send(ctx.chatId, "אני יודעת לקרוא תמונות, PDF והודעות קוליות. את הקובץ הזה לא."); return; }
    fileId = m.document.file_id;
  }
  if (!fileId) return;
  const file = await downloadFile(fileId);
  if (!file) { await send(ctx.chatId, "לא הצלחתי להוריד את הקובץ מטלגרם (אולי הוא גדול מ-20MB)."); return; }
  const media: Media = { mime, data: toBase64(file.bytes) };

  if (kind === "audio") {
    const text = "הודעה קולית ממני. בצעי את מה שביקשתי וכתבי בקצרה מה הבנת." + (caption ? ` ${caption}` : "");
    const reply = await converse(ctx, { role: "user", text, media: [media] }, "[הודעה קולית]" + (caption ? ` ${caption}` : ""));
    await send(ctx.chatId, reply, undoRows(ctx));
    return;
  }
  const path = `${todayStr().slice(0, 7)}/${crypto.randomUUID()}.${ext}`;
  const up = await sb.storage.from("receipts").upload(path, file.bytes, { contentType: mime });
  if (up.error) { await send(ctx.chatId, "לא הצלחתי לשמור את הקובץ: " + up.error.message); return; }
  const text = `שלחתי קובץ (חשבונית/קבלה). הוא נשמר בנתיב: ${path} (receipt_path). קראי ממנו ספק, סכום, תאריך ומספר חשבונית ורשמי הוצאה.${caption ? ` הערה ממני: ${caption}` : ""}`;
  const reply = await converse(ctx, { role: "user", text, media: [media] }, `[צילום חשבונית, קובץ שמור בנתיב ${path}]${caption ? " " + caption : ""}`);
  await send(ctx.chatId, reply, undoRows(ctx));
}

// ───────────── פקודות (בלי מודל) ─────────────
const PROMPTS: Record<string, string> = {
  expense: "💸 מה להוציא? למשל:\n• \"שילמתי 480 על טופ לייס לשרה כהן\"\n• \"קניתי חומרים ב-220 מהספק X\"\nאפשר גם לצלם חשבונית או להקליט.",
  income: "💵 מה התקבל? למשל: \"שרה כהן שילמה 1500 מקדמה בביט\" או \"קיבלתי יתרה 800 מרחל, חשבונית 1042\".",
  appointment: "🗓 איזה תור לקבוע? למשל:\n• \"תור התאמה לרחל כהן ביום שני ב-19:30\"\n• \"ייעוץ והזמנה למירי ביום חמישי ב-11\"\nאו כתבי \"מתי פנוי?\" ואציע זמנים.",
  customer: "👩 לקוחה חדשה: כתבי שם, טלפון, ואם יש: תאריך אירוע, סוג וצבע שיער, מידות ראש ומפרט. אפשר להקליט.",
  time: "⏱ אין כאן דיווח שעות. אם את צריכה, אפשר להוסיף אחר כך.",
};

const HELP = `🌸 אני המזכירה של GB Wigs. אפשר לכתוב, להקליט או לצלם.

לקוחות והזמנות:
• "תפתחי לקוחה שרה כהן, 050..., חתונה ב-12.3, שיער חום כהה"
• "הזמנה חדשה לשרה: טופ לייס, 4200, מקדמה 1500 בביט"
• "מה המצב עם שרה כהן?"
• "המידות של שרה: היקף 56, קדמי-עורפי 33"
• "הפיאה של שרה מוכנה" / "נמסרה"

כסף:
• "שרה שילמה 800 יתרה, חשבונית 1042"
• "שילמתי 350 על שיער גולמי מהספק X"
• "מי חייבת לי כסף?" (או /due)
• "כמה הרווחתי החודש?" / "רווח לפי הזמנה"
• צילום חשבונית, או "תמצאי חשבוניות מ-Gmail מהחודש"

יומן:
• "תור התאמה לרחל ביום שני ב-19:30"
• "מתי פנוי לייעוץ?" (או /free)
• "תזיזי את התור של רחל למחר ב-20:00"
• "אני בחופש ביום שלישי"

טיפולים ותזכורות:
• "עשיתי חפיפה ותספורת לרחל, תזכירי לתאם עוד 6 שבועות"
• "תזכירי לי ביום ראשון ב-10 להזמין חומר"
• "תזכרי שרחל מעדיפה וואטסאפ"

פקודות: /today /week /free /due /orders /tasks /invoices /google /memory`;

async function showToday(ctx: Ctx) {
  const today = todayStr();
  const from = localToUtc(today), to = localToUtc(addDays(today, 1));
  const [ap, rem, tk] = await Promise.all([
    sb.from("appointments").select("title, kind, starts_at, ends_at, all_day, customers(phone)").lt("starts_at", to.toISOString()).gt("ends_at", from.toISOString()).order("starts_at"),
    sb.from("reminders").select("message, remind_at").is("sent_at", null).gte("remind_at", from.toISOString()).lt("remind_at", to.toISOString()).order("remind_at"),
    sb.from("tasks").select("id, title, due_date").neq("status", "done").lte("due_date", today).order("due_date"),
  ]);
  const lines: string[] = [`📅 ${fmtDay(today)}`];
  if (ap.data?.length) lines.push("", "🗓 תורים:", ...ap.data.map((a: any) => `• ${a.all_day ? "יום שלם" : fmtTime(a.starts_at) + "-" + fmtTime(a.ends_at)} ${a.title}${a.customers?.phone ? ` · ${a.customers.phone}` : ""}`));
  if (rem.data?.length) lines.push("", "⏰ תזכורות:", ...rem.data.map((r) => `• ${fmtTime(r.remind_at)} ${r.message}`));
  if (tk.data?.length) lines.push("", "📌 משימות:", ...tk.data.map((t) => `• ${t.title}${t.due_date < today ? " (באיחור)" : ""}`));
  if (lines.length === 1) lines.push("", "אין כלום ביומן להיום 🌸");
  await send(ctx.chatId, lines.join("\n"), (tk.data ?? []).slice(0, 8).map((t) => [{ text: `✅ ${t.title}`.slice(0, 50), data: `done:${t.id}` }]));
}

async function showWeek(ctx: Ctx) {
  const today = todayStr();
  const from = localToUtc(today), to = localToUtc(addDays(today, 7));
  const [ap, tk] = await Promise.all([
    sb.from("appointments").select("title, starts_at, ends_at, all_day").lt("starts_at", to.toISOString()).gt("ends_at", from.toISOString()).order("starts_at"),
    sb.from("tasks").select("title, due_date").neq("status", "done").gte("due_date", today).lte("due_date", addDays(today, 6)).order("due_date"),
  ]);
  const byDay = new Map<string, string[]>();
  for (const a of ap.data ?? []) {
    const d = localParts(new Date(a.starts_at)).date;
    byDay.set(d, [...(byDay.get(d) ?? []), `• ${a.all_day ? "יום שלם" : fmtTime(a.starts_at)} ${a.title}`]);
  }
  for (const t of tk.data ?? []) byDay.set(t.due_date, [...(byDay.get(t.due_date) ?? []), `• 📌 ${t.title}`]);
  const days = [...byDay.keys()].sort();
  await send(ctx.chatId, days.length ? "🗓 7 הימים הקרובים\n\n" + days.map((d) => `${fmtDay(d)}\n${byDay.get(d)!.join("\n")}`).join("\n\n") : "אין כלום ביומן ל-7 הימים הקרובים 🌸");
}

async function showTasks(ctx: Ctx) {
  const { data } = await sb.from("tasks").select("id, title, due_date, priority").neq("status", "done").order("due_date", { ascending: true, nullsFirst: false }).limit(30);
  if (!data?.length) { await send(ctx.chatId, "אין משימות פתוחות 🎉"); return; }
  await send(ctx.chatId, "📋 משימות פתוחות:\n" + data.map((t) => `${t.priority === 1 ? "🔴" : "•"} ${t.title}${t.due_date ? ` (${t.due_date})` : ""}`).join("\n"),
    data.slice(0, 10).map((t) => [{ text: `✅ ${t.title}`.slice(0, 50), data: `done:${t.id}` }]));
}

async function showDue(ctx: Ctx) {
  const b = await openBalances();
  if (!b.rows.length) { await send(ctx.chatId, "אין יתרות פתוחות 🎉"); return; }
  const lines = b.rows.map((r) => `• ${r.customer}: ${money(r.due)} מתוך ${money(r.price)} (${r.order})${r.delivered ? " · נמסרה" : ""}`);
  await send(ctx.chatId, `💰 יתרות פתוחות: ${money(b.total_due)}${b.delivered_unpaid ? ` (מתוכן ${money(b.delivered_unpaid)} אחרי מסירה)` : ""}\n\n${lines.join("\n")}`);
}

async function showOrders(ctx: Ctx) {
  const { data } = await sb.from("order_financials").select("customer_id, title, status, price, paid, balance_due, due_date").not("status", "in", "(delivered,cancelled)").order("due_date", { ascending: true, nullsFirst: false });
  if (!data?.length) { await send(ctx.chatId, "אין הזמנות פתוחות."); return; }
  const { data: cs } = await sb.from("customers").select("id, full_name").in("id", data.map((x) => x.customer_id));
  const names = new Map((cs ?? []).map((c) => [c.id, c.full_name]));
  const ST: Record<string, string> = { consultation: "ייעוץ", ordered: "הוזמן", in_progress: "בעבודה", ready: "מוכן" };
  await send(ctx.chatId, "📦 הזמנות פתוחות:\n" + data.map((o) => `• ${names.get(o.customer_id)} – ${o.title} [${ST[o.status] ?? o.status}]${o.due_date ? ` · יעד ${o.due_date}` : ""}\n   ${money(o.paid)} מתוך ${money(o.price)}`).join("\n"));
}

async function showMemory(ctx: Ctx) {
  const { data } = await sb.from("bot_memories").select("kind, content").order("created_at", { ascending: false }).limit(40);
  await send(ctx.chatId, data?.length ? "🧠 מה שאני זוכרת:\n" + data.map((m) => `• ${m.content}`).join("\n") + "\n\nכדי למחוק: \"תשכחי ש...\"" : "אין עדיין זיכרונות. אפשר לומר \"תזכרי ש...\"");
}

async function showGoogle(ctx: Ctx, force = false) {
  const token = await accessToken(sb, ctx.partner.id);
  const { data: acc } = await sb.from("gmail_accounts").select("email, scopes").eq("partner_id", ctx.partner.id).maybeSingle();
  if (token && acc && !force) {
    const hasCal = (acc.scopes ?? "").includes("calendar");
    await send(ctx.chatId, `✅ מחוברת ל-Google (${acc.email ?? "ללא מייל"})\nGmail: קריאה בלבד\nיומן: ${hasCal ? "מחובר, יומן \"GB Wigs\" מסונכרן" : "לא אושר. חברי מחדש וסמני את כל ההרשאות"}`,
      [[{ text: "🔗 חיבור מחדש", url: await buildAuthUrl(sb, ctx.partner.id) }]]);
    return;
  }
  await send(ctx.chatId, "🔗 לחצי כדי לחבר את Google. סמני את כל ההרשאות.\nאם מופיע \"האפליקציה לא אומתה\": מתקדם ← מעבר לאפליקציה.", [[{ text: "🔗 חיבור Google", url: await buildAuthUrl(sb, ctx.partner.id) }]]);
}

async function handleCommand(ctx: Ctx, text: string): Promise<boolean> {
  const t = text.trim();
  const map: Record<string, () => Promise<void>> = {
    "/today": () => showToday(ctx), "📅 היום": () => showToday(ctx),
    "/week": () => showWeek(ctx),
    "/tasks": () => showTasks(ctx), "📋 משימות": () => showTasks(ctx),
    "/due": () => showDue(ctx), "💰 יתרות": () => showDue(ctx),
    "/orders": () => showOrders(ctx),
    "/memory": () => showMemory(ctx),
    "/google": () => showGoogle(ctx),
    "/free": async () => { await send(ctx.chatId, await freeTimeText("regular", 10) + "\n\n(לייעוץ והזמנה, שעה: כתבי \"מתי פנוי לייעוץ?\")"); },
    "/menu": async () => { await tg("sendMessage", { chat_id: ctx.chatId, text: "התפריט מוכן למטה 👇", reply_markup: MAIN_KEYBOARD }); },
    "/help": async () => { await send(ctx.chatId, HELP); },
    "💸 הוצאה": async () => { await send(ctx.chatId, PROMPTS.expense); },
    "/expense": async () => { await send(ctx.chatId, PROMPTS.expense); },
    "/income": async () => { await send(ctx.chatId, PROMPTS.income); },
    "🗓 תור חדש": async () => { await send(ctx.chatId, PROMPTS.appointment); },
    "/appointment": async () => { await send(ctx.chatId, PROMPTS.appointment); },
    "👩 לקוחה חדשה": async () => { await send(ctx.chatId, PROMPTS.customer); },
  };
  const cmd = t.split(/[\s@]/)[0];
  const key = map[t] ? t : map[cmd] ? cmd : null;
  if (key) { await map[key](); return true; }
  if (cmd === "/invoices") {
    const start = todayStr().slice(0, 8) + "01";
    const reply = await converse(ctx, { role: "user", text: `תמצאי לי חשבוניות מספקים ב-Gmail מ-${start} עד היום.` }, "/invoices");
    await send(ctx.chatId, reply, undoRows(ctx));
    return true;
  }
  return false;
}

// ───────────── כפתורים ─────────────
async function handleCallback(cb: any) {
  const chatId = cb.message?.chat?.id as number;
  const partner = await partnerByChat(chatId);
  if (!partner) return;
  const [kind, a, b] = String(cb.data ?? "").split(":");
  let toast = "";
  if (kind === "done") {
    await sb.from("tasks").update({ status: "done" }).eq("id", a);
    toast = "סומן כבוצע ✅";
  } else if (kind === "snz") {
    const { data: t } = await sb.from("tasks").select("snooze_count").eq("id", a).maybeSingle();
    const cnt = (t?.snooze_count ?? 0) + 1;
    await sb.from("tasks").update({ due_date: addDays(todayStr(), Number(b) || 1), snooze_count: cnt, reminded_on: null }).eq("id", a);
    toast = "נדחה";
    if (cnt >= 3) await send(chatId, "המשימה הזו כבר נדחתה 3 פעמים. אולי לפרק, להעביר או לוותר?");
  } else if (kind === "undo") {
    const r = await hardDelete(a, b) as { deleted?: boolean; error?: string };
    toast = r.deleted ? "בוטל ↩️" : (r.error ?? "לא הצלחתי לבטל");
    if (r.deleted) await send(chatId, "↩️ בוטל.");
  } else if (kind === "rb") {
    const weeks = Number(b) || 4;
    const { data: c } = await sb.from("customers").select("full_name").eq("id", a).maybeSingle();
    const when = localToUtc(addDays(todayStr(), weeks * 7), "10:00");
    await sb.from("reminders").insert({ partner_id: partner.id, message: `🔁 הגיע הזמן לתאם תור חוזר ל${c?.full_name ?? "הלקוחה"}`, remind_at: when.toISOString(), kind: "rebook" });
    toast = "נקבע";
    await send(chatId, `🔁 אזכיר לך לתאם תור חוזר ל${c?.full_name ?? "הלקוחה"} ב-${fmtDT(when)}.`);
  } else if (kind === "ok") toast = "👍";
  await tg("answerCallbackQuery", { callback_query_id: cb.id, text: toast });
  try { await tg("editMessageReplyMarkup", { chat_id: chatId, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } }); } catch { /* לא קריטי */ }
}

// ───────────── הודעה נכנסת ─────────────
async function handleMessage(m: any) {
  const chatId = m.chat.id as number;
  const text: string = (m.text ?? "").trim();
  let partner = await partnerByChat(chatId);

  if (!partner) {
    const code = text.startsWith("/start") ? text.replace("/start", "").trim() : text;
    const linked = code ? await linkWithCode(chatId, code) : null;
    if (linked) {
      await tg("sendMessage", { chat_id: chatId, text: `היי ${linked.name}! 🎉 חיברתי אותך. אני המזכירה של GB Wigs.\nכתבי /help לדוגמאות, ו-/google כדי לחבר את Gmail והיומן.`, reply_markup: MAIN_KEYBOARD });
      return;
    }
    await send(chatId, "היי! אני הבוט הפרטי של GB Wigs 🌸\nשלחי לי את קוד החיבור האישי שלך.");
    return;
  }

  const ctx: Ctx = { partner, chatId, created: [], buttons: [] };
  if (text === "/start" || text.startsWith("/start ")) {
    const arg = text.replace("/start", "").trim();
    if (arg === "google") { await showGoogle(ctx); return; }
    await tg("sendMessage", { chat_id: chatId, text: `היי ${partner.name} 🌸 אני כאן. כתבי, הקליטי או צלמי חשבונית.\n/help לדוגמאות.`, reply_markup: MAIN_KEYBOARD });
    return;
  }
  if (m.photo || m.voice || m.audio || m.document) {
    await typing(chatId);
    await handleMedia(ctx, m);
    return;
  }
  if (!text) return;
  if (await handleCommand(ctx, text)) return;
  await typing(chatId);
  const reply = await converse(ctx, { role: "user", text }, text);
  await send(chatId, reply, undoRows(ctx));
}

// ───────────── שרת ─────────────
async function setup(): Promise<Response> {
  const base = `${Deno.env.get("SUPABASE_URL")}/functions/v1/telegram-bot`;
  const webhook = await tg("setWebhook", { url: base, secret_token: await webhookSecret(), allowed_updates: ["message", "callback_query"], drop_pending_updates: false });
  const commands = await tg("setMyCommands", { commands: COMMANDS });
  const menu = await tg("setChatMenuButton", { menu_button: { type: "commands" } });
  const me = await tg("getMe");
  return Response.json({ webhook, commands, menu, bot: me?.result?.username }, { headers: { "Content-Type": "application/json; charset=utf-8" } });
}

// Supabase לא מציג HTML מהדומיין שלו (הופך ל-text/plain), לכן אחרי Google מחזירים את הדפדפן לטלגרם
const backToTelegram = () => Response.redirect(`https://t.me/${BOT_USERNAME().replace(/^@/, "")}`, 302);

async function notifyAll(text: string) {
  const { data } = await sb.from("partners").select("telegram_chat_id").not("telegram_chat_id", "is", null);
  for (const p of data ?? []) await send(p.telegram_chat_id, text);
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  // חזרה מ-Google אחרי אישור
  if (req.method === "GET" && url.pathname.endsWith("/gmail/callback")) {
    try {
      if (url.searchParams.get("error")) {
        await notifyAll("החיבור ל-Google בוטל. אפשר לנסות שוב עם /google");
        return backToTelegram();
      }
      const r = await handleOAuthCallback(sb, url.searchParams.get("code") ?? "", url.searchParams.get("state") ?? "");
      const { data: p } = await sb.from("partners").select("telegram_chat_id").eq("id", r.partnerId).maybeSingle();
      const calendarOk = r.scopes.includes("calendar");
      const token = await accessToken(sb, r.partnerId);
      if (token && calendarOk) { await ensureCalendar(sb, token); await calendarSync(sb); }
      if (p?.telegram_chat_id) {
        await send(p.telegram_chat_id, `✅ Google מחובר${r.email ? ` (${r.email})` : ""}.\n${calendarOk ? "יצרתי יומן \"GB Wigs\" בגוגל, ותורים יסתנכרנו אליו." : "⚠️ לא אושרה הרשאת היומן. חברי שוב עם /google וסמני את כל ההרשאות."}`);
      }
      return backToTelegram();
    } catch (e) {
      await notifyAll(`⚠️ החיבור ל-Google נכשל: ${String((e as Error).message).slice(0, 200)}\nאפשר לנסות שוב עם /google`);
      return backToTelegram();
    }
  }

  if (action === "setup") return await setup();

  if (action === "cron" || action === "calendar_sync") {
    const secret = await cfg("cron_secret");
    if (!secret || req.headers.get("x-cron-secret") !== secret) return new Response("forbidden", { status: 403 });
    if (action === "calendar_sync") return Response.json(await calendarSync(sb));
    return Response.json(await runCron());
  }

  if (req.method !== "POST") return new Response("GB Wigs bot", { status: 200 });
  if (req.headers.get("x-telegram-bot-api-secret-token") !== (await webhookSecret())) return new Response("forbidden", { status: 403 });

  let update: any;
  try { update = await req.json(); } catch { return new Response("bad request", { status: 400 }); }

  const work = (async () => {
    try {
      if (update.callback_query) await handleCallback(update.callback_query);
      else if (update.message) await handleMessage(update.message);
    } catch (e) {
      console.error("handler error", e);
      const chatId = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;
      if (chatId && await partnerByChat(chatId)) await send(chatId, "אופס, משהו השתבש אצלי 😕 אפשר לנסות שוב?\n" + String((e as Error).message ?? e).slice(0, 200));
    }
  })();
  // @ts-ignore EdgeRuntime קיים בסביבת Supabase
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(work); else await work;
  return new Response("ok");
});
