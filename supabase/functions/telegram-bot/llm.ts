// llm.ts — מעטפת מודל. כל שאר הקוד מדבר רק עם הממשק LLM.
// להחלפת מודל באותו ספק: סיקרט GEMINI_MODEL.
// להחלפת ספק: ממשו את LLM (ראו GeminiLLM) והוסיפו שורה ב-getLLM(), ואז סיקרט LLM_PROVIDER.

export interface ToolDecl { name: string; description: string; parameters?: Record<string, unknown> }
export interface Media { mime: string; data: string } // data = base64
export interface ToolCall { name: string; args: Record<string, unknown> }
export interface ToolResult { name: string; result: unknown }
export interface Msg {
  role: "user" | "model";
  text?: string;
  media?: Media[];
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  raw?: unknown; // חלקי תשובה מקוריים של הספק (נדרש ב-Gemini לשמירת thought signatures)
}
export interface LLMReply { text: string; toolCalls: ToolCall[]; raw?: unknown }
export interface LLM { generate(system: string, msgs: Msg[], tools: ToolDecl[]): Promise<LLMReply> }

// ───────────── Gemini ─────────────
const FALLBACK_MODEL = "gemini-2.5-flash";

class GeminiLLM implements LLM {
  private key = Deno.env.get("GEMINI_API_KEY") ?? "";
  private model = Deno.env.get("GEMINI_MODEL") ?? "gemini-flash-latest";

  private contents(msgs: Msg[]) {
    return msgs.map((m) => {
      if (m.role === "model" && Array.isArray(m.raw)) return { role: "model", parts: m.raw };
      const parts: unknown[] = [];
      if (m.text) parts.push({ text: m.text });
      for (const x of m.media ?? []) parts.push({ inlineData: { mimeType: x.mime, data: x.data } });
      for (const c of m.toolCalls ?? []) parts.push({ functionCall: { name: c.name, args: c.args } });
      for (const r of m.toolResults ?? []) {
        parts.push({ functionResponse: { name: r.name, response: { result: r.result } } });
      }
      if (!parts.length) parts.push({ text: "." });
      return { role: m.role, parts };
    });
  }

  private async call(model: string, body: unknown): Promise<Response> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    let res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": this.key },
      body: JSON.stringify(body),
    });
    if (res.status === 429 || res.status === 503) { // ניסיון חוזר אחד
      await new Promise((r) => setTimeout(r, 1500));
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.key },
        body: JSON.stringify(body),
      });
    }
    return res;
  }

  async generate(system: string, msgs: Msg[], tools: ToolDecl[]): Promise<LLMReply> {
    if (!this.key) throw new Error("חסר GEMINI_API_KEY");
    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: system }] },
      contents: this.contents(msgs),
      generationConfig: { temperature: 0.4 },
    };
    if (tools.length) {
      body.tools = [{
        functionDeclarations: tools.map((t) => {
          const d: Record<string, unknown> = { name: t.name, description: t.description };
          if (t.parameters && Object.keys((t.parameters as { properties?: object }).properties ?? {}).length) {
            d.parameters = t.parameters;
          }
          return d;
        }),
      }];
    }
    let res = await this.call(this.model, body);
    if (res.status === 404 && this.model !== FALLBACK_MODEL) res = await this.call(FALLBACK_MODEL, body);
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = await res.json();
    const parts: Array<Record<string, unknown>> = json.candidates?.[0]?.content?.parts ?? [];
    if (!parts.length) {
      return { text: "לא הצלחתי לענות על זה. אפשר לנסח אחרת?", toolCalls: [] };
    }
    const text = parts.filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text as string).join("").trim();
    const toolCalls = parts
      .filter((p) => p.functionCall)
      .map((p) => {
        const fc = p.functionCall as { name: string; args?: Record<string, unknown> };
        return { name: fc.name, args: fc.args ?? {} };
      });
    return { text, toolCalls, raw: parts };
  }
}

export function getLLM(): LLM {
  const provider = (Deno.env.get("LLM_PROVIDER") ?? "gemini").toLowerCase();
  switch (provider) {
    case "gemini":
    default:
      return new GeminiLLM();
  }
}
