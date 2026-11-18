// tg.ts — עזרי Telegram Bot API
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

const TOKEN = () => Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
export const BOT_USERNAME = () => Deno.env.get("TELEGRAM_BOT_USERNAME") ?? "GBWigs_bot";

export type Button = { text: string; data?: string; url?: string };

export async function tg(method: string, body: Record<string, unknown> = {}) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN()}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return await res.json();
}

export function splitText(text: string, max = 4000): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

/** שולח הודעה (מחולקת אם ארוכה). כפתורים: מערך של שורות. נוספים רק להודעה האחרונה. */
export async function send(chatId: number, text: string, rows?: Button[][], extra: Record<string, unknown> = {}) {
  const chunks = splitText(text || "…");
  for (let i = 0; i < chunks.length; i++) {
    const body: Record<string, unknown> = { chat_id: chatId, text: chunks[i], disable_web_page_preview: true, ...extra };
    if (rows?.length && i === chunks.length - 1) {
      body.reply_markup = {
        inline_keyboard: rows.map((r) => r.map((b) => b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data })),
      };
    }
    await tg("sendMessage", body);
  }
}

export async function typing(chatId: number) {
  await tg("sendChatAction", { chat_id: chatId, action: "typing" });
}

export async function downloadFile(fileId: string): Promise<{ bytes: Uint8Array; path: string } | null> {
  const info = await tg("getFile", { file_id: fileId });
  const path = info?.result?.file_path as string | undefined;
  if (!path) return null;
  const res = await fetch(`https://api.telegram.org/file/bot${TOKEN()}/${path}`);
  if (!res.ok) return null;
  return { bytes: new Uint8Array(await res.arrayBuffer()), path };
}

export const toBase64 = (b: Uint8Array) => encodeBase64(b);

/** ערך ה-secret של ה-Webhook: 48 התווים הראשונים של SHA-256 של הטוקן */
export async function webhookSecret(): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(TOKEN()));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 48);
}

export const MAIN_KEYBOARD = {
  keyboard: [
    [{ text: "📅 היום" }, { text: "🗓 תור חדש" }, { text: "💰 יתרות" }],
    [{ text: "💸 הוצאה" }, { text: "📋 משימות" }, { text: "👩 לקוחה חדשה" }],
  ],
  resize_keyboard: true,
  is_persistent: true,
  input_field_placeholder: "כתבי, הקליטי או שלחי חשבונית",
};

export const COMMANDS = [
  { command: "today", description: "היום שלי" },
  { command: "week", description: "7 הימים הקרובים" },
  { command: "free", description: "זמנים פנויים לתורים" },
  { command: "due", description: "יתרות פתוחות מלקוחות" },
  { command: "orders", description: "הזמנות פתוחות" },
  { command: "tasks", description: "משימות פתוחות" },
  { command: "invoices", description: "חשבוניות מ-Gmail" },
  { command: "google", description: "חיבור Google (Gmail ויומן)" },
  { command: "memory", description: "מה הבוט זוכר" },
  { command: "menu", description: "תפריט הכפתורים" },
  { command: "help", description: "דוגמאות לשימוש" },
];
