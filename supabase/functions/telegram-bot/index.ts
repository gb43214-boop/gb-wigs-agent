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
import { googleReconnectText, runCron } from "./cron.ts";
import { calendarSync, ensureCalendar } from "./gcal.ts";
import { accessToken, buildAuthUrl, connectLink, handleOAuthCallback, verifyConnect } from "./google.ts";
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
    if (i === 9) final = r.text || "עשיתי כל מה שיכולתי אהובה 🌸 אם משהו חסר, תבקשי שוב ואני על זה 💪✨";
  }
  if (!final) final = "סגור מאמי, בוצע! ✅🌸";
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
    else { await send(ctx.chatId, "אוף כפרה, את הקובץ הזה אני לא יודעת לקרוא 🙈 שלחי לי תמונה, PDF או הודעה קולית ואני על זה 🌸"); return; }
    fileId = m.document.file_id;
  }
  if (!fileId) return;
  const file = await downloadFile(fileId);
  if (!file) { await send(ctx.chatId, "אוי אהובה, לא הצלחתי להוריד את הקובץ מטלגרם 😕 אולי הוא גדול מ-20MB? נסי לשלוח קטן יותר 🌸"); return; }
  const media: Media = { mime, data: toBase64(file.bytes) };

  if (kind === "audio") {
    const text = "הודעה קולית ממני. בצעי את מה שביקשתי וכתבי בקצרה מה הבנת." + (caption ? ` ${caption}` : "");
    const reply = await converse(ctx, { role: "user", text, media: [media] }, "[הודעה קולית]" + (caption ? ` ${caption}` : ""));
    await send(ctx.chatId, reply, undoRows(ctx));
    return;
  }
  const path = `${todayStr().slice(0, 7)}/${crypto.randomUUID()}.${ext}`;
  const up = await sb.storage.from("receipts").upload(path, file.bytes, { contentType: mime });
  if (up.error) { await send(ctx.chatId, "אוף, לא הצלחתי לשמור את הקובץ 😕 נסי שוב בעוד רגע, מאמי 🌸\n" + up.error.message); return; }
  const text = `שלחתי קובץ (חשבונית/קבלה). הוא נשמר בנתיב: ${path} (receipt_path). קראי ממנו ספק, סכום, תאריך ומספר חשבונית ורשמי הוצאה.${caption ? ` הערה ממני: ${caption}` : ""}`;
  const reply = await converse(ctx, { role: "user", text, media: [media] }, `[צילום חשבונית, קובץ שמור בנתיב ${path}]${caption ? " " + caption : ""}`);
  await send(ctx.chatId, reply, undoRows(ctx));
}

// ───────────── פקודות (בלי מודל) ─────────────
const PROMPTS: Record<string, string> = {
  expense: "💸 יאללה אהובה, מה רושמות? למשל:\n• \"שילמתי 480 על טופ לייס לשרה כהן\"\n• \"קניתי חומרים ב-220 מהספק X\"\nאו פשוט תצלמי לי את החשבונית / תקליטי, ואני מסדרת הכול 📸🌸",
  income: "💵 וואו כסף נכנס, אני אוהבת! 🤑✨ מה התקבל? למשל:\n• \"שרה כהן שילמה 1500 מקדמה בביט\"\n• \"קיבלתי יתרה 800 מרחל, חשבונית 1042\"",
  appointment: "🗓 סבבה מאמי, איזה תור קובעות? למשל:\n• \"תור התאמה לרחל כהן ביום שני ב-19:30\"\n• \"ייעוץ והזמנה למירי ביום חמישי ב-11\"\nאו תכתבי \"מתי פנוי?\" ואני אציע לך זמנים 🌷",
  customer: "👩 איזה כיף, לקוחה חדשה! 🥰 תכתבי לי שם וטלפון, ואם יש גם: תאריך אירוע, סוג וצבע שיער, מידות ראש ומפרט. אפשר גם להקליט, אהובה 🎙🌸",
  time: "⏱ דיווח שעות עוד אין לי, כפרה. אם תצטרכי, נוסיף 🌸",
};

const HELP = `🌸 היי אהובה, זאת מאיה, המזכירה שלך ב-GB Wigs 💖
תכתבי לי, תקליטי או תצלמי, ואני כבר מסדרת הכול ✨

👩 לקוחות והזמנות:
• "תפתחי לקוחה שרה כהן, 050..., חתונה ב-12.3, שיער חום כהה"
• "הזמנה חדשה לשרה: טופ לייס, 4200, מקדמה 1500 בביט"
• "מה המצב עם שרה כהן?"
• "המידות של שרה: היקף 56, קדמי-עורפי 33"
• "הפיאה של שרה מוכנה" / "נמסרה"

💰 כסף:
• "שרה שילמה 800 יתרה, חשבונית 1042"
• "שילמתי 350 על שיער גולמי מהספק X"
• "מי חייבת לי כסף?" (או /due)
• "כמה הרווחתי החודש?" / "רווח לפי הזמנה"
• צילום חשבונית, או "תמצאי חשבוניות מ-Gmail מהחודש"

🗓 יומן:
• "תור התאמה לרחל ביום שני ב-19:30"
• "מתי פנוי לייעוץ?" (או /free)
• "תזיזי את התור של רחל למחר ב-20:00"
• "אני בחופש ביום שלישי"

💇‍♀️ טיפולים ותזכורות:
• "עשיתי חפיפה ותספורת לרחל, תזכירי לתאם עוד 6 שבועות"
• "תזכירי לי ביום ראשון ב-10 להזמין חומר"
• "תזכרי שרחל מעדיפה וואטסאפ"

קיצורים: /today /week /free /due /orders /tasks /invoices /google /memory

אני פה בשבילך תמיד, כי אין על גיטי! 👑🌺`;

async function showToday(ctx: Ctx) {
  const today = todayStr();
  const from = localToUtc(today), to = localToUtc(addDays(today, 1));
  const [ap, rem, tk] = await Promise.all([
    sb.from("appointments").select("title, kind, starts_at, ends_at, all_day, customers(phone)").lt("starts_at", to.toISOString()).gt("ends_at", from.toISOString()).order("starts_at"),
    sb.from("reminders").select("message, remind_at").is("sent_at", null).gte("remind_at", from.toISOString()).lt("remind_at", to.toISOString()).order("remind_at"),
    sb.from("tasks").select("id, title, due_date").neq("status", "done").lte("due_date", today).order("due_date"),
  ]);
  const lines: string[] = [`🌸 בוקר טוב אהובה! הנה היום שלך, ${fmtDay(today)} ✨`];
  if (ap.data?.length) lines.push("", "🗓 תורים:", ...ap.data.map((a: any) => `• ${a.all_day ? "יום שלם" : fmtTime(a.starts_at) + "-" + fmtTime(a.ends_at)} ${a.title}${a.customers?.phone ? ` · ${a.customers.phone}` : ""}`));
  if (rem.data?.length) lines.push("", "⏰ תזכורות:", ...rem.data.map((r) => `• ${fmtTime(r.remind_at)} ${r.message}`));
  if (tk.data?.length) lines.push("", "📌 משימות:", ...tk.data.map((t) => `• ${t.title}${t.due_date < today ? " (באיחור)" : ""}`));
  if (lines.length === 1) lines.push("", "היום פנוי לגמרי מאמי! 🥰 זמן לנשום, לשתות קפה ☕ ולהתפנק 💅");
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
  await send(ctx.chatId, days.length ? "🗓 יאללה, זה השבוע שלך כפרה ✨\n\n" + days.map((d) => `${fmtDay(d)}\n${byDay.get(d)!.join("\n")}`).join("\n\n") : "שבוע פנוי לגמרי אהובה! 🌴 רוצה שנמלא אותו בלקוחות? 😉🌸");
}

async function showTasks(ctx: Ctx) {
  const { data } = await sb.from("tasks").select("id, title, due_date, priority").neq("status", "done").order("due_date", { ascending: true, nullsFirst: false }).limit(30);
  if (!data?.length) { await send(ctx.chatId, "אין משימות פתוחות! אין על גיטי 🎉💖"); return; }
  await send(ctx.chatId, "📋 מה שעוד מחכה לך, אהובה:\n" + data.map((t) => `${t.priority === 1 ? "🔴" : "•"} ${t.title}${t.due_date ? ` (${t.due_date})` : ""}`).join("\n"),
    data.slice(0, 10).map((t) => [{ text: `✅ ${t.title}`.slice(0, 50), data: `done:${t.id}` }]));
}

async function showDue(ctx: Ctx) {
  const b = await openBalances();
  if (!b.rows.length) { await send(ctx.chatId, "כולן שילמו, אין יתרות פתוחות! 🎉🤑 על הכיפאק מאמי ✨"); return; }
  const lines = b.rows.map((r) => `• ${r.customer}: ${money(r.due)} מתוך ${money(r.price)} (${r.order})${r.delivered ? " · נמסרה" : ""}`);
  await send(ctx.chatId, `💰 מי עוד חייבת לך, אהובה:\nסך הכול ${money(b.total_due)}${b.delivered_unpaid ? ` (מתוכן ${money(b.delivered_unpaid)} אחרי מסירה)` : ""}\n\n${lines.join("\n")}\n\nרוצה נוסח עדין לוואטסאפ? תגידי לי למי 🌸`);
}

async function showOrders(ctx: Ctx) {
  const { data } = await sb.from("order_financials").select("customer_id, title, status, price, paid, balance_due, due_date").not("status", "in", "(delivered,cancelled)").order("due_date", { ascending: true, nullsFirst: false });
  if (!data?.length) { await send(ctx.chatId, "אין הזמנות פתוחות כרגע, כפרה 🌸 עוד רגע זה מתמלא, את תראי ✨"); return; }
  const { data: cs } = await sb.from("customers").select("id, full_name").in("id", data.map((x) => x.customer_id));
  const names = new Map((cs ?? []).map((c) => [c.id, c.full_name]));
  const ST: Record<string, string> = { consultation: "ייעוץ", ordered: "הוזמן", in_progress: "בעבודה", ready: "מוכן" };
  await send(ctx.chatId, "📦 ההזמנות שבעבודה, מלכה:\n" + data.map((o) => `• ${names.get(o.customer_id)} – ${o.title} [${ST[o.status] ?? o.status}]${o.due_date ? ` · יעד ${o.due_date}` : ""}\n   ${money(o.paid)} מתוך ${money(o.price)}`).join("\n"));
}

async function showMemory(ctx: Ctx) {
  const { data } = await sb.from("bot_memories").select("kind, content").order("created_at", { ascending: false }).limit(40);
  await send(ctx.chatId, data?.length ? "🧠 מה שאני זוכרת בשבילך, אהובה:\n" + data.map((m) => `• ${m.content}`).join("\n") + "\n\nמשהו לא נכון? תגידי \"תשכחי ש...\" ואני מוחקת 🌸" : "עוד לא סיפרת לי כלום לזכור, מאמי 🙈 תגידי \"תזכרי ש...\" ואני שומרת לך בלב 💖");
}

async function showGoogle(ctx: Ctx, force = false) {
  const token = await accessToken(sb, ctx.partner.id);
  const { data: acc } = await sb.from("gmail_accounts").select("email, scopes").eq("partner_id", ctx.partner.id).maybeSingle();
  if (token && acc && !force) {
    const hasCal = (acc.scopes ?? "").includes("calendar");
    await send(ctx.chatId, `✅ הכול מחובר לגוגל, אהובה! 🌸 (${acc.email ?? "ללא מייל"})\n📧 Gmail: רק קוראת, לא נוגעת\n🗓 יומן: ${hasCal ? "מחובר, יומן \"GB Wigs\" מסונכרן ✨" : "עוד לא אושר 🙈 תתחברי מחדש ותסמני את כל התיבות"}`,
      [[{ text: "🔗 חיבור מחדש", url: await connectLink(sb, ctx.partner.id) }]]);
    return;
  }
  await send(ctx.chatId, googleReconnectText(ctx.partner.name, null).replace(/^[\s\S]*?\n\n/, "🔗 יאללה אהובה, מחברות אותי לגוגל 🌸\n\n"), [[{ text: "🔗 חיבור מחדש ל-Google", url: await connectLink(sb, ctx.partner.id) }]]);
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
    "/free": async () => { await send(ctx.chatId, await freeTimeText("regular", 10) + "\n\nלייעוץ והזמנה (שעה) תכתבי לי \"מתי פנוי לייעוץ?\" 🌷"); },
    "/menu": async () => { await tg("sendMessage", { chat_id: ctx.chatId, text: "הנה התפריט, מאמי 👇🌸", reply_markup: MAIN_KEYBOARD }); },
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
    toast = Math.random() < 0.3 ? "בוצע ✅ אין על גיטי! 💖" : "יששש! בוצע ✅ את תותחית 💖";
  } else if (kind === "snz") {
    const { data: t } = await sb.from("tasks").select("snooze_count").eq("id", a).maybeSingle();
    const cnt = (t?.snooze_count ?? 0) + 1;
    await sb.from("tasks").update({ due_date: addDays(todayStr(), Number(b) || 1), snooze_count: cnt, reminded_on: null }).eq("id", a);
    toast = "סבבה, דחיתי 🌸";
    if (cnt >= 3) await send(chatId, "אהובה, המשימה הזאת כבר נדחתה 3 פעמים 🙈 אולי נפרק אותה לחלקים קטנים, נעביר, או פשוט נוותר? בלי לחץ 💖");
  } else if (kind === "undo") {
    const r = await hardDelete(a, b) as { deleted?: boolean; error?: string };
    toast = r.deleted ? "ביטלתי ↩️🌸" : (r.error ?? "אוף, לא הצלחתי לבטל 😕");
    if (r.deleted) await send(chatId, "↩️ סגור מאמי, ביטלתי. כאילו לא היה 🌸");
  } else if (kind === "rb") {
    const weeks = Number(b) || 4;
    const { data: c } = await sb.from("customers").select("full_name").eq("id", a).maybeSingle();
    const when = localToUtc(addDays(todayStr(), weeks * 7), "10:00");
    await sb.from("reminders").insert({ partner_id: partner.id, message: `🔁 הגיע הזמן לתאם תור חוזר ל${c?.full_name ?? "הלקוחה"}`, remind_at: when.toISOString(), kind: "rebook" });
    toast = "סגור! 🌸";
    await send(chatId, `🔁 סגור אהובה! אזכיר לך לתאם תור חוזר ל${c?.full_name ?? "הלקוחה"} ב-${fmtDT(when)} 🌸✨`);
  } else if (kind === "ok") toast = "👍🌸";
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
      await tg("sendMessage", { chat_id: chatId, text: `היי ${linked.name} אהובה! 🎉🌸 כאן מאיה, המזכירה החדשה שלך ב-GB Wigs 💖\nמעכשיו אני מסדרת לך את התורים, הלקוחות והכסף, ואת רק מתרכזת בפיאות 💅✨\n\nתכתבי /help ותראי כל מה שאני יודעת, ו-/google כדי לחבר אותי למייל וליומן 🙌`, reply_markup: MAIN_KEYBOARD });
      return;
    }
    await send(chatId, "היי בובה! 🌸 אני מאיה, המזכירה הפרטית של GB Wigs 💖\nשלחי לי את קוד החיבור האישי שלך ונתחיל ✨");
    return;
  }

  const ctx: Ctx = { partner, chatId, created: [], buttons: [] };
  if (text === "/start" || text.startsWith("/start ")) {
    const arg = text.replace("/start", "").trim();
    if (arg === "google") { await showGoogle(ctx); return; }
    await tg("sendMessage", { chat_id: chatId, text: `היי ${partner.name} אהובה! 🌸 מאיה פה בשבילך 💖\nתכתבי, תקליטי או תצלמי חשבונית, ואני מסדרת ✨\n/help לכל מה שאני יודעת לעשות${Math.random() < 0.3 ? "\n\nואגב... אין על גיטי! 💖" : ""}`, reply_markup: MAIN_KEYBOARD });
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

  // כפתור חיבור קבוע: יוצר קישור טרי לגוגל בכל לחיצה
  if (req.method === "GET" && url.pathname.endsWith("/google/connect")) {
    const pid = url.searchParams.get("p") ?? "", k = url.searchParams.get("k") ?? "";
    if (!(await verifyConnect(sb, pid, k))) return backToTelegram();
    return Response.redirect(await buildAuthUrl(sb, pid), 302);
  }

  // חזרה מ-Google אחרי אישור
  if (req.method === "GET" && url.pathname.endsWith("/gmail/callback")) {
    try {
      if (url.searchParams.get("error")) {
        await notifyAll("אוקיי אהובה, ביטלת את החיבור לגוגל 🌸 מתי שתרצי, תכתבי /google ונתחבר ✨");
        return backToTelegram();
      }
      const r = await handleOAuthCallback(sb, url.searchParams.get("code") ?? "", url.searchParams.get("state") ?? "");
      const { data: p } = await sb.from("partners").select("telegram_chat_id").eq("id", r.partnerId).maybeSingle();
      const calendarOk = r.scopes.includes("calendar");
      const token = await accessToken(sb, r.partnerId);
      if (token && calendarOk) { await ensureCalendar(sb, token); await calendarSync(sb); }
      if (p?.telegram_chat_id) {
        await send(p.telegram_chat_id, `יששש! ✅ מחוברות לגוגל, אהובה 🎉🌸${r.email ? ` (${r.email})` : ""}\n${calendarOk ? "יש לך יומן חדש בגוגל בשם \"GB Wigs\", וכל תור שנקבע יקפוץ אליו לבד ✨📅" : "⚠️ רק היומן לא אושר, מאמי 🙈 תכתבי /google ותסמני את כל התיבות"}`);
      }
      return backToTelegram();
    } catch (e) {
      await notifyAll(`אוף אהובה, החיבור לגוגל לא הצליח 😕 בואי ננסה שוב עם /google, זה בטח יעבוד 🌸\n(${String((e as Error).message).slice(0, 200)})`);
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
      if (chatId && await partnerByChat(chatId)) await send(chatId, "אוי כפרה, משהו השתבש אצלי 🙈 תנסי שוב בעוד רגע? 🌸\n" + String((e as Error).message ?? e).slice(0, 200));
    }
  })();
  // @ts-ignore EdgeRuntime קיים בסביבת Supabase
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(work); else await work;
  return new Response("ok");
});
