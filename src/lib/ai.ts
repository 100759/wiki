/** EdgeOne Makers Models 网关（OpenAI 兼容）。密钥只从环境变量读，不落仓库。 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function aiConfig(): AiConfig | null {
  const apiKey = (process.env.MAKERS_MODELS_KEY ?? process.env.AI_API_KEY ?? "").trim();
  if (!apiKey) return null;
  return {
    baseUrl: (process.env.AI_BASE_URL ?? "https://ai-gateway.edgeone.link/v1").replace(/\/+$/, ""),
    apiKey,
    model: (process.env.AI_MODEL ?? "@makers/deepseek-v4-flash").trim(),
  };
}

export type AiResult =
  | { ok: true; text: string }
  | { ok: false; code: "not_configured" | "upstream" | "timeout"; message: string };

export async function chat(messages: ChatMessage[], maxTokens = 700): Promise<AiResult> {
  const config = aiConfig();
  if (!config) {
    return { ok: false, code: "not_configured", message: "AI 未配置：缺少 MAKERS_MODELS_KEY" };
  }

  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        max_tokens: maxTokens,
        temperature: 0.2,
        stream: false,
      }),
      signal: AbortSignal.timeout(25_000),
    });
  } catch (err) {
    const name = (err as Error).name;
    if (name === "TimeoutError" || name === "AbortError") {
      return { ok: false, code: "timeout", message: "模型响应超时，请稍后重试" };
    }
    return { ok: false, code: "upstream", message: `模型请求失败：${(err as Error).message}` };
  }

  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    return { ok: false, code: "upstream", message: `模型返回 ${response.status}：${detail}` };
  }

  const data = (await response.json().catch(() => null)) as
    | { choices?: { message?: { content?: string } }[] }
    | null;
  const text = data?.choices?.[0]?.message?.content?.trim() ?? "";
  if (!text) return { ok: false, code: "upstream", message: "模型没有返回内容" };
  return { ok: true, text };
}
