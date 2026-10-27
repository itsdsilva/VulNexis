import { invoke } from "@tauri-apps/api/core";

export interface LLMSettings {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  apiKeys?: Record<string, string>; // per-provider keys, needed for multi-provider multi-run
  pricePerMTok: number; // USD per 1M tokens (rough estimate)
}

export const PROVIDERS: Record<
  string,
  { baseUrl: string; models: string[]; noKey?: boolean; note?: string }
> = {
  OpenRouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    models: [
      "anthropic/claude-sonnet-5.5",
      "openai/gpt-6.1-sol",
      "google/gemini-3.8-flash",
      "deepseek/deepseek-v4.1-flash",
      "meta-llama/llama-4-maverick",
    ],
  },
  OpenAI: {
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-6.1-terra", "gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"],
  },
  Anthropic: {
    baseUrl: "https://api.anthropic.com",
    models: ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5"],
  },
  Gemini: {
    baseUrl: "https://generativelanguage.googleapis.com",
    models: ["gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-3.1-pro-preview"],
  },
  DeepSeek: {
    baseUrl: "https://api.deepseek.com/v1",
    models: ["deepseek-flash", "deepseek-v4-pro"],
  },
  Groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    models: ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b"],
  },
  Cerebras: {
    baseUrl: "https://api.cerebras.ai/v1",
    models: ["gpt-oss-120b", "qwen-3.8-27b"],
  },
  Ollama: {
    baseUrl: "http://localhost:11434/v1",
    models: ["gpt-oss:20b", "qwen3-coder:30b", "llama3.1", "mistral"],
    noKey: true,
    note: "local — run `ollama serve` and `ollama pull <model>`",
  },
};

/** Providers with their own wire format (everything else is OpenAI-compatible). */
export function providerKind(provider: string): 'openai' | 'anthropic' | 'gemini' {
  if (provider === 'Anthropic') return 'anthropic';
  if (provider === 'Gemini') return 'gemini';
  return 'openai';
}

export function providerNeedsKey(provider: string): boolean {
  return !PROVIDERS[provider]?.noKey;
}

const KEY = "vulnexis_llm_v1";

/** Model IDs retired by providers, mapped to their recommended replacements. */
const RETIRED_MODELS: Record<string, Record<string, string>> = {
  OpenRouter: {
    "openai/gpt-4o-mini": "openai/gpt-6-luna",
    "openai/gpt-4o": "openai/gpt-6.1-sol",
    "anthropic/claude-3.5-sonnet": "anthropic/claude-sonnet-5.5",
    "google/gemini-2.0-flash-001": "google/gemini-3.8-flash",
  },
  OpenAI: {
    "gpt-4o-mini": "gpt-6-luna",
    "gpt-4o": "gpt-6.1-sol",
    "gpt-4.1-mini": "gpt-6-luna",
    "gpt-5": "gpt-6.1-sol",
    "gpt-5-mini": "gpt-6-luna",
  },
  Anthropic: {
    "claude-sonnet-4-5": "claude-sonnet-5-5",
    "claude-sonnet-4-5-20250929": "claude-sonnet-5-5",
    "claude-opus-4-1": "claude-opus-5-5",
    "claude-haiku-4-5": "claude-haiku-5-5",
  },
  Gemini: {
    "gemini-2.0-flash": "gemini-3.8-flash",
    "gemini-2.0-flash-001": "gemini-3.8-flash",
    "gemini-2.5-flash": "gemini-3.8-flash",
    "gemini-2.5-pro": "gemini-3.1-pro-preview",
  },
  DeepSeek: {
    "deepseek-chat": "deepseek-flash",
    "deepseek-reasoner": "deepseek-flash",
  },
  Groq: {
    "llama-3.3-70b-versatile": "openai/gpt-oss-120b",
    "llama-3.1-8b-instant": "openai/gpt-oss-20b",
    "qwen/qwen3-32b": "qwen/qwen3.8-27b",
    "meta-llama/llama-4-scout-17b-16e-instruct": "openai/gpt-oss-120b",
  },
  Cerebras: {
    "llama3.1-8b": "gpt-oss-120b",
    "llama-3.3-70b": "gpt-oss-120b",
  },
};

export function loadLLMSettings(): LLMSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as LLMSettings;
      const migrated = RETIRED_MODELS[s.provider]?.[s.model];
      if (migrated) {
        s.model = migrated;
        localStorage.setItem(KEY, JSON.stringify(s));
      }
      return s;
    }
  } catch {
    /* ignore */
  }
  return {
    provider: "OpenRouter",
    baseUrl: PROVIDERS.OpenRouter.baseUrl,
    model: PROVIDERS.OpenRouter.models[0],
    apiKey: "",
    pricePerMTok: 0.5,
  };
}

export function saveLLMSettings(s: LLMSettings) {
  localStorage.setItem(KEY, JSON.stringify(s));
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('vulnexis:llm-settings'));
}

/** Fetch the provider's live model list through the Rust HTTP client (no CORS issues). */
export async function fetchProviderModels(provider: string, baseUrl: string, apiKey: string): Promise<string[]> {
  const kind = providerKind(provider);
  const base = baseUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = {};
  let url: string;
  if (kind === 'anthropic') {
    url = `${base}/v1/models?limit=100`;
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (kind === 'gemini') {
    url = `${base}/v1beta/models?key=${encodeURIComponent(apiKey)}`;
  } else {
    url = `${base}/models`;
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  }
  let status: number;
  let body: string;
  if (inTauri()) {
    const res = await invoke<{ status: number; body: string }>('http_fetch', {
      req: { url, method: 'GET', headers: Object.entries(headers) },
    });
    status = res.status;
    body = res.body;
  } else {
    const res = await fetch(url, { headers });
    status = res.status;
    body = await res.text();
  }
  if (status < 200 || status >= 300) {
    throw new Error(`model list failed (${status}): ${body.slice(0, 200)}`);
  }
  const json = JSON.parse(body);
  const ids: string[] =
    kind === 'gemini'
      ? (json.models ?? [])
          .filter((m: { supportedGenerationMethods?: string[] }) =>
            (m.supportedGenerationMethods ?? []).includes('generateContent'),
          )
          .map((m: { name: string }) => m.name.replace(/^models\//, ''))
      : (json.data ?? []).map((m: { id: string }) => String(m.id));
  return Array.from(new Set(ids.filter(Boolean)));
}

// ShipChamber-style model preferences: favorites and recents, persisted
const PREFS_KEY = "vulnexis_model_prefs_v1";

export interface ModelPrefs {
  favorites: string[];
  recents: string[];
}

export function loadModelPrefs(): ModelPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as ModelPrefs;
      return { favorites: p.favorites ?? [], recents: p.recents ?? [] };
    }
  } catch {
    /* ignore */
  }
  return { favorites: [], recents: [] };
}

export function saveModelPrefs(p: ModelPrefs) {
  localStorage.setItem(PREFS_KEY, JSON.stringify(p));
}

export function toggleFavoriteModel(model: string): ModelPrefs {
  const prefs = loadModelPrefs();
  const favorites = prefs.favorites.includes(model)
    ? prefs.favorites.filter((m) => m !== model)
    : [model, ...prefs.favorites].slice(0, 10);
  const next = { ...prefs, favorites };
  saveModelPrefs(next);
  return next;
}

export function rememberRecentModel(model: string): ModelPrefs {
  const prefs = loadModelPrefs();
  const recents = [model, ...prefs.recents.filter((m) => m !== model)].slice(0, 5);
  const next = { ...prefs, recents };
  saveModelPrefs(next);
  return next;
}

export interface LLMResult {
  content: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface LLMOverride {
  model?: string;
  provider?: string;
  baseUrl?: string;
}

/** Resolve which API key applies for a provider (per-provider map first). */
export function resolveKey(s: LLMSettings, provider: string): string {
  if (!providerNeedsKey(provider)) return '';
  const per = s.apiKeys?.[provider];
  if (per) return per;
  if (provider === s.provider) return s.apiKey || '';
  // Legacy installs stored a single key with no per-provider map.
  if (!s.apiKeys || Object.keys(s.apiKeys).length === 0) return '';
  return '';
}

export function endpoint(s: LLMSettings, override?: LLMOverride) {
  const provider = override?.provider ?? s.provider;
  const baseUrl = (override?.baseUrl ?? s.baseUrl).replace(/\/+$/, '');
  const model = override?.model ?? s.model;
  return { provider, baseUrl, model };
}

/** True when running inside the Tauri desktop shell (Rust backend available). */
export function inTauri(): boolean {
  return (
    typeof window !== 'undefined' &&
    !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  );
}

export async function callLLM(
  messages: { role: string; content: string }[],
  override?: LLMOverride
): Promise<LLMResult> {
  const s = loadLLMSettings();
  const { provider, baseUrl, model } = endpoint(s, override);
  const apiKey = resolveKey(s, provider);
  if (!apiKey && providerNeedsKey(provider))
    throw new Error(`No API key for ${provider}. Open Settings → AI Model and save a key for it.`);

  if (inTauri()) {
    return await invoke<LLMResult>("llm_chat", {
      provider,
      baseUrl,
      apiKey,
      model,
      messages,
    });
  }

  // Browser fallback: hit the provider endpoint directly (the Rust backend
  // isn't available outside the desktop app). Same payload the llm_chat
  // command builds.
  let res: Response;
  try {
    const kind = providerKind(provider);
    if (kind === 'anthropic') {
      const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
      const rest = messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role, content: m.content }));
      res = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model,
          max_tokens: 2048,
          temperature: 0.4,
          ...(system ? { system } : {}),
          messages: rest,
        }),
      });
    } else if (kind === 'gemini') {
      const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
      const contents = messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
      res = await fetch(`${baseUrl}/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          contents,
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
          generationConfig: { maxOutputTokens: 2048, temperature: 0.4 },
        }),
      });
    } else {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: 2048,
          temperature: 0.4,
        }),
      });
    }
  } catch {
    throw new Error(
      'Network request to the LLM provider failed. If the provider blocks browser requests (CORS), run the desktop app: npm run tauri dev.'
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`LLM request failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as any;
  const kind = providerKind(provider);
  let content = '';
  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  if (kind === 'anthropic') {
    content = (data.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    usage = {
      prompt_tokens: data.usage?.input_tokens ?? 0,
      completion_tokens: data.usage?.output_tokens ?? 0,
      total_tokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
    };
  } else if (kind === 'gemini') {
    content = (data.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? '').join('');
    usage = {
      prompt_tokens: data.usageMetadata?.promptTokenCount ?? 0,
      completion_tokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      total_tokens: data.usageMetadata?.totalTokenCount ?? 0,
    };
  } else {
    content = data.choices?.[0]?.message?.content ?? '';
    usage = {
      prompt_tokens: data.usage?.prompt_tokens ?? 0,
      completion_tokens: data.usage?.completion_tokens ?? 0,
      total_tokens: data.usage?.total_tokens ?? 0,
    };
  }
  return { content, usage };
}
