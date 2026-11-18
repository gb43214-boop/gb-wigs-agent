// google.ts — OAuth, טוקנים וגישה ל-Gmail (קריאה בלבד)
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { decodeBase64 } from "jsr:@std/encoding@1/base64";

const CLIENT_ID = () => Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
const CLIENT_SECRET = () => Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";
export const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar",
  "openid", "email",
];

export const redirectUri = () => `${Deno.env.get("SUPABASE_URL")}/functions/v1/telegram-bot/gmail/callback`;

export async function buildAuthUrl(sb: SupabaseClient, partnerId: string): Promise<string> {
  const state = crypto.randomUUID().replaceAll("-", "");
  await sb.from("gmail_oauth_states").delete().lt("created_at", new Date(Date.now() - 15 * 60_000).toISOString());
  await sb.from("gmail_oauth_states").insert({ state, partner_id: partnerId });
  const q = new URLSearchParams({
    client_id: CLIENT_ID(), redirect_uri: redirectUri(), response_type: "code",
    scope: SCOPES.join(" "), access_type: "offline", prompt: "consent", state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

/** מחליף code בטוקנים ושומר. מחזיר את השותפה ואת המייל. */
export async function handleOAuthCallback(sb: SupabaseClient, code: string, state: string) {
  const { data: st } = await sb.from("gmail_oauth_states").select("partner_id, created_at").eq("state", state).maybeSingle();
  if (!st) throw new Error("state לא תקין או שפג תוקפו");
  if (Date.now() - new Date(st.created_at).getTime() > 15 * 60_000) throw new Error("הקישור פג תוקף, בקשי קישור חדש");
  await sb.from("gmail_oauth_states").delete().eq("state", state);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: CLIENT_ID(), client_secret: CLIENT_SECRET(),
      redirect_uri: redirectUri(), grant_type: "authorization_code",
    }),
  });
  const tok = await res.json();
  if (!res.ok || !tok.refresh_token) throw new Error("גוגל לא החזיר הרשאה מלאה: " + (tok.error_description ?? tok.error ?? "חסר refresh token"));
  let email: string | null = null;
  try {
    const u = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", { headers: { Authorization: `Bearer ${tok.access_token}` } });
    email = (await u.json()).email ?? null;
  } catch { /* לא קריטי */ }
  await sb.from("gmail_accounts").upsert({
    partner_id: st.partner_id, email, refresh_token: tok.refresh_token,
    scopes: tok.scope ?? "", updated_at: new Date().toISOString(),
  });
  return { partnerId: st.partner_id as string, email, scopes: (tok.scope ?? "") as string };
}

const cache = new Map<string, { token: string; exp: number }>();

/** access token טרי; null אם אין חיבור או שההרשאה בוטלה */
export async function accessToken(sb: SupabaseClient, partnerId: string): Promise<string | null> {
  const c = cache.get(partnerId);
  if (c && c.exp > Date.now() + 60_000) return c.token;
  const { data } = await sb.from("gmail_accounts").select("refresh_token").eq("partner_id", partnerId).maybeSingle();
  if (!data) return null;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID(), client_secret: CLIENT_SECRET(),
      refresh_token: data.refresh_token, grant_type: "refresh_token",
    }),
  });
  const j = await res.json();
  if (!res.ok) {
    if (j.error === "invalid_grant") await sb.from("gmail_accounts").delete().eq("partner_id", partnerId);
    return null;
  }
  cache.set(partnerId, { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3000) * 1000 });
  return j.access_token;
}

export async function revokeAndDisconnect(sb: SupabaseClient, partnerId: string) {
  const { data } = await sb.from("gmail_accounts").select("refresh_token").eq("partner_id", partnerId).maybeSingle();
  if (data) {
    try {
      await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: data.refresh_token }),
      });
    } catch { /* ממשיכים */ }
  }
  await sb.from("gmail_accounts").delete().eq("partner_id", partnerId);
  cache.delete(partnerId);
}

export async function gfetch(token: string, url: string, init: RequestInit = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  return res;
}

// ───────────── Gmail ─────────────
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface GmailHit { id: string; from: string; subject: string; date: string; hasAttachment: boolean }

function header(msg: any, name: string): string {
  return msg.payload?.headers?.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function walk(part: any, out: { atts: any[]; text: string[]; html: string[] }) {
  if (!part) return;
  const mt: string = part.mimeType ?? "";
  if (part.filename && part.body?.attachmentId && (mt === "application/pdf" || mt.startsWith("image/"))) {
    out.atts.push({ filename: part.filename, mime: mt, attachmentId: part.body.attachmentId, size: part.body.size ?? 0 });
  } else if (mt === "text/plain" && part.body?.data) out.text.push(part.body.data);
  else if (mt === "text/html" && part.body?.data) out.html.push(part.body.data);
  for (const p of part.parts ?? []) walk(p, out);
}

export function b64urlToBytes(s: string): Uint8Array {
  let b = s.replaceAll("-", "+").replaceAll("_", "/");
  while (b.length % 4) b += "=";
  return decodeBase64(b);
}
const utf8 = (s: string) => new TextDecoder().decode(b64urlToBytes(s));
const stripHtml = (h: string) =>
  h.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

export async function searchGmail(token: string, q: string, max = 15): Promise<GmailHit[]> {
  const res = await gfetch(token, `${GMAIL}/messages?q=${encodeURIComponent(q)}&maxResults=${Math.min(max, 25)}`);
  if (!res.ok) throw new Error(`Gmail ${res.status}`);
  const ids: string[] = ((await res.json()).messages ?? []).map((m: any) => m.id);
  const hits = await Promise.all(ids.map(async (id) => {
    const r = await gfetch(token, `${GMAIL}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
    if (!r.ok) return null;
    const m = await r.json();
    return { id, from: header(m, "From"), subject: header(m, "Subject"), date: header(m, "Date"), hasAttachment: false } as GmailHit;
  }));
  return hits.filter(Boolean) as GmailHit[];
}

export interface GmailInvoice {
  id: string; from: string; subject: string; date: string;
  attachment?: { filename: string; mime: string; bytes: Uint8Array };
  bodyText: string;
}

/** קורא מייל: קובץ מצורף ראשון (PDF/תמונה, עד 15MB) + טקסט הגוף */
export async function readGmailInvoice(token: string, id: string): Promise<GmailInvoice> {
  const res = await gfetch(token, `${GMAIL}/messages/${id}?format=full`);
  if (!res.ok) throw new Error(`Gmail ${res.status}`);
  const m = await res.json();
  const out = { atts: [] as any[], text: [] as string[], html: [] as string[] };
  walk(m.payload, out);
  const inv: GmailInvoice = {
    id, from: header(m, "From"), subject: header(m, "Subject"), date: header(m, "Date"),
    bodyText: (out.text.map(utf8).join("\n") || out.html.map((h) => stripHtml(utf8(h))).join("\n")).slice(0, 6000),
  };
  const att = out.atts.find((a) => a.size <= 15 * 1024 * 1024);
  if (att) {
    const r = await gfetch(token, `${GMAIL}/messages/${id}/attachments/${att.attachmentId}`);
    if (r.ok) inv.attachment = { filename: att.filename, mime: att.mime, bytes: b64urlToBytes((await r.json()).data) };
  }
  return inv;
}
