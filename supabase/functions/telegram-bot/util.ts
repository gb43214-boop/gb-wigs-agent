// util.ts — כלי זמן ותאריך (אזור זמן ישראל)
export const TZ = "Asia/Jerusalem";
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function localParts(d: Date) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", weekday: "short",
  });
  const p: Record<string, string> = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return {
    y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute,
    date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`,
    dow: DOW.indexOf(p.weekday), // 0 = ראשון
  };
}

/** תאריך + שעה מקומיים בישראל → רגע מוחלט (UTC) */
export function localToUtc(date: string, time = "00:00"): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const want = Date.UTC(y, m - 1, d, h, mi);
  let t = want;
  for (let i = 0; i < 3; i++) {
    const lp = localParts(new Date(t));
    t += want - Date.UTC(lp.y, lp.mo - 1, lp.d, lp.h, lp.mi);
  }
  return new Date(t);
}

export function todayStr(): string { return localParts(new Date()).date; }

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function dowOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function fmtDT(d: Date | string): string {
  return new Date(d).toLocaleString("he-IL", {
    timeZone: TZ, weekday: "short", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit",
  });
}
export function fmtTime(d: Date | string): string {
  return new Date(d).toLocaleTimeString("he-IL", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
}
export function fmtDay(date: string): string {
  return localToUtc(date, "12:00").toLocaleDateString("he-IL", {
    timeZone: TZ, weekday: "long", day: "numeric", month: "numeric",
  });
}
export function nowHeader(): string {
  const n = new Date();
  const lp = localParts(n);
  const day = n.toLocaleDateString("he-IL", { timeZone: TZ, weekday: "long" });
  return `${day}, ${lp.date}, ${lp.time}`;
}

export function money(n: number | string | null | undefined): string {
  const v = Number(n ?? 0);
  return `${v.toLocaleString("he-IL", { maximumFractionDigits: 2 })} ₪`;
}

/** מספר טלפון ישראלי → קישור וואטסאפ */
export function waLink(phone?: string | null, text?: string): string | null {
  if (!phone) return null;
  let p = phone.replace(/\D/g, "");
  if (p.startsWith("0")) p = "972" + p.slice(1);
  if (p.length < 9) return null;
  return `https://wa.me/${p}` + (text ? `?text=${encodeURIComponent(text)}` : "");
}
