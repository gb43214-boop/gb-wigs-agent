// db.ts — לקוח Supabase (service role) ועזרי הגדרות
import { createClient } from "jsr:@supabase/supabase-js@2";

export const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

export interface Partner { id: string; name: string; telegram_chat_id: number | null }

export async function cfg(key: string): Promise<string | null> {
  const { data } = await sb.from("app_config").select("value").eq("key", key).maybeSingle();
  return data?.value ?? null;
}
export async function setCfg(key: string, value: string) {
  await sb.from("app_config").upsert({ key, value, updated_at: new Date().toISOString() });
}
export async function cfgJson<T>(key: string, fallback: T): Promise<T> {
  const v = await cfg(key);
  if (!v) return fallback;
  try { return JSON.parse(v) as T; } catch { return fallback; }
}
export async function isMultiPartner(): Promise<boolean> {
  return (await cfg("multi_partner")) === "true";
}

export async function partnerByChat(chatId: number): Promise<Partner | null> {
  const { data } = await sb.from("partners").select("id, name, telegram_chat_id").eq("telegram_chat_id", chatId).maybeSingle();
  return data;
}

/** חיבור ראשון עם קוד חד-פעמי */
export async function linkWithCode(chatId: number, code: string): Promise<Partner | null> {
  const clean = code.trim().toUpperCase();
  if (!/^[A-Z0-9]{8}$/.test(clean)) return null;
  const { data } = await sb.from("partners").select("id, name").eq("telegram_link_code", clean).maybeSingle();
  if (!data) return null;
  await sb.from("partners").update({ telegram_chat_id: chatId, telegram_link_code: null }).eq("id", data.id);
  return { id: data.id, name: data.name, telegram_chat_id: chatId };
}

export async function allPartners(): Promise<Partner[]> {
  const { data } = await sb.from("partners").select("id, name, telegram_chat_id").not("telegram_chat_id", "is", null);
  return data ?? [];
}
