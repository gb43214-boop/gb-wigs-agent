// legal/index.ts — דפי פרטיות ותנאים ציבוריים (נדרשים למסך ההסכמה של Google)
const page = (title: string, body: string) =>
  new Response(`<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:sans-serif;max-width:680px;margin:2rem auto;padding:0 1rem;line-height:1.7"><h1>${title}</h1>${body}</body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } });

Deno.serve((req) => {
  const p = new URL(req.url).pathname;
  if (p.endsWith("/terms")) {
    return page("תנאי שימוש – GB Wigs", `<p>האפליקציה היא כלי פנימי פרטי של העסק GB Wigs (גיטי בינט) לניהול לקוחות, הזמנות, יומן וכספים, ואינה מיועדת לציבור.</p><p>השימוש מותר לבעלת העסק בלבד. השירות ניתן כפי שהוא (as is).</p>`);
  }
  return page("מדיניות פרטיות – GB Wigs", `<p>האפליקציה היא כלי פנימי של העסק GB Wigs (גיטי בינט), בבעלות ובשימוש של בעלת העסק בלבד.</p>
<h3>איזה מידע ניגש אליו</h3><ul><li>Gmail: קריאה בלבד, לזיהוי חשבוניות וקבלות מספקים בבקשת המשתמשת. לא נשלחים, נמחקים או משתנים מיילים.</li><li>Google Calendar: יצירה וסנכרון של יומן העסק "GB Wigs", וקריאת מצב תפוס/פנוי מהיומן הראשי.</li></ul>
<h3>איך המידע נשמר</h3><p>המידע נשמר במסד נתונים פרטי של בעלת העסק ב-Supabase. הוא לא נמכר ולא משותף עם צד שלישי, מלבד העברת תוכן הודעות וקבצים שהמשתמשת שולחת לשירות הבינה המלאכותית (Google Gemini) לצורך עיבודם.</p>
<h3>ביטול הרשאה</h3><p>אפשר לנתק בכל עת דרך הבוט או דרך הגדרות החשבון של Google.</p>`);
});
