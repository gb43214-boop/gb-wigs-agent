// tools.ts — הכלים שהמודל מפעיל, המימוש שלהם, והנחיות המערכת
// להוספת יכולת: הצהרה ב-toolDeclarations + case ב-runTool (+ משפט ב-systemPrompt אם צריך כלל התנהגות).
import { cfg, cfgJson, isMultiPartner, type Partner, sb } from "./db.ts";
import { addDays, dowOf, fmtDT, fmtTime, localParts, localToUtc, money, nowHeader, todayStr } from "./util.ts";
import { type Button } from "./tg.ts";
import { type Media, type ToolDecl, getLLM } from "./llm.ts";
import { accessToken, connectLink, readGmailInvoice, revokeAndDisconnect, searchGmail } from "./google.ts";
import { primaryBusy } from "./gcal.ts";

export interface Ctx {
  partner: Partner;
  chatId: number;
  created: Array<{ table: string; id: string; label: string }>;
  buttons: Button[][];
}

// ───────────── עזרי סכמה ─────────────
const S = (description: string) => ({ type: "string", description });
const N = (description: string) => ({ type: "number", description });
const B = (description: string) => ({ type: "boolean", description });
const E = (description: string, values: string[]) => ({ type: "string", description, enum: values });
const O = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });

const DATE = "תאריך בפורמט YYYY-MM-DD";
const KINDS_ORDER = ["custom_wig", "top_lace", "stock_match", "repair", "other"];
const KINDS_TREAT = ["wash_style", "cut_fit", "repair", "fitting", "delivery", "consultation", "other"];
const ORDER_STATUS = ["consultation", "ordered", "in_progress", "ready", "delivered", "cancelled"];
const UNDO_TABLES = ["customers", "orders", "income", "expenses", "treatments", "appointments", "tasks", "reminders", "bot_memories", "settlements"];

export async function toolDeclarations(): Promise<ToolDecl[]> {
  const tools: ToolDecl[] = [
    {
      name: "find_customer",
      description: "מחפש לקוחה לפי שם או טלפון ומחזיר כרטיס מלא: פרטים, מידות, הזמנות עם מצב כספי, טיפולים אחרונים ותורים קרובים. להשתמש לפני כל פעולה על לקוחה קיימת ובכל שאלה 'מה המצב עם X'.",
      parameters: O({ query: S("שם או חלק משם או טלפון") }, ["query"]),
    },
    {
      name: "save_customer",
      description: "יוצר לקוחה חדשה או מעדכן לקוחה קיימת (לפי שם מדויק או customer_id). לשלוח רק שדות שנמסרו.",
      parameters: O({
        customer_id: S("מזהה לקוחה קיימת (אם ידוע)"), full_name: S("שם מלא"), phone: S("טלפון"), email: S("מייל"), city: S("עיר"),
        event_type: S("סוג אירוע, למשל חתונה, בר מצווה"), event_date: S(DATE + " של האירוע"),
        hair_type: S("סוג שיער"), hair_color: S("צבע / גוון"),
        measurements: S("מידות ראש במלואן כטקסט חופשי (היקף, קדמי-עורפי, אוזן לאוזן וכו'). מחליף את הקיים, לכן לשלוח הכול"),
        wig_spec: S("מפרט הפיאה: אורך, צפיפות, קו שיער, סוג בסיס וכו'"), notes: S("הערות"),
      }),
    },
    {
      name: "add_order",
      description: "פותח הזמנה ללקוחה (יוצר לקוחה אם אינה קיימת). אפשר לציין מקדמה ששולמה כבר עכשיו והיא תירשם כהכנסה.",
      parameters: O({
        customer: S("שם הלקוחה"), kind: E("סוג: custom_wig פיאה בהזמנה, top_lace טופ לייס, stock_match התאמת שיער ממלאי, repair תיקון, other אחר", KINDS_ORDER),
        title: S("תיאור קצר של ההזמנה"), price: N("מחיר מוסכם בשקלים"), deposit: N("מקדמה ששולמה עכשיו (אם שולמה)"),
        deposit_method: S("אמצעי תשלום של המקדמה (מזומן, ביט, העברה...)"), due_date: S(DATE + " ליעד מסירה"),
        spec: S("מפרט"), notes: S("הערות"),
      }, ["customer", "title"]),
    },
    {
      name: "update_order",
      description: "מעדכן הזמנה: סטטוס (consultation, ordered, in_progress, ready, delivered, cancelled), מחיר, יעד, מפרט. מזהים לפי order_id או לפי שם לקוחה. מחזיר יתרה לתשלום.",
      parameters: O({
        order_id: S("מזהה הזמנה"), customer: S("שם הלקוחה (אם אין order_id)"), title_query: S("חלק מתיאור ההזמנה לדיוק"),
        status: E("סטטוס חדש", ORDER_STATUS), price: N("מחיר חדש"), due_date: S(DATE), spec: S("מפרט"), notes: S("הערות"),
      }),
    },
    {
      name: "list_orders",
      description: "רשימת הזמנות עם מחיר, שולם ויתרה. ברירת מחדל: הזמנות פתוחות (לא נמסרו ולא בוטלו).",
      parameters: O({ status: E("open (ברירת מחדל), all, או סטטוס ספציפי", ["open", "all", ...ORDER_STATUS]), customer: S("סינון לפי לקוחה") }),
    },
    {
      name: "add_income",
      description: "רושם תשלום שהתקבל (מקדמה, יתרה או תשלום). אם צוינה לקוחה ויש לה הזמנה אחת פתוחה, מקשר אליה. מחזיר את היתרה שנשארה.",
      parameters: O({
        amount: N("סכום בשקלים"), date: S(DATE + " (ברירת מחדל היום)"), customer: S("שם הלקוחה"), order_id: S("מזהה הזמנה"),
        kind: E("deposit מקדמה, balance יתרה, payment תשלום רגיל", ["deposit", "balance", "payment"]),
        method: S("אמצעי תשלום"), invoice_number: S("מספר חשבונית/קבלה מסאמיט"), notes: S("הערות"),
      }, ["amount"]),
    },
    {
      name: "add_expense",
      description: "רושם הוצאה (ספקים, חומרי גלם, ציוד, נסיעות, פרסום ועוד). אפשר לקשר להזמנה/לקוחה, ולצרף קבלה שנשמרה (receipt_path) או מייל (gmail_message_id).",
      parameters: O({
        amount: N("סכום בשקלים"), vendor: S("ספק"), description: S("תיאור"), category: S("קטגוריה: חומרי גלם, ציוד, משלוחים, נסיעות, פרסום, תוכנה, אחר"),
        date: S(DATE), order_id: S("מזהה הזמנה אם ההוצאה שייכת להזמנה"), customer: S("שם לקוחה אם ההוצאה שייכת להזמנה שלה"),
        invoice_number: S("מספר חשבונית"), receipt_path: S("נתיב קובץ הקבלה ששמור בשיחה"), gmail_message_id: S("מזהה מייל"), notes: S("הערות"),
      }, ["amount"]),
    },
    {
      name: "list_transactions",
      description: "רשימת הכנסות ו/או הוצאות בטווח תאריכים, עם סכום כולל. אפשר לסנן לפי לקוחה או ספק.",
      parameters: O({
        type: E("income, expense או both", ["income", "expense", "both"]), from: S(DATE), to: S(DATE),
        customer: S("סינון לפי לקוחה"), vendor: S("סינון לפי ספק"), limit: N("מקסימום שורות (ברירת מחדל 40)"),
      }, ["type"]),
    },
    {
      name: "open_balances",
      description: "מי חייבת לי כסף: יתרות פתוחות לפי לקוחה והזמנה, כולל אם ההזמנה כבר נמסרה.",
      parameters: O({}),
    },
    {
      name: "financial_summary",
      description: "סיכום כספי לתקופה: הכנסות, הוצאות, רווח, הוצאות לפי קטגוריה, וכמה הוצאות חסרות מספר חשבונית. עם group_by=order מחזיר רווח לפי הזמנה.",
      parameters: O({ from: S(DATE), to: S(DATE), group_by: E("none (ברירת מחדל) או order לרווח לפי הזמנה", ["none", "order"]) }, ["from", "to"]),
    },
    {
      name: "log_treatment",
      description: "רושם טיפול או תיקון בהיסטוריית הלקוחה (חפיפה, גזירה, התאמה, תיקון, מסירה). אפשר לבקש תזכורת לתור חוזר אחרי X שבועות.",
      parameters: O({
        customer: S("שם הלקוחה"), kind: E("סוג טיפול", KINDS_TREAT), date: S(DATE + " (ברירת מחדל היום)"),
        notes: S("מה נעשה ופרטים"), order_id: S("מזהה הזמנה קשורה"), rebook_weeks: N("תזכורת לקבוע תור חוזר בעוד כמה שבועות"),
      }, ["customer", "kind"]),
    },
    {
      name: "add_appointment",
      description: "קובע אירוע ביומן. kind: regular תור רגיל (חצי שעה), consultation ייעוץ והזמנה (שעה), focus בלוק עבודה אישי, away לא זמינה (יום שלם). מחזיר התנגשויות ואזהרות (מחוץ לשעות קבלה). אם צוינה לקוחה שלא קיימת היא נוצרת.",
      parameters: O({
        kind: E("סוג האירוע", ["regular", "consultation", "focus", "away"]), service: S("סוג השירות: התאמה וגזירה, חפיפה וסטיילינג, איסוף, מסירה, ייעוץ..."),
        customer: S("שם הלקוחה"), date: S(DATE), time: S("שעה HH:mm (לא נדרש ליום שלם)"), duration_min: N("משך בדקות (אחרת לפי סוג)"),
        all_day: B("יום שלם"), end_date: S(DATE + " אחרון, ללא זמינות רב-יומית"), title: S("כותרת (אם לא לקוחה)"), notes: S("הערות"),
        order_id: S("מזהה הזמנה קשורה"),
      }, ["date"]),
    },
    {
      name: "update_appointment",
      description: "מזיז, משנה או מבטל אירוע ביומן. מזהים לפי appointment_id או לפי לקוחה+תאריך. ביטול דורש אישור מפורש (confirmed=true רק אחרי שהיא אישרה).",
      parameters: O({
        appointment_id: S("מזהה"), customer: S("שם הלקוחה"), on_date: S(DATE + " של התור הקיים"),
        new_date: S(DATE), new_time: S("HH:mm"), new_duration_min: N("משך חדש"), new_service: S("שירות חדש"), notes: S("הערות"),
        cancel: B("לבטל את התור"), confirmed: B("היא אישרה במפורש את הביטול"),
      }),
    },
    {
      name: "list_schedule",
      description: "מציג תורים, אירועים, תזכורות ומשימות לפי יעד בטווח תאריכים. מחזיר גם מזהים.",
      parameters: O({ from: S(DATE), to: S(DATE) }, ["from", "to"]),
    },
    {
      name: "find_free_time",
      description: "מוצא זמנים פנויים לתור לפי שעות הקבלה, התורים הקיימים והיומן האישי בגוגל. עד 2 הצעות ליום.",
      parameters: O({
        service: E("regular (חצי שעה) או consultation (שעה)", ["regular", "consultation"]), from: S(DATE + " (ברירת מחדל היום)"),
        days_ahead: N("כמה ימים קדימה (ברירת מחדל 10)"),
      }),
    },
    {
      name: "add_task",
      description: "יוצר משימה (למשל: להזמין חומר מספק, לחזור ללקוחה). אפשר לקשר ללקוחה/הזמנה.",
      parameters: O({
        title: S("כותרת"), description: S("פירוט"), due_date: S(DATE), priority: N("1 גבוהה, 2 רגילה, 3 נמוכה"),
        customer: S("שם לקוחה"), order_id: S("מזהה הזמנה"),
      }, ["title"]),
    },
    {
      name: "update_task",
      description: "מעדכן משימה: סטטוס (todo, in_progress, done), תאריך, עדיפות, כותרת. מזהים לפי task_id או חלק מהכותרת.",
      parameters: O({
        task_id: S("מזהה"), title_query: S("חלק מהכותרת"), status: E("סטטוס", ["todo", "in_progress", "done"]),
        due_date: S(DATE), priority: N("1-3"), title: S("כותרת חדשה"),
      }),
    },
    {
      name: "list_tasks",
      description: "משימות פתוחות (או לפי סטטוס), ממוינות לפי יעד.",
      parameters: O({ status: E("open (ברירת מחדל), done, all", ["open", "done", "all"]) }),
    },
    {
      name: "add_reminder",
      description: "תזכורת מתוזמנת שתישלח אלייך בטלגרם בזמן. אפשר גם בקול.",
      parameters: O({ message: S("מה להזכיר"), when: S("מתי, בפורמט 'YYYY-MM-DD HH:mm' בשעון ישראל") }, ["message", "when"]),
    },
    {
      name: "remember_fact",
      description: "שומר בזיכרון לטווח ארוך עובדה, העדפה או החלטה ('תזכרי ש...'). אסור לשמור סיסמאות, מפתחות או מספרי כרטיס אשראי.",
      parameters: O({ content: S("מה לזכור, במשפט ברור"), kind: E("סוג", ["fact", "preference", "person", "order", "decision"]) }, ["content"]),
    },
    {
      name: "forget_fact",
      description: "מוחק פריט מהזיכרון לפי מילות חיפוש. תיקון = מחיקה ושמירה מחדש.",
      parameters: O({ query: S("חלק מהטקסט של הזיכרון") }, ["query"]),
    },
    { name: "connect_google", description: "שולח כפתור לחיבור Google (Gmail לקריאה בלבד + יומן). להשתמש כשמבקשת לחבר או כשאין חיבור.", parameters: O({}) },
    { name: "disconnect_google", description: "מנתק את חיבור Google ומבטל את ההרשאה. רק אחרי אישור מפורש.", parameters: O({ confirmed: B("אושר במפורש") }) },
    {
      name: "search_gmail_invoices",
      description: "מחפש ב-Gmail חשבוניות/קבלות מספקים (שאילתת חיפוש של Gmail, למשל: 'from:vendor after:2026/11/01 has:attachment'). מסמן מה כבר נרשם.",
      parameters: O({ query: S("שאילתת Gmail"), max: N("עד כמה תוצאות (ברירת מחדל 15)") }, ["query"]),
    },
    {
      name: "read_gmail_invoice",
      description: "קורא חשבונית ממייל מסוים: שומר את הקובץ כקבלה ומחלץ ספק, סכום, מטבע, תאריך ומספר חשבונית. לא רושם הוצאה: להציג לה ולרשום רק אחרי אישור.",
      parameters: O({ message_id: S("מזהה המייל מתוצאות החיפוש") }, ["message_id"]),
    },
    {
      name: "delete_record",
      description: "מוחק רשומה. רק אחרי שהיא אישרה במפורש (confirmed=true). הקפדה: מחיקת לקוחה מוחקת גם את ההזמנות והטיפולים שלה.",
      parameters: O({ table: E("טבלה", UNDO_TABLES), id: S("מזהה"), confirmed: B("אושר במפורש") }, ["table", "id"]),
    },
  ];

  if (await isMultiPartner()) {
    tools.push(
      {
        name: "get_balance",
        description: "התחשבנות בין השותפות: מי שילמה ומי קיבלה, רווח העסק, ומי חייבת למי כדי לאזן שווה בשווה.",
        parameters: O({}),
      },
      {
        name: "add_settlement",
        description: "רושם העברת כסף בין השותפות (התחשבנות).",
        parameters: O({ from_name: S("מי העבירה"), to_name: S("מי קיבלה"), amount: N("סכום"), date: S(DATE), notes: S("הערות") }, ["from_name", "to_name", "amount"]),
      },
    );
  }
  return tools;
}

// ───────────── הנחיות מערכת ─────────────
export async function systemPrompt(partner: Partner): Promise<string> {
  const { data: mem } = await sb.from("bot_memories").select("kind, content")
    .or(`partner_id.eq.${partner.id},partner_id.is.null`).order("created_at", { ascending: false }).limit(80);
  const memories = (mem ?? []).map((m) => `- (${m.kind}) ${m.content}`).join("\n") || "(אין עדיין)";
  const hours = await cfg("work_hours");
  const multi = await isMultiPartner();
  return `את מאיה, המזכירה של ${partner.name} ב-"GB Wigs" (גיטי בינט), עסק בבני ברק לפיאות בהזמנה, התאמה אישית, תיקונים, חפיפה וסטיילינג. את מדברת איתה בטלגרם בעברית, בלשון נקבה.

האופי שלך:
- את פרחה ישראלית חמודה עם לב זהב: חמה, מתלהבת, מפרגנת וקלילה, אבל סופר מסודרת. העבודה תמיד נעשית בדיוק.
- כל תשובה עם אימוג'ים, ובמיוחד פרחים ונצנצים: 🌸🌺🌷💐✨💖🤗💅🥰😘🙌🔥
- הפנייה הקבועה שלך לגיטי היא "אהובה" 🤗 (למשל "סגור אהובה!", "אל תדאגי אהובה"). אף פעם לא "נשמה" או "נשמה שלי". לפעמים, לגיוון, גם "מאמי", "כפרה עלייך", "יא מלכה", "בובה", אבל "אהובה" היא העיקרית.
- ביטויים בסגנון: "יאללה", "סגור!", "סבבה", "וואלה", "אין עלייך", "תותחית", "מתה עלייך", "על הכיפאק", "בכיף", "רגע, בודקת לך".
- מדי פעם, לעיתים רחוקות (בערך פעם בעשר הודעות), בקטע מצחיק ומתוק, את קוראת לגיטי "תולעת" (למשל "יאללה תולעת, סגרנו! 😂🌸" או "תולעת שלי, את תותחית 🐛💖"). רק כשהאווירה קלילה: לא כשמשהו השתבש, לא כשהיא לחוצה, ולא בנושא כסף רגיש.
- המשפט שלך: "אין על גיטי!" 💖 תגידי אותו מדי פעם, בערך פעם בכמה הודעות, בעיקר אחרי הצלחה (הזמנה חדשה, תשלום שנכנס, משימה שהושלמה). לא בכל הודעה, כדי שיישאר מיוחד.
- מפרגנת על כל הישג קטן ("וואו, עוד הזמנה! את מלכה 👑"), ומרגיעה כשמשהו מסתבך ("אל תדאגי אהובה, אני על זה 🤗🌸").
- קצרה ולעניין. האופי בפתיחה ובסגירה, והפרטים עצמם (סכומים, תאריכים, שעות, שמות) ברורים ומדויקים, אפשר בשורות נפרדות.
- נשארת מכבדת ונקייה: בלי קללות, בלי עקיצות ובלי הערות על מראה, דת או משפחה. העסק משרת לקוחות חרדיות בבני ברק.

עכשיו: ${nowHeader()} (שעון ישראל). תאריכים יחסיים ("מחר", "ביום שלישי הבא") תמיד לפי התאריך הזה.

על העסק:
- הלקוחות מגיעות לבית של ${partner.name}. תור רגיל (התאמה וגזירה, חפיפה וסטיילינג, איסוף/מסירה) נמשך חצי שעה, ייעוץ והזמנה נמשך שעה.
- שעות קבלה (0=ראשון): ${hours}. אין קבלה בשישי ובשבת. אם מבקשים תור מחוץ לשעות, ציני זאת והציעי זמן פנוי.
- כל הזמנה: מחיר מוסכם, מקדמה ויתרה. סוגי הזמנה: פיאה בהזמנה, טופ לייס, התאמת שיער ממלאי קיים, תיקון.
- חשבוניות ללקוחות מופקות בסאמיט (מחוץ לבוט). כשנרשם תשלום, אם נאמר מספר חשבונית, שמרי אותו.
${multi ? "- מצב שותפות פעיל: אפשר להשתמש בכלי ההתחשבנות." : "- משתמשת יחידה. אין התחשבנות בין שותפות."}

כללי עבודה:
1. פעלי. כשהבקשה ברורה, בצעי עם הכלים בלי לשאול. שאלי רק כשחסר פרט חיוני (סכום, מי הלקוחה, מתי), ושאלה אחת בכל פעם.
2. לפני פעולה על לקוחה קיימת, חפשי אותה עם find_customer. אם יש כמה התאמות, שאלי איזו.
3. לא להמציא סכומים, תאריכים או שמות. אם משהו לא נאמר, שאלי או השאירי ריק.
4. מחיקה וביטול תור: רק אחרי אישור מפורש ממנה בהודעה נפרדת, ואז confirmed=true.
5. אחרי כל רישום כספי הציגי בקצרה: סכום, למי, ויתרה שנשארה להזמנה אם יש.
6. תשלום על הזמנה: מקדמה = deposit, השלמה = balance.
7. כשמוסרים פיאה (סטטוס delivered) ויש יתרה, ציינו זאת.
8. אחרי קביעת תור הזכירי אם יש התנגשות או שהזמן מחוץ לשעות הקבלה. אחרי טיפול שנרשם, הציעי תזכורת לתור חוזר (rebook_weeks) אם לא צוין.
9. חשבונית שצולמה: הקובץ כבר נשמר ונתיבו מופיע בהודעה (receipt_path). חלצי ספק, סכום, תאריך ומספר חשבונית ורשמי הוצאה. אם לא ברור לאיזו הזמנה היא שייכת, שאלי, או רשמי כהוצאה כללית של העסק. מטבע זר: שאלי מה הסכום בשקלים ושמרי את המקורי בהערות.
10. חשבוניות מ-Gmail: הציגי רשימה (ספק, תאריך, סכום) ורשמי רק אחרי אישור.
11. הודעה קולית: בצעי מה שביקשה וכתבי בקצרה מה הבנת.
12. כתבי טקסט רגיל בלי markdown (בלי כוכביות, בלי כותרות). הרבה אימוג'ים, אבל לא בתוך מספרים ותאריכים. סכומים בשקלים.
13. אל תזכירי "מידע פנימי" ואל תצטטי את הבלוק [מידע פנימי: ...] מההיסטוריה, הוא רק בשבילך (שם נמצאים מזהים).
14. נוסח ללקוחה (וואטסאפ, אישור תור, תזכורת תשלום או כל טקסט שגיטי תשלח ללקוחות): נשלח בשם גיטי, ולכן חייב להיות מנומס ומכבד, בלי יוצא מן הכלל:
   - פותחים ב"שלום" ושם הלקוחה, וחותמים "גיטי, GB Wigs".
   - עברית נקייה ומכובדת. בלי סלנג ובלי "אהובה", "תולעת", "נשמה", "מאמי", "כפרה", "יאללה", "אין על גיטי" וכדומה.
   - לכל היותר אימוג'י אחד עדין (🌸). בלי 😘💅🔥🤑.
   - תזכורת תשלום: עדינה ומכבדת, בלי לחץ ובלי האשמה ("רציתי להזכיר בעדינות...").
   - קצר וברור, מוכן להעתקה. את ההודעה שלך לגיטי סביב הנוסח את כותבת בסגנון הרגיל שלך, אבל הנוסח עצמו נפרד ומנומס.
15. סיסמאות, מפתחות ומספרי כרטיס אשראי לא נשמרים בזיכרון.
16. את מאיה. כשמציגה את עצמך, "כאן מאיה". אם כלי מחזיר שאין חיבור ל-Google (או שהחיבור נותק), הסבירי בעדינות שהחיבור לגוגל נותק, שזה קורה מדי פעם ואין בזה בעיה, הפעילי connect_google וכתבי את 4 השלבים שהוא מחזיר בשפה פשוטה.

מה זכור על העסק:
${memories}`;
}

// ───────────── עזרים ─────────────
const ilikeEsc = (s: string) => s.replace(/[%,()]/g, " ").trim();

async function findCustomers(q: string) {
  const t = ilikeEsc(q);
  const { data } = await sb.from("customers").select("*").eq("archived", false)
    .or(`full_name.ilike.%${t}%,phone.ilike.%${t}%`).order("created_at", { ascending: false }).limit(8);
  return data ?? [];
}

async function ensureCustomer(name: string): Promise<{ id: string; full_name: string; created: boolean }> {
  const exact = await sb.from("customers").select("id, full_name").ilike("full_name", ilikeEsc(name)).limit(1);
  if (exact.data?.length) return { ...exact.data[0], created: false };
  const found = await findCustomers(name);
  if (found.length === 1) return { id: found[0].id, full_name: found[0].full_name, created: false };
  if (found.length > 1) throw new Error(`יש כמה לקוחות שמתאימות ל"${name}": ${found.map((c) => c.full_name).join(", ")}. שאלי איזו.`);
  const { data, error } = await sb.from("customers").insert({ full_name: name.trim() }).select("id, full_name").single();
  if (error) throw error;
  return { ...data, created: true };
}

async function customerId(name: string): Promise<string | null> {
  const found = await findCustomers(name);
  if (found.length === 1) return found[0].id;
  if (found.length > 1) throw new Error(`יש כמה לקוחות שמתאימות ל"${name}": ${found.map((c) => c.full_name).join(", ")}. שאלי איזו.`);
  return null;
}

async function resolveOrder(a: any): Promise<{ id: string; customer_id: string; title: string } | { error: string; orders?: unknown[] }> {
  if (a.order_id) {
    const { data } = await sb.from("orders").select("id, customer_id, title").eq("id", a.order_id).maybeSingle();
    return data ?? { error: "לא נמצאה הזמנה עם המזהה הזה" };
  }
  if (!a.customer) return { error: "צריך order_id או שם לקוחה" };
  const cid = await customerId(a.customer);
  if (!cid) return { error: `לא נמצאה לקוחה בשם "${a.customer}"` };
  let q = sb.from("orders").select("id, customer_id, title, status").eq("customer_id", cid).not("status", "in", "(cancelled)").order("created_at", { ascending: false });
  if (a.title_query) q = q.ilike("title", `%${ilikeEsc(a.title_query)}%`);
  const { data } = await q;
  const open = (data ?? []).filter((o) => o.status !== "delivered");
  const pool = open.length ? open : (data ?? []);
  if (pool.length === 1) return pool[0];
  if (pool.length === 0) return { error: "אין ללקוחה הזמנות" };
  return { error: "ללקוחה יש כמה הזמנות, צריך לדעת לאיזו", orders: pool.map((o) => ({ order_id: o.id, title: o.title, status: o.status })) };
}

async function financials(orderId: string) {
  const { data } = await sb.from("order_financials").select("price, paid, balance_due, expenses, profit_so_far").eq("order_id", orderId).maybeSingle();
  return data;
}

function track(ctx: Ctx, table: string, id: string, label: string) { ctx.created.push({ table, id, label }); }

const SECRET_RE = /(\b\d{13,19}\b|סיסמ|password|api[\s_-]?key|sk-[A-Za-z0-9]{10,}|cvv)/i;

// ───────────── זמן פנוי ─────────────
async function freeSlots(service: string, fromDate: string, daysAhead: number) {
  const hours = await cfgJson<Record<string, string[][]>>("work_hours", {});
  const durs = await cfgJson<Record<string, number>>("durations", { regular: 30, consultation: 60 });
  const dur = (service === "consultation" ? durs.consultation : durs.regular) ?? 30;
  const rangeStart = localToUtc(fromDate);
  const rangeEnd = localToUtc(addDays(fromDate, daysAhead));
  const { data: appts } = await sb.from("appointments").select("starts_at, ends_at")
    .lt("starts_at", rangeEnd.toISOString()).gt("ends_at", rangeStart.toISOString());
  const busy: Array<[number, number]> = (appts ?? []).map((a) => [new Date(a.starts_at).getTime(), new Date(a.ends_at).getTime()]);
  for (const b of await primaryBusy(sb, rangeStart.toISOString(), rangeEnd.toISOString())) busy.push([new Date(b.start).getTime(), new Date(b.end).getTime()]);
  const earliest = Date.now() + 30 * 60_000;
  const out: Array<{ date: string; times: string[] }> = [];
  let total = 0;
  for (let i = 0; i < daysAhead && total < 10; i++) {
    const date = addDays(fromDate, i);
    const wins = hours[String(dowOf(date))] ?? [];
    const found: number[] = [];
    for (const [s, e] of wins) {
      const wStart = localToUtc(date, s).getTime(), wEnd = localToUtc(date, e).getTime();
      for (let t = wStart; t + dur * 60_000 <= wEnd; t += 30 * 60_000) {
        if (t < earliest) continue;
        if (busy.some(([bs, be]) => t < be && t + dur * 60_000 > bs)) continue;
        if (found.length === 0 || t - found[found.length - 1] >= 90 * 60_000) found.push(t);
        if (found.length === 2) break;
      }
      if (found.length === 2) break;
    }
    if (found.length) { out.push({ date, times: found.map((t) => localParts(new Date(t)).time) }); total += found.length; }
  }
  return { duration_min: dur, days: out };
}

export async function freeTimeText(service = "regular", days = 10): Promise<string> {
  const r = await freeSlots(service, todayStr(), days);
  if (!r.days.length) return "אוף אהובה, לא מצאתי זמנים פנויים בתקופה הקרובה 🙈 את מבוקשת! 👑";
  const lines = r.days.map((d) => {
    const lp = localToUtc(d.date, "12:00").toLocaleDateString("he-IL", { timeZone: "Asia/Jerusalem", weekday: "long", day: "numeric", month: "numeric" });
    return `${lp}: ${d.times.join(", ")}`;
  });
  return `🌸 הנה הזמנים הפנויים שלך, מאמי (${r.duration_min} דקות):\n` + lines.join("\n");
}

// ───────────── חילוץ חשבונית ─────────────
async function extractInvoice(media: Media | null, text: string) {
  const prompt = `חלצי מהחשבונית/קבלה את הפרטים והחזירי JSON בלבד, בלי הסברים ובלי backticks:
{"vendor":string|null,"amount":number|null,"currency":string|null,"date":"YYYY-MM-DD"|null,"invoice_number":string|null}
amount הוא הסכום הכולל לתשלום. currency קוד (ILS, USD, EUR...).${text ? "\n\nטקסט המייל:\n" + text : ""}`;
  const r = await getLLM().generate("את מחלצת נתונים ממסמכים. מחזירה JSON בלבד.", [{ role: "user", text: prompt, media: media ? [media] : undefined }], []);
  try { return JSON.parse(r.text.replace(/```json|```/g, "").trim()); } catch { return { raw: r.text.slice(0, 300) }; }
}

// ───────────── מימוש הכלים ─────────────
export async function runTool(name: string, a: any, ctx: Ctx): Promise<unknown> {
  const today = todayStr();
  switch (name) {
    case "find_customer": {
      const list = await findCustomers(a.query);
      if (!list.length) return { found: 0 };
      const out = [];
      for (const c of list.slice(0, 5)) {
        const [ord, tr, ap] = await Promise.all([
          sb.from("order_financials").select("order_id, title, kind, status, price, paid, balance_due, due_date").eq("customer_id", c.id),
          sb.from("treatments").select("date, kind, notes").eq("customer_id", c.id).order("date", { ascending: false }).limit(5),
          sb.from("appointments").select("id, starts_at, title").eq("customer_id", c.id).gte("ends_at", new Date().toISOString()).order("starts_at").limit(3),
        ]);
        out.push({
          customer_id: c.id, name: c.full_name, phone: c.phone, city: c.city, event: [c.event_type, c.event_date].filter(Boolean).join(" "),
          hair_type: c.hair_type, hair_color: c.hair_color, measurements: c.head_measurements?.text ?? null, wig_spec: c.wig_spec, notes: c.notes,
          orders: ord.data, recent_treatments: tr.data,
          upcoming: (ap.data ?? []).map((x) => ({ appointment_id: x.id, when: fmtDT(x.starts_at), title: x.title })),
        });
      }
      return { found: list.length, customers: out };
    }

    case "save_customer": {
      const fields: Record<string, unknown> = {};
      for (const k of ["full_name", "phone", "email", "city", "event_type", "hair_type", "hair_color", "wig_spec", "notes"]) if (a[k] !== undefined) fields[k] = a[k];
      if (a.event_date) fields.event_date = a.event_date;
      if (a.measurements !== undefined) fields.head_measurements = { text: a.measurements };
      let id: string | null = a.customer_id ?? null;
      if (!id && a.full_name) {
        const ex = await sb.from("customers").select("id").ilike("full_name", ilikeEsc(a.full_name)).limit(1);
        id = ex.data?.[0]?.id ?? null;
      }
      if (id) {
        const { error } = await sb.from("customers").update(fields).eq("id", id);
        if (error) throw error;
        return { updated: true, customer_id: id };
      }
      if (!a.full_name) return { error: "חסר שם לקוחה" };
      const { data, error } = await sb.from("customers").insert(fields).select("id").single();
      if (error) throw error;
      track(ctx, "customers", data.id, `לקוחה ${a.full_name}`);
      return { created: true, customer_id: data.id };
    }

    case "add_order": {
      const c = await ensureCustomer(a.customer);
      if (c.created) track(ctx, "customers", c.id, `לקוחה ${c.full_name}`);
      const { data: o, error } = await sb.from("orders").insert({
        customer_id: c.id, kind: a.kind ?? "custom_wig", title: a.title, price: a.price ?? 0,
        due_date: a.due_date ?? null, spec: a.spec ?? null, notes: a.notes ?? null,
      }).select("id").single();
      if (error) throw error;
      track(ctx, "orders", o.id, `הזמנה ${a.title}`);
      if (a.deposit && a.deposit > 0) {
        const { data: inc, error: e2 } = await sb.from("income").insert({
          order_id: o.id, customer_id: c.id, amount: a.deposit, kind: "deposit", method: a.deposit_method ?? null,
          date: today, received_by: ctx.partner.id,
        }).select("id").single();
        if (e2) throw e2;
        track(ctx, "income", inc.id, `מקדמה ${money(a.deposit)}`);
      }
      return { order_id: o.id, customer: c.full_name, customer_created: c.created, financials: await financials(o.id) };
    }

    case "update_order": {
      const o = await resolveOrder(a);
      if ("error" in o) return o;
      const upd: Record<string, unknown> = {};
      for (const k of ["status", "price", "due_date", "spec", "notes"]) if (a[k] !== undefined) upd[k] = a[k];
      if (a.status === "delivered") upd.delivered_at = today;
      if (Object.keys(upd).length) {
        const { error } = await sb.from("orders").update(upd).eq("id", o.id);
        if (error) throw error;
      }
      const f = await financials(o.id);
      return { order_id: o.id, title: o.title, updated: upd, financials: f, warning: a.status === "delivered" && f && Number(f.balance_due) > 0 ? `נמסרה, אבל נשארה יתרה של ${money(f.balance_due)}` : undefined };
    }

    case "list_orders": {
      let q = sb.from("order_financials").select("order_id, customer_id, title, kind, status, price, paid, balance_due, due_date");
      const st = a.status ?? "open";
      if (st === "open") q = q.not("status", "in", "(delivered,cancelled)"); else if (st !== "all") q = q.eq("status", st);
      if (a.customer) { const cid = await customerId(a.customer); if (!cid) return { orders: [] }; q = q.eq("customer_id", cid); }
      const { data } = await q.order("due_date", { ascending: true, nullsFirst: false }).limit(40);
      const ids = [...new Set((data ?? []).map((x) => x.customer_id))];
      const { data: cs } = await sb.from("customers").select("id, full_name").in("id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
      const names = new Map((cs ?? []).map((c) => [c.id, c.full_name]));
      return { orders: (data ?? []).map((x) => ({ ...x, customer: names.get(x.customer_id) })) };
    }

    case "add_income": {
      let orderId: string | null = a.order_id ?? null;
      let custId: string | null = null;
      if (!orderId && a.customer) {
        const r = await resolveOrder({ customer: a.customer });
        if ("error" in r) {
          if (r.orders) return r;
          custId = await customerId(a.customer);
          if (!custId) { const c = await ensureCustomer(a.customer); custId = c.id; if (c.created) track(ctx, "customers", c.id, `לקוחה ${c.full_name}`); }
        } else { orderId = r.id; custId = r.customer_id; }
      }
      if (orderId && !custId) custId = (await sb.from("orders").select("customer_id").eq("id", orderId).maybeSingle()).data?.customer_id ?? null;
      const { data, error } = await sb.from("income").insert({
        order_id: orderId, customer_id: custId, amount: a.amount, date: a.date ?? today, kind: a.kind ?? "payment",
        method: a.method ?? null, invoice_number: a.invoice_number ?? null, notes: a.notes ?? null, received_by: ctx.partner.id,
      }).select("id").single();
      if (error) throw error;
      track(ctx, "income", data.id, `הכנסה ${money(a.amount)}`);
      return { income_id: data.id, order_financials: orderId ? await financials(orderId) : null };
    }

    case "add_expense": {
      let orderId: string | null = a.order_id ?? null;
      if (!orderId && a.customer) {
        const r = await resolveOrder({ customer: a.customer });
        if ("error" in r) return r;
        orderId = r.id;
      }
      if (a.gmail_message_id) {
        const dup = await sb.from("expenses").select("id").eq("gmail_message_id", a.gmail_message_id).maybeSingle();
        if (dup.data) return { error: "החשבונית הזו כבר נרשמה" };
      }
      const { data, error } = await sb.from("expenses").insert({
        order_id: orderId, amount: a.amount, date: a.date ?? today, vendor: a.vendor ?? null, description: a.description ?? null,
        category: a.category ?? null, invoice_number: a.invoice_number ?? null, receipt_path: a.receipt_path ?? null,
        gmail_message_id: a.gmail_message_id ?? null, notes: a.notes ?? null, paid_by: ctx.partner.id,
      }).select("id").single();
      if (error) throw error;
      track(ctx, "expenses", data.id, `הוצאה ${money(a.amount)}`);
      return { expense_id: data.id, linked_order: orderId };
    }

    case "list_transactions": {
      const from = a.from ?? addDays(today, -30), to = a.to ?? today, lim = Math.min(a.limit ?? 40, 100);
      const out: Record<string, unknown> = {};
      let custFilter: string | null = null;
      if (a.customer) { custFilter = await customerId(a.customer); if (!custFilter) return { error: `לא נמצאה לקוחה "${a.customer}"` }; }
      if (a.type !== "expense") {
        let q = sb.from("income").select("id, date, amount, kind, method, invoice_number, customers(full_name)").gte("date", from).lte("date", to).order("date", { ascending: false }).limit(lim);
        if (custFilter) q = q.eq("customer_id", custFilter);
        const { data } = await q;
        out.income = data; out.income_total = (data ?? []).reduce((s, x) => s + Number(x.amount), 0);
      }
      if (a.type !== "income") {
        let q = sb.from("expenses").select("id, date, amount, vendor, description, category, invoice_number, order_id").gte("date", from).lte("date", to).order("date", { ascending: false }).limit(lim);
        if (a.vendor) q = q.ilike("vendor", `%${ilikeEsc(a.vendor)}%`);
        const { data } = await q;
        out.expenses = data; out.expenses_total = (data ?? []).reduce((s, x) => s + Number(x.amount), 0);
      }
      return { from, to, ...out };
    }

    case "open_balances": return await openBalances();

    case "financial_summary": return await financialSummary(a.from, a.to, a.group_by === "order");

    case "log_treatment": {
      const c = await ensureCustomer(a.customer);
      if (c.created) track(ctx, "customers", c.id, `לקוחה ${c.full_name}`);
      const date = a.date ?? today;
      const { data, error } = await sb.from("treatments").insert({
        customer_id: c.id, order_id: a.order_id ?? null, kind: a.kind, date, notes: a.notes ?? null,
      }).select("id").single();
      if (error) throw error;
      track(ctx, "treatments", data.id, "טיפול");
      let reminder: string | null = null;
      if (a.rebook_weeks > 0) {
        const when = localToUtc(addDays(date, Math.round(a.rebook_weeks * 7)), "10:00");
        const { data: r } = await sb.from("reminders").insert({
          partner_id: ctx.partner.id, message: `🔁 הגיע הזמן לתאם תור חוזר ל${c.full_name}`, remind_at: when.toISOString(), kind: "rebook",
        }).select("id").single();
        if (r) track(ctx, "reminders", r.id, "תזכורת לתור חוזר");
        reminder = fmtDT(when);
      }
      return { treatment_id: data.id, customer: c.full_name, rebook_reminder_at: reminder };
    }

    case "add_appointment": return await addAppointment(a, ctx);
    case "update_appointment": return await updateAppointment(a);

    case "list_schedule": {
      const from = localToUtc(a.from), to = localToUtc(addDays(a.to, 1));
      const [ap, rem, tk] = await Promise.all([
        sb.from("appointments").select("id, kind, title, starts_at, ends_at, all_day, customers(full_name, phone)").lt("starts_at", to.toISOString()).gt("ends_at", from.toISOString()).order("starts_at"),
        sb.from("reminders").select("id, message, remind_at").is("sent_at", null).gte("remind_at", from.toISOString()).lt("remind_at", to.toISOString()).order("remind_at"),
        sb.from("tasks").select("id, title, due_date, priority, status").neq("status", "done").gte("due_date", a.from).lte("due_date", a.to).order("due_date"),
      ]);
      return {
        appointments: (ap.data ?? []).map((x: any) => ({ id: x.id, kind: x.kind, title: x.title, when: x.all_day ? "יום שלם" : `${fmtDT(x.starts_at)}-${fmtTime(x.ends_at)}`, customer: x.customers?.full_name, phone: x.customers?.phone })),
        reminders: (rem.data ?? []).map((r) => ({ id: r.id, message: r.message, when: fmtDT(r.remind_at) })),
        tasks: tk.data,
      };
    }

    case "find_free_time": return await freeSlots(a.service ?? "regular", a.from ?? today, Math.min(a.days_ahead ?? 10, 30));

    case "add_task": {
      let cid: string | null = null;
      if (a.customer) cid = await customerId(a.customer);
      const { data, error } = await sb.from("tasks").insert({
        title: a.title, description: a.description ?? null, due_date: a.due_date ?? null, priority: a.priority ?? 2,
        customer_id: cid, order_id: a.order_id ?? null,
      }).select("id").single();
      if (error) throw error;
      track(ctx, "tasks", data.id, `משימה ${a.title}`);
      return { task_id: data.id };
    }

    case "update_task": {
      let id: string | null = a.task_id ?? null;
      if (!id && a.title_query) {
        const { data } = await sb.from("tasks").select("id, title").neq("status", "done").ilike("title", `%${ilikeEsc(a.title_query)}%`);
        if ((data ?? []).length > 1) return { error: "כמה משימות מתאימות", tasks: data };
        id = data?.[0]?.id ?? null;
      }
      if (!id) return { error: "לא נמצאה משימה" };
      const upd: Record<string, unknown> = {};
      for (const k of ["status", "due_date", "priority", "title"]) if (a[k] !== undefined) upd[k] = a[k];
      const { error } = await sb.from("tasks").update(upd).eq("id", id);
      if (error) throw error;
      return { updated: id };
    }

    case "list_tasks": {
      const st = a.status ?? "open";
      let q = sb.from("tasks").select("id, title, due_date, priority, status, customers(full_name)").order("due_date", { ascending: true, nullsFirst: false }).limit(50);
      if (st === "open") q = q.neq("status", "done"); else if (st === "done") q = q.eq("status", "done");
      const { data } = await q;
      return { tasks: data };
    }

    case "add_reminder": {
      const m = String(a.when).match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
      if (!m) return { error: "פורמט זמן לא תקין, צריך YYYY-MM-DD HH:mm" };
      const when = localToUtc(m[1], m[2]);
      if (when.getTime() < Date.now() - 60_000) return { error: "הזמן הזה כבר עבר" };
      const { data, error } = await sb.from("reminders").insert({ partner_id: ctx.partner.id, message: a.message, remind_at: when.toISOString() }).select("id").single();
      if (error) throw error;
      track(ctx, "reminders", data.id, "תזכורת");
      return { reminder_id: data.id, at: fmtDT(when) };
    }

    case "remember_fact": {
      if (SECRET_RE.test(a.content)) return { error: "לא שומרת סיסמאות, מפתחות או מספרי כרטיס אשראי" };
      const { data, error } = await sb.from("bot_memories").insert({ partner_id: ctx.partner.id, kind: a.kind ?? "fact", content: a.content }).select("id").single();
      if (error) throw error;
      track(ctx, "bot_memories", data.id, "זיכרון");
      return { saved: true };
    }
    case "forget_fact": {
      const { data } = await sb.from("bot_memories").delete().ilike("content", `%${ilikeEsc(a.query)}%`).select("content");
      return { deleted: (data ?? []).map((x) => x.content) };
    }

    case "connect_google": {
      const url = await connectLink(sb, ctx.partner.id);
      ctx.buttons.push([{ text: "🔗 חיבור מחדש ל-Google", url }]);
      return { sent: true, explain_to_her: "יש כפתור מתחת להודעה. שלבים: 1) ללחוץ על הכפתור 2) לבחור את חשבון הגוגל של העסק 3) אם מופיע 'Google לא אימתה את האפליקציה': 'מתקדם' ואז 'מעבר ל-GB Wigs' 4) לסמן את כל התיבות ו'המשך'. הדפדפן יחזור לטלגרם ותגיע הודעת אישור." };
    }
    case "disconnect_google": {
      if (!a.confirmed) return { needs_confirmation: true };
      await revokeAndDisconnect(sb, ctx.partner.id);
      return { disconnected: true };
    }

    case "search_gmail_invoices": {
      const token = await accessToken(sb, ctx.partner.id);
      if (!token) return { error: "לא מחוברת ל-Google. להפעיל connect_google." };
      const hits = await searchGmail(token, a.query, a.max ?? 15);
      const { data: reg } = await sb.from("expenses").select("gmail_message_id").in("gmail_message_id", hits.length ? hits.map((h) => h.id) : ["-"]);
      const done = new Set((reg ?? []).map((r) => r.gmail_message_id));
      return { count: hits.length, results: hits.map((h) => ({ message_id: h.id, from: h.from, subject: h.subject, date: h.date, already_registered: done.has(h.id) })) };
    }
    case "read_gmail_invoice": {
      const token = await accessToken(sb, ctx.partner.id);
      if (!token) return { error: "לא מחוברת ל-Google" };
      const dup = await sb.from("expenses").select("id").eq("gmail_message_id", a.message_id).maybeSingle();
      if (dup.data) return { already_registered: true };
      const inv = await readGmailInvoice(token, a.message_id);
      let receiptPath: string | null = null, media: Media | null = null;
      if (inv.attachment) {
        const ext = inv.attachment.mime === "application/pdf" ? "pdf" : (inv.attachment.mime.split("/")[1] ?? "bin");
        receiptPath = `${todayStr().slice(0, 7)}/${crypto.randomUUID()}.${ext}`;
        await sb.storage.from("receipts").upload(receiptPath, inv.attachment.bytes, { contentType: inv.attachment.mime });
        const { encodeBase64 } = await import("jsr:@std/encoding@1/base64");
        media = { mime: inv.attachment.mime, data: encodeBase64(inv.attachment.bytes) };
      }
      const extracted = await extractInvoice(media, media ? "" : inv.bodyText);
      return { message_id: a.message_id, subject: inv.subject, from: inv.from, extracted, receipt_path: receiptPath, had_attachment: !!inv.attachment };
    }

    case "delete_record": return await deleteRecord(a.table, a.id, !!a.confirmed);

    case "get_balance": return await getBalance();
    case "add_settlement": {
      const { data: ps } = await sb.from("partners").select("id, name");
      const f = ps?.find((p) => p.name.includes(a.from_name)), t = ps?.find((p) => p.name.includes(a.to_name));
      if (!f || !t) return { error: "לא נמצאו השותפות" };
      const { data, error } = await sb.from("settlements").insert({ from_partner: f.id, to_partner: t.id, amount: a.amount, date: a.date ?? today, notes: a.notes ?? null }).select("id").single();
      if (error) throw error;
      track(ctx, "settlements", data.id, `העברה ${money(a.amount)}`);
      return { settlement_id: data.id };
    }
  }
  return { error: `כלי לא מוכר: ${name}` };
}

// ───────────── מימושים משותפים (גם לפקודות בלי מודל) ─────────────
export async function openBalances() {
  const { data } = await sb.from("order_financials").select("order_id, customer_id, title, status, price, paid, balance_due, due_date").gt("balance_due", 0).order("balance_due", { ascending: false });
  const ids = [...new Set((data ?? []).map((x) => x.customer_id))];
  const { data: cs } = await sb.from("customers").select("id, full_name, phone").in("id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
  const map = new Map((cs ?? []).map((c) => [c.id, c]));
  const rows = (data ?? []).map((x) => ({ customer: map.get(x.customer_id)?.full_name, phone: map.get(x.customer_id)?.phone, order: x.title, status: x.status, price: Number(x.price), paid: Number(x.paid), due: Number(x.balance_due), delivered: x.status === "delivered" }));
  return { total_due: rows.reduce((s, r) => s + r.due, 0), delivered_unpaid: rows.filter((r) => r.delivered).reduce((s, r) => s + r.due, 0), rows };
}

export async function financialSummary(from: string, to: string, byOrder = false) {
  const [inc, exp] = await Promise.all([
    sb.from("income").select("amount").gte("date", from).lte("date", to),
    sb.from("expenses").select("amount, category, invoice_number").gte("date", from).lte("date", to),
  ]);
  const income = (inc.data ?? []).reduce((s, x) => s + Number(x.amount), 0);
  const expenses = (exp.data ?? []).reduce((s, x) => s + Number(x.amount), 0);
  const byCat: Record<string, number> = {};
  for (const e of exp.data ?? []) byCat[e.category ?? "ללא קטגוריה"] = (byCat[e.category ?? "ללא קטגוריה"] ?? 0) + Number(e.amount);
  const res: Record<string, unknown> = {
    from, to, income, expenses, net: income - expenses, expenses_by_category: byCat,
    expenses_missing_invoice_number: (exp.data ?? []).filter((e) => !e.invoice_number).length,
  };
  if (byOrder) {
    const { data } = await sb.from("order_financials").select("title, price, paid, expenses, profit_so_far, expected_profit, customer_id");
    const ids = [...new Set((data ?? []).map((x) => x.customer_id))];
    const { data: cs } = await sb.from("customers").select("id, full_name").in("id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
    const map = new Map((cs ?? []).map((c) => [c.id, c.full_name]));
    res.orders = (data ?? []).map((x) => ({ customer: map.get(x.customer_id), order: x.title, price: x.price, paid: x.paid, expenses: x.expenses, profit_so_far: x.profit_so_far, expected_profit: x.expected_profit }));
  }
  return res;
}

async function getBalance() {
  const [{ data: ps }, { data: inc }, { data: exp }, { data: st }] = await Promise.all([
    sb.from("partners").select("id, name"), sb.from("income").select("amount, received_by"),
    sb.from("expenses").select("amount, paid_by"), sb.from("settlements").select("from_partner, to_partner, amount"),
  ]);
  const totalIncome = (inc ?? []).reduce((s, x) => s + Number(x.amount), 0);
  const totalExp = (exp ?? []).reduce((s, x) => s + Number(x.amount), 0);
  const profit = totalIncome - totalExp;
  const share = profit / Math.max((ps ?? []).length, 1);
  const rows = (ps ?? []).map((p) => {
    const received = (inc ?? []).filter((x) => x.received_by === p.id).reduce((s, x) => s + Number(x.amount), 0);
    const paid = (exp ?? []).filter((x) => x.paid_by === p.id).reduce((s, x) => s + Number(x.amount), 0);
    const out = (st ?? []).filter((x) => x.from_partner === p.id).reduce((s, x) => s + Number(x.amount), 0);
    const inn = (st ?? []).filter((x) => x.to_partner === p.id).reduce((s, x) => s + Number(x.amount), 0);
    const holds = received - paid - out + inn;
    return { name: p.name, received, paid, holds, owes_to_other: Math.round((holds - share) * 100) / 100 };
  });
  return { business_profit: profit, equal_share: share, partners: rows, note: "owes_to_other חיובי = צריכה להעביר לשותפה; שלילי = מגיע לה" };
}

async function addAppointment(a: any, ctx: Ctx) {
  const durs = await cfgJson<Record<string, number>>("durations", { regular: 30, consultation: 60 });
  const hours = await cfgJson<Record<string, string[][]>>("work_hours", {});
  const kind: string = a.kind ?? "regular";
  let startsAt: Date, endsAt: Date;
  const allDay = kind === "away" || !!a.all_day;
  if (allDay) {
    startsAt = localToUtc(a.date); endsAt = localToUtc(addDays(a.end_date ?? a.date, 1));
  } else {
    if (!a.time) return { error: "חסרה שעה" };
    startsAt = localToUtc(a.date, a.time);
    const dur = a.duration_min ?? (kind === "consultation" ? durs.consultation : kind === "focus" ? 120 : durs.regular) ?? 30;
    endsAt = new Date(startsAt.getTime() + dur * 60_000);
  }
  let customerIdVal: string | null = null, customerName: string | null = null;
  if (a.customer) {
    const c = await ensureCustomer(a.customer);
    customerIdVal = c.id; customerName = c.full_name;
    if (c.created) track(ctx, "customers", c.id, `לקוחה ${c.full_name}`);
  }
  const label = kind === "consultation" ? "ייעוץ והזמנה" : kind === "focus" ? "בלוק עבודה" : kind === "away" ? "לא זמינה" : "תור";
  const title = a.title ?? [a.service ?? label, customerName].filter(Boolean).join(" – ");
  const warnings: string[] = [];
  if (!allDay && (kind === "regular" || kind === "consultation")) {
    const wins = hours[String(dowOf(a.date))] ?? [];
    const sMin = startsAt.getTime(), eMin = endsAt.getTime();
    const inside = wins.some(([s, e]) => sMin >= localToUtc(a.date, s).getTime() && eMin <= localToUtc(a.date, e).getTime());
    if (!inside) warnings.push(wins.length ? `מחוץ לשעות הקבלה (${wins.map((w) => w.join("-")).join(", ")})` : "אין קבלת קהל ביום הזה");
  }
  const { data: clash } = await sb.from("appointments").select("title, starts_at, ends_at")
    .lt("starts_at", endsAt.toISOString()).gt("ends_at", startsAt.toISOString());
  const conflicts = (clash ?? []).map((c) => `${c.title} (${fmtDT(c.starts_at)}-${fmtTime(c.ends_at)})`);
  if (!allDay) {
    const pb = await primaryBusy(sb, startsAt.toISOString(), endsAt.toISOString());
    if (pb.length) conflicts.push("תפוס ביומן האישי בגוגל באותה שעה");
  }
  const { data, error } = await sb.from("appointments").insert({
    kind, service: a.service ?? null, title, customer_id: customerIdVal, order_id: a.order_id ?? null,
    starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString(), all_day: allDay, notes: a.notes ?? null,
  }).select("id").single();
  if (error) throw error;
  track(ctx, "appointments", data.id, `תור ${customerName ?? title}`);
  return { appointment_id: data.id, title, when: allDay ? `${a.date} (יום שלם)` : `${fmtDT(startsAt)}-${fmtTime(endsAt)}`, conflicts, warnings };
}

async function updateAppointment(a: any) {
  let id: string | null = a.appointment_id ?? null;
  if (!id && a.customer) {
    const cid = await customerId(a.customer);
    if (!cid) return { error: `לא נמצאה לקוחה "${a.customer}"` };
    let q = sb.from("appointments").select("id, title, starts_at").eq("customer_id", cid).gte("ends_at", new Date().toISOString()).order("starts_at");
    if (a.on_date) q = q.gte("starts_at", localToUtc(a.on_date).toISOString()).lt("starts_at", localToUtc(addDays(a.on_date, 1)).toISOString());
    const { data } = await q;
    if (!data?.length) return { error: "אין תור עתידי ללקוחה" };
    if (data.length > 1) return { error: "יש כמה תורים, צריך לציין איזה", appointments: data.map((x) => ({ appointment_id: x.id, when: fmtDT(x.starts_at), title: x.title })) };
    id = data[0].id;
  }
  if (!id) return { error: "חסר מזהה או לקוחה" };
  const { data: ap } = await sb.from("appointments").select("*").eq("id", id).maybeSingle();
  if (!ap) return { error: "התור לא נמצא" };
  if (a.cancel) {
    if (!a.confirmed) return { needs_confirmation: true, appointment: ap.title, when: fmtDT(ap.starts_at) };
    await sb.from("appointments").delete().eq("id", id);
    return { cancelled: ap.title };
  }
  const upd: Record<string, unknown> = {};
  if (a.new_date || a.new_time) {
    const lp = localParts(new Date(ap.starts_at));
    const date = a.new_date ?? lp.date, time = a.new_time ?? lp.time;
    const dur = a.new_duration_min ? a.new_duration_min * 60_000 : new Date(ap.ends_at).getTime() - new Date(ap.starts_at).getTime();
    const s = localToUtc(date, time);
    upd.starts_at = s.toISOString(); upd.ends_at = new Date(s.getTime() + dur).toISOString();
  } else if (a.new_duration_min) {
    upd.ends_at = new Date(new Date(ap.starts_at).getTime() + a.new_duration_min * 60_000).toISOString();
  }
  if (a.new_service) upd.service = a.new_service;
  if (a.notes !== undefined) upd.notes = a.notes;
  if (upd.starts_at) { upd.reminded_at = null; upd.daybefore_sent = false; upd.followup_sent = false; }
  const { error } = await sb.from("appointments").update(upd).eq("id", id);
  if (error) throw error;
  const s = (upd.starts_at as string) ?? ap.starts_at, e = (upd.ends_at as string) ?? ap.ends_at;
  const { data: clash } = await sb.from("appointments").select("title, starts_at").neq("id", id).lt("starts_at", e).gt("ends_at", s);
  return { updated: id, when: `${fmtDT(s)}-${fmtTime(e)}`, conflicts: (clash ?? []).map((c) => `${c.title} (${fmtDT(c.starts_at)})`) };
}

async function deleteRecord(table: string, id: string, confirmed: boolean) {
  if (!UNDO_TABLES.includes(table)) return { error: "טבלה לא מותרת" };
  if (!confirmed) return { needs_confirmation: true, table, id };
  return await hardDelete(table, id);
}

/** מחיקה בפועל (גם לכפתור ביטול). בהוצאה מוחק גם את קובץ הקבלה. */
export async function hardDelete(table: string, id: string) {
  if (!UNDO_TABLES.includes(table)) return { error: "טבלה לא מותרת" };
  if (table === "expenses") {
    const { data } = await sb.from("expenses").select("receipt_path").eq("id", id).maybeSingle();
    if (data?.receipt_path) await sb.storage.from("receipts").remove([data.receipt_path]);
  }
  const { error } = await sb.from(table).delete().eq("id", id);
  if (error) return { error: error.message };
  return { deleted: true };
}
