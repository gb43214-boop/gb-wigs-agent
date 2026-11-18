# GB Wigs – המזכירה בטלגרם

בוט טלגרם (`@GBWigs_bot`) שמנהל לקוחות, הזמנות, יומן, כספים וחשבוניות של GB Wigs (גיטי בינט).
Supabase Edge Function אחת (Deno/TypeScript) + Postgres + pg_cron + Gemini + Google (Gmail לקריאה בלבד, Calendar).

## מבנה
```
supabase/functions/telegram-bot/
  index.ts   ניתוב, פקודות, כפתורים, שיחה עם המודל
  tools.ts   הכלים שהמודל מפעיל + הנחיות מערכת
  cron.ts    כל דקה: תזכורות, תורים, גבייה, סיכומים, שבת/חג
  gcal.ts    סנכרון דו-כיווני ליומן "GB Wigs"
  google.ts  OAuth + Gmail
  llm.ts     מעטפת מודל (להחלפת מודל/ספק)
  tg.ts, db.ts, util.ts
supabase/functions/legal/    דפי פרטיות ותנאים (למסך ההסכמה של Google)
supabase/migrations/         הסכמה (כבר הוחלה על הפרויקט Agent GB)
```

## סיקרטים (Supabase → Edge Functions → Secrets)
| שם | חובה |
|---|---|
| `TELEGRAM_BOT_TOKEN` | כן (BotFather) |
| `GEMINI_API_KEY` | כן |
| `GEMINI_MODEL` | לא (ברירת מחדל `gemini-flash-latest`, נפילה אוטומטית ל-`gemini-2.5-flash`) |
| `TELEGRAM_BOT_USERNAME` | מומלץ: `GBWigs_bot` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | ל-Gmail וליומן |
| `LLM_PROVIDER` | לא (ברירת מחדל `gemini`) |

## פריסה
```bash
supabase link --project-ref ciukldoxjmzwnmpeulob
supabase functions deploy telegram-bot --no-verify-jwt
supabase functions deploy legal --no-verify-jwt
```
אחר כך, בדפדפן (פעם אחת ואחרי כל פריסה):
`https://ciukldoxjmzwnmpeulob.supabase.co/functions/v1/telegram-bot?action=setup`

## Google Cloud
- Redirect URI בדיוק: `https://ciukldoxjmzwnmpeulob.supabase.co/functions/v1/telegram-bot/gmail/callback`
- Scopes: `gmail.readonly`, `calendar`. Publish app (ב-Testing ההרשאה פגה אחרי 7 ימים).
- פרטיות/תנאים: `.../functions/v1/legal/privacy` ו-`.../legal/terms`

## חיבור ראשון
`select name, telegram_link_code from partners;` ← שולחים את הקוד לבוט ← `/google`.

## החלפת מודל
- אותו ספק: סיקרט `GEMINI_MODEL`.
- ספק אחר: לממש את הממשק `LLM` ב-`llm.ts` ולהוסיף `case` ב-`getLLM()`.

## הרחבה
הוספת יכולת: טבלה (מיגרציה) ← הצהרה ב-`toolDeclarations` ← `case` ב-`runTool` ← משפט ב-`systemPrompt` אם צריך.
מצב שותפות: `update app_config set value='true' where key='multi_partner';` (מדליק את `get_balance` ו-`add_settlement`).
שעות קבלה ומשכי תורים: ב-`app_config` (`work_hours`, `durations`).
