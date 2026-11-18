// cron.ts — מה שרץ כל דקה: שבת/חג, תזכורות, תורים, גבייה, סיכומים, סנכרון יומן
import { allPartners, cfg, cfgJson, type Partner, sb, setCfg } from "./db.ts";
import { send, type Button } from "./tg.ts";
import { addDays, fmtTime, localParts, localToUtc, money, todayStr, waLink } from "./util.ts";
import { calendarSync } from "./gcal.ts";
import { financialSummary, openBalances } from "./tools.ts";

// ───────────── שבת וחג (Hebcal) ─────────────
export async function refreshQuietWindows() {
  const { data: last } = await sb.from("quiet_windows").select("end_at").order("end_at", { ascending: false }).limit(1).maybeSingle();
  if (last && new Date(last.end_at).getTime() > Date.now() + 14 * 86400_000) return;
  const geo = await cfgJson<{ latitude: number; longitude: number; tzid: string }>("hebcal_geo", { latitude: 32.0834, longitude: 34.8333, tzid: "Asia/Jerusalem" });
  const q = new URLSearchParams({
    v: "1", cfg: "json", c: "on", maj: "on", min: "off", mod: "off", nx: "off", mf: "off", ss: "off", s: "off", i: "on",
    geo: "pos", latitude: String(geo.latitude), longitude: String(geo.longitude), tzid: geo.tzid, m: "50",
    start: addDays(todayStr(), -2), end: addDays(todayStr(), 60),
  });
  const res = await fetch(`https://www.hebcal.com/hebcal?${q}`);
  if (!res.ok) return; // ממשיכים עם המטמון
  const items: Array<{ category: string; date: string; title: string }> = ((await res.json()).items ?? [])
    .filter((x: any) => x.category === "candles" || x.category === "havdalah")
    .sort((a: any, b: any) => a.date.localeCompare(b.date));
  let open: { start: string; title: string } | null = null;
  const rows: Array<{ start_at: string; end_at: string; label: string }> = [];
  for (const it of items) {
    if (it.category === "candles" && !open) open = { start: it.date, title: it.title };
    else if (it.category === "havdalah" && open) {
      rows.push({ start_at: new Date(open.start).toISOString(), end_at: new Date(it.date).toISOString(), label: open.title });
      open = null;
    }
  }
  if (rows.length) await sb.from("quiet_windows").upsert(rows);
}

export async function isQuiet(at = new Date()): Promise<boolean> {
  const before = Number(await cfg("quiet_before_min") ?? 30), after = Number(await cfg("quiet_after_min") ?? 10);
  const { data } = await sb.from("quiet_windows").select("start_at, end_at")
    .lte("start_at", new Date(at.getTime() + before * 60_000).toISOString())
    .gte("end_at", new Date(at.getTime() - after * 60_000).toISOString()).limit(1);
  return (data ?? []).length > 0;
}

// ───────────── שליחה ─────────────
async function sendTo(partnerId: string | null, text: string, rows?: Button[][]) {
  const ps = await allPartners();
  for (const p of ps) if (!partnerId || p.id === partnerId) await send(p.telegram_chat_id!, text, rows);
}

const SERVICE_LABEL: Record<string, string> = { consultation: "ייעוץ והזמנה", regular: "תור" };

export async function runCron(): Promise<Record<string, unknown>> {
  const log: Record<string, unknown> = {};
  try { log.calendar = await calendarSync(sb); } catch (e) { log.calendar_error = String(e); }
  try { await refreshQuietWindows(); } catch (e) { log.hebcal_error = String(e); }
  if (await isQuiet()) return { ...log, quiet: true };

  const now = new Date();
  const lp = localParts(now);
  const today = lp.date;
  let n = 0;

  // 1. תזכורות מתוזמנות (claim לפני שליחה, מונע כפילות בריצות חופפות)
  const { data: due } = await sb.from("reminders").select("id, partner_id, message").is("sent_at", null).lte("remind_at", now.toISOString()).limit(20);
  for (const r of due ?? []) {
    const { data: claimed } = await sb.from("reminders").update({ sent_at: now.toISOString() }).eq("id", r.id).is("sent_at", null).select("id");
    if (!claimed?.length) continue;
    await sendTo(r.partner_id, `⏰ ${r.message}`);
    n++;
  }

  // 2. שעה לפני תור
  const in60 = new Date(now.getTime() + 60 * 60_000);
  const { data: soon } = await sb.from("appointments").select("id, kind, service, title, starts_at, notes, customer_id, customers(full_name, phone)")
    .in("kind", ["regular", "consultation"]).is("reminded_at", null).gt("starts_at", now.toISOString()).lte("starts_at", in60.toISOString());
  for (const a of (soon ?? []) as any[]) {
    const { data: claimed } = await sb.from("appointments").update({ reminded_at: now.toISOString() }).eq("id", a.id).is("reminded_at", null).select("id");
    if (!claimed?.length) continue;
    let extra = "";
    if (a.customer_id) {
      const { data: f } = await sb.from("customer_financials").select("total_due").eq("customer_id", a.customer_id).maybeSingle();
      if (f && Number(f.total_due) > 0) extra = `\n💰 יתרה פתוחה: ${money(f.total_due)}`;
    }
    const mins = Math.max(Math.round((new Date(a.starts_at).getTime() - now.getTime()) / 60000), 1);
    await sendTo(null, `🗓 בעוד ${mins} דקות (${fmtTime(a.starts_at)}): ${a.title}${a.customers?.phone ? `\n📞 ${a.customers.phone}` : ""}${extra}${a.notes ? `\n📝 ${a.notes}` : ""}`);
    n++;
  }

  // 3. תזכורת יום לפני (מ-18:00) + נוסח וואטסאפ ללקוחה
  if (lp.h >= 18) {
    const tStart = localToUtc(addDays(today, 1)), tEnd = localToUtc(addDays(today, 2));
    const { data: tom } = await sb.from("appointments").select("id, kind, service, starts_at, customers(full_name, phone)")
      .in("kind", ["regular", "consultation"]).eq("daybefore_sent", false).not("customer_id", "is", null)
      .gte("starts_at", tStart.toISOString()).lt("starts_at", tEnd.toISOString()).order("starts_at");
    for (const a of (tom ?? []) as any[]) {
      const { data: claimed } = await sb.from("appointments").update({ daybefore_sent: true }).eq("id", a.id).eq("daybefore_sent", false).select("id");
      if (!claimed?.length) continue;
      const first = String(a.customers?.full_name ?? "").split(" ")[0];
      const svc = a.service ?? SERVICE_LABEL[a.kind] ?? "תור";
      const draft = `היי ${first} 🌸 מזכירה שמחר בשעה ${fmtTime(a.starts_at)} יש לנו ${svc}. מחכה לך! אם משהו משתנה, תכתבי לי.`;
      const link = waLink(a.customers?.phone, draft);
      await sendTo(null, `📲 מחר ב-${fmtTime(a.starts_at)}: ${a.customers?.full_name}, ${svc}\n\nנוסח לוואטסאפ ללקוחה:\n${draft}`, link ? [[{ text: "📲 פתיחה בוואטסאפ", url: link }]] : undefined);
      n++;
    }
  }

  // 4. אחרי תור: מה סוכם + תזכורת לתור חוזר
  if (lp.h >= 7 && lp.h < 23) {
    const { data: done } = await sb.from("appointments").select("id, title, customer_id, ends_at")
      .in("kind", ["regular", "consultation"]).eq("followup_sent", false).not("customer_id", "is", null)
      .lte("ends_at", now.toISOString()).gte("ends_at", new Date(now.getTime() - 3 * 3600_000).toISOString());
    for (const a of done ?? []) {
      const { data: claimed } = await sb.from("appointments").update({ followup_sent: true }).eq("id", a.id).eq("followup_sent", false).select("id");
      if (!claimed?.length) continue;
      await sendTo(null, `✅ ${a.title} הסתיים. ספרי לי מה נעשה ואשמור בהיסטוריה של הלקוחה (ואם שולמה, כמה).\nלתזכר אותך לתאם תור חוזר?`, [[
        { text: "🔁 4 שבועות", data: `rb:${a.customer_id}:4` }, { text: "🔁 6 שבועות", data: `rb:${a.customer_id}:6` }, { text: "🔁 8 שבועות", data: `rb:${a.customer_id}:8` },
      ], [{ text: "👍 לא צריך", data: "ok" }]]);
      n++;
    }
  }

  // 5. משימות להיום / באיחור (פעם ביום מ-08:00)
  if (lp.h >= 8) {
    const { data: tasks } = await sb.from("tasks").select("id, title, due_date").neq("status", "done").lte("due_date", today)
      .or(`reminded_on.is.null,reminded_on.lt.${today}`).limit(5);
    for (const t of tasks ?? []) {
      const { data: claimed } = await sb.from("tasks").update({ reminded_on: today }).eq("id", t.id).select("id");
      if (!claimed?.length) continue;
      await sendTo(null, `📌 ${t.due_date < today ? "באיחור" : "להיום"}: ${t.title}`, [[
        { text: "✅ בוצע", data: `done:${t.id}` }, { text: "מחר", data: `snz:${t.id}:1` }, { text: "שבוע הבא", data: `snz:${t.id}:7` },
      ]]);
      n++;
    }
  }

  // 6. גבייה: הזמנות שנמסרו ויש עליהן יתרה (פעם בשבוע, מ-10:00)
  if (lp.h >= 10) {
    const last = await cfg("balance_nudge_sent");
    if (!last || last <= addDays(today, -7)) {
      const { data: late } = await sb.from("order_financials").select("customer_id, title, balance_due, delivered_at")
        .eq("status", "delivered").gt("balance_due", 0).lte("delivered_at", addDays(today, -3));
      if (late?.length) {
        const { data: cs } = await sb.from("customers").select("id, full_name").in("id", late.map((x) => x.customer_id));
        const names = new Map((cs ?? []).map((c) => [c.id, c.full_name]));
        await setCfg("balance_nudge_sent", today);
        await sendTo(null, "💰 יתרות שעדיין לא שולמו אחרי מסירה:\n" + late.map((x) => `• ${names.get(x.customer_id)}: ${money(x.balance_due)} (${x.title})`).join("\n") + "\n\nרוצה נוסח לוואטסאפ לתזכורת תשלום? כתבי לי למי.");
        n++;
      }
    }
  }

  // 7. סיכום שבועי: ראשון מ-08:00
  if (lp.dow === 0 && lp.h >= 8 && (await cfg("weekly_summary_sent")) !== today) {
    await setCfg("weekly_summary_sent", today);
    const from = addDays(today, -7), to = addDays(today, -1);
    const s = await financialSummary(from, to) as any;
    const b = await openBalances();
    const { count } = await sb.from("appointments").select("id", { count: "exact", head: true })
      .in("kind", ["regular", "consultation"]).gte("starts_at", localToUtc(today).toISOString()).lt("starts_at", localToUtc(addDays(today, 7)).toISOString());
    await sendTo(null, `📊 סיכום שבועי (${from} עד ${to})\nהכנסות: ${money(s.income)}\nהוצאות: ${money(s.expenses)}\nנטו: ${money(s.net)}\n\n💰 יתרות פתוחות מלקוחות: ${money(b.total_due)}\n🗓 תורים השבוע הקרוב: ${count ?? 0}\n\nשבוע טוב! 🌸`);
    n++;
  }

  // 8. סיכום חודשי לרואת החשבון: ב-1 לחודש מ-09:00
  const ym = today.slice(0, 7);
  if (lp.d === 1 && lp.h >= 9 && (await cfg("monthly_summary_sent")) !== ym) {
    await setCfg("monthly_summary_sent", ym);
    const prevEnd = addDays(today, -1), prevStart = prevEnd.slice(0, 8) + "01";
    const s = await financialSummary(prevStart, prevEnd) as any;
    const cats = Object.entries(s.expenses_by_category as Record<string, number>).map(([k, v]) => `• ${k}: ${money(v)}`).join("\n");
    await sendTo(null, `🧾 סיכום חודשי לרואת החשבון (${prevStart.slice(0, 7)})\nהכנסות: ${money(s.income)}\nהוצאות: ${money(s.expenses)}\nנטו: ${money(s.net)}\n\nהוצאות לפי קטגוריה:\n${cats || "אין"}\n\n${s.expenses_missing_invoice_number ? `⚠️ ל-${s.expenses_missing_invoice_number} הוצאות חסר מספר חשבונית.\n` : ""}רוצה שאמצא חשבוניות חסרות ב-Gmail? כתבי "תמצאי חשבוניות".`);
    n++;
  }

  return { ...log, sent: n };
}
