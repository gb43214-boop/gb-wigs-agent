// gcal.ts — סנכרון דו-כיווני בין טבלת appointments ליומן "GB Wigs" בגוגל
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { accessToken, gfetch } from "./google.ts";
import { localParts, localToUtc, TZ } from "./util.ts";

const CAL = "https://www.googleapis.com/calendar/v3";
export const CALENDAR_NAME = "GB Wigs";
const COLOR: Record<string, string> = { consultation: "3", regular: "10", focus: "8", away: "11" };

async function cfg(sb: SupabaseClient, key: string): Promise<string | null> {
  const { data } = await sb.from("app_config").select("value").eq("key", key).maybeSingle();
  return data?.value ?? null;
}
async function setCfg(sb: SupabaseClient, key: string, value: string) {
  await sb.from("app_config").upsert({ key, value, updated_at: new Date().toISOString() });
}

async function connectedPartner(sb: SupabaseClient) {
  const { data } = await sb.from("gmail_accounts").select("partner_id, scopes").limit(1).maybeSingle();
  if (!data || !(data.scopes ?? "").includes("calendar")) return null;
  return data.partner_id as string;
}

/** יוצר את היומן המשותף אם צריך. מחזיר calendarId */
export async function ensureCalendar(sb: SupabaseClient, token: string): Promise<string | null> {
  const existing = await cfg(sb, "gcal_calendar_id");
  if (existing) {
    const r = await gfetch(token, `${CAL}/calendars/${encodeURIComponent(existing)}`);
    if (r.ok) return existing;
  }
  const res = await gfetch(token, `${CAL}/calendars`, {
    method: "POST", body: JSON.stringify({ summary: CALENDAR_NAME, timeZone: TZ, description: "היומן של GB Wigs, מנוהל על ידי הבוט" }),
  });
  if (!res.ok) return null;
  const id = (await res.json()).id as string;
  await setCfg(sb, "gcal_calendar_id", id);
  return id;
}

function toEvent(a: any) {
  const body: Record<string, unknown> = {
    summary: a.title,
    description: a.notes ?? "",
    colorId: COLOR[a.kind] ?? "10",
    extendedProperties: { private: { gb: "1", appt: a.id } },
  };
  if (a.all_day) {
    body.start = { date: localParts(new Date(a.starts_at)).date };
    body.end = { date: localParts(new Date(a.ends_at)).date };
  } else {
    body.start = { dateTime: new Date(a.starts_at).toISOString(), timeZone: TZ };
    body.end = { dateTime: new Date(a.ends_at).toISOString(), timeZone: TZ };
  }
  return body;
}

function fromEventTimes(ev: any) {
  if (ev.start?.date) {
    return { all_day: true, starts_at: localToUtc(ev.start.date).toISOString(), ends_at: localToUtc(ev.end?.date ?? ev.start.date).toISOString() };
  }
  return { all_day: false, starts_at: new Date(ev.start.dateTime).toISOString(), ends_at: new Date(ev.end.dateTime).toISOString() };
}

/** סנכרון מלא: מחיקות → דחיפה → משיכה. בטוח להרצה כל דקה. */
export async function calendarSync(sb: SupabaseClient): Promise<{ pushed: number; pulled: number } | null> {
  const partnerId = await connectedPartner(sb);
  if (!partnerId) return null;
  const token = await accessToken(sb, partnerId);
  if (!token) return null;
  const calId = await ensureCalendar(sb, token);
  if (!calId) return null;
  const base = `${CAL}/calendars/${encodeURIComponent(calId)}`;
  let pushed = 0, pulled = 0;

  // 1. מחיקות שנצברו
  const { data: outbox } = await sb.from("calendar_outbox").select("id, google_event_id").limit(50);
  for (const o of outbox ?? []) {
    const r = await gfetch(token, `${base}/events/${o.google_event_id}`, { method: "DELETE" });
    if (r.ok || r.status === 404 || r.status === 410) await sb.from("calendar_outbox").delete().eq("id", o.id);
  }

  // 2. דחיפה של מה ששונה מקומית
  const { data: dirty } = await sb.from("appointments").select("*").eq("google_dirty", true).limit(40);
  for (const a of dirty ?? []) {
    let res: Response;
    if (a.google_event_id) {
      res = await gfetch(token, `${base}/events/${a.google_event_id}`, { method: "PUT", body: JSON.stringify(toEvent(a)) });
      if (res.status === 404 || res.status === 410) {
        res = await gfetch(token, `${base}/events`, { method: "POST", body: JSON.stringify(toEvent(a)) });
      }
    } else {
      res = await gfetch(token, `${base}/events`, { method: "POST", body: JSON.stringify(toEvent(a)) });
    }
    if (!res.ok) continue;
    const ev = await res.json();
    await sb.from("appointments").update({ google_event_id: ev.id, google_etag: ev.etag, google_dirty: false }).eq("id", a.id);
    pushed++;
  }

  // 3. משיכה של שינויים מגוגל
  const since = await cfg(sb, "gcal_last_pull") ?? new Date(Date.now() - 24 * 3600_000).toISOString();
  const pullStart = new Date().toISOString();
  const q = new URLSearchParams({ updatedMin: since, showDeleted: "true", singleEvents: "true", maxResults: "250" });
  const res = await gfetch(token, `${base}/events?${q}`);
  if (!res.ok) return { pushed, pulled };
  const items: any[] = (await res.json()).items ?? [];
  for (const ev of items) {
    const { data: ex } = await sb.from("appointments").select("id, google_etag, google_dirty").eq("google_event_id", ev.id).maybeSingle();
    if (ev.status === "cancelled") {
      if (ex) {
        await sb.from("appointments").delete().eq("id", ex.id);
        await sb.from("calendar_outbox").delete().eq("google_event_id", ev.id);
        pulled++;
      }
      continue;
    }
    if (!ev.start || !ev.end) continue;
    if (ex) {
      if (ex.google_etag === ev.etag || ex.google_dirty) continue;
      await sb.from("appointments").update({
        title: ev.summary ?? "אירוע", notes: ev.description ?? null,
        ...fromEventTimes(ev), google_etag: ev.etag, google_dirty: false,
      }).eq("id", ex.id);
      pulled++;
    } else if (!ev.extendedProperties?.private?.appt) {
      await sb.from("appointments").insert({
        kind: "regular", title: ev.summary ?? "אירוע", notes: ev.description ?? null,
        ...fromEventTimes(ev), google_event_id: ev.id, google_etag: ev.etag, google_dirty: false,
      });
      pulled++;
    }
  }
  await setCfg(sb, "gcal_last_pull", pullStart);
  return { pushed, pulled };
}

/** חלונות תפוסים מהיומן הראשי בגוגל (לא כולל היומן של הבוט), לבדיקת זמן פנוי */
export async function primaryBusy(sb: SupabaseClient, fromIso: string, toIso: string): Promise<Array<{ start: string; end: string }>> {
  const partnerId = await connectedPartner(sb);
  if (!partnerId) return [];
  const token = await accessToken(sb, partnerId);
  if (!token) return [];
  const res = await gfetch(token, `${CAL}/freeBusy`, {
    method: "POST", body: JSON.stringify({ timeMin: fromIso, timeMax: toIso, timeZone: TZ, items: [{ id: "primary" }] }),
  });
  if (!res.ok) return [];
  return (await res.json()).calendars?.primary?.busy ?? [];
}
