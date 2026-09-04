/**
 * 最小的 OpenAI 客戶端。
 *
 * 刻意不裝官方 SDK：整個專案只需要「一個帶 json_schema 的 POST」，
 * 少一個相依就少一份評審要看的東西，也少一個現場才發現版本不合的風險。
 *
 * 兩個不可妥協的設定：
 *   temperature 0   同樣的帳單每次要抽出同樣的數字，舞台上不能擲骰子。
 *   strict schema   模型只能填我們開的欄位，多一個少一個都會被 API 擋下來。
 */

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

export const DEFAULT_MODEL = 'gpt-4.1-mini';

/** 預設逾時。舞台上超過這個秒數就該走規則備援，不能讓評審看著轉圈。 */
export const DEFAULT_TIMEOUT_MS = 12_000;

export type JsonSchemaSpec = {
  name: string;
  schema: Record<string, unknown>;
};

export class LlmError extends Error {
  detail?: string;

  constructor(message: string, detail?: string) {
    super(message);
    this.name = 'LlmError';
    this.detail = detail;
  }
}

/**
 * 現在能不能呼叫模型。
 * `DEMO_MODE=fixtures` 是舞台保險絲：現場網路不通時整個系統改走規則路徑，
 * 功能會退化但不會停擺。
 */
export function llmEnabled(): boolean {
  if (process.env.DEMO_MODE === 'fixtures') return false;
  return Boolean(process.env.OPENAI_API_KEY);
}

export function activeModel(): string {
  return process.env.OPENAI_MODEL ?? DEFAULT_MODEL;
}

/**
 * 視覺解析開關。關掉之後上傳圖片會退回文字路徑，功能退化但不會壞。
 * 圖片是比文字更危險的注入面（可以把指令印在帳單上），所以它是獨立的旗標。
 */
export function visionEnabled(): boolean {
  return llmEnabled() && process.env.ENABLE_VISION === 'true';
}

/** 呼叫模型並要求它回傳符合 schema 的 JSON。失敗一律丟 `LlmError`，由呼叫端決定備援。 */
export async function completeJson<T>(args: {
  system: string;
  user: string;
  /** 一或多張圖，格式為 data URL。給了就走視覺模式。 */
  images?: string[];
  schema: JsonSchemaSpec;
  model?: string;
  timeoutMs?: number;
  maxTokens?: number;
}): Promise<{ data: T; model: string; latencyMs: number }> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new LlmError('OPENAI_API_KEY 沒有設定');

  const model = args.model ?? activeModel();
  const started = Date.now();

  let res: Response;
  try {
    res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_completion_tokens: args.maxTokens ?? 800,
        messages: [
          { role: 'system', content: args.system },
          {
            role: 'user',
            content: args.images?.length
              ? [
                  { type: 'text', text: args.user },
                  ...args.images.map((url) => ({
                    type: 'image_url',
                    image_url: { url, detail: 'high' },
                  })),
                ]
              : args.user,
          },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: args.schema.name, strict: true, schema: args.schema.schema },
        },
      }),
      signal: AbortSignal.timeout(args.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new LlmError(`模型逾時（${args.timeoutMs ?? DEFAULT_TIMEOUT_MS} 毫秒）`);
    }
    throw new LlmError('連不上模型', err instanceof Error ? err.message : String(err));
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new LlmError(`模型回應 HTTP ${res.status}`, body.slice(0, 400));
  }

  const payload = (await res.json()) as {
    choices?: { message?: { content?: string }; finish_reason?: string }[];
  };

  const choice = payload.choices?.[0];
  const content = choice?.message?.content;
  if (!content) {
    throw new LlmError('模型沒有回傳內容', `finish_reason=${choice?.finish_reason ?? 'unknown'}`);
  }

  let data: T;
  try {
    data = JSON.parse(content) as T;
  } catch {
    throw new LlmError('模型回傳的不是合法 JSON', content.slice(0, 200));
  }

  return { data, model, latencyMs: Date.now() - started };
}
