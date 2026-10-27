// Streaming chat completions. Desktop app: Rust llm_chat_stream via Tauri
// Channel. Browser: direct fetch SSE. onDelta gets the accumulated text.

import { invoke, Channel } from "@tauri-apps/api/core";
import {
  loadLLMSettings,
  providerKind,
  providerNeedsKey,
  resolveKey,
  endpoint,
  type LLMResult,
  type LLMOverride,
  type ToolCall,
  type ToolDef,
} from './llm';

export async function callLLMStream(
  messages: { role: string; content: string }[],
  override?: LLMOverride,
  onDelta?: (fullSoFar: string) => void,
  tools?: ToolDef[]
): Promise<LLMResult> {
  const s = loadLLMSettings();
  const { provider, baseUrl, model } = endpoint(s, override);
  const apiKey = resolveKey(s, provider);
  if (!apiKey && providerNeedsKey(provider))
    throw new Error(`No API key for ${provider}. Open Settings → AI Model and save a key for it.`);

  if (inTauri()) {
    return await tauriStream(provider, baseUrl, apiKey, model, messages, onDelta, tools);
  }
  return await browserStream(provider, baseUrl, apiKey, model, messages, onDelta, tools);
}

function inTauri(): boolean {
  return (
    typeof window !== 'undefined' &&
    !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  );
}

type StreamEvt =
  | { type: 'delta'; text: string }
  | { type: 'usage'; prompt_tokens: number; completion_tokens: number; total_tokens: number };

async function tauriStream(
  provider: string,
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: { role: string; content: string }[],
  onDelta?: (fullSoFar: string) => void,
  tools?: ToolDef[]
): Promise<LLMResult> {
  let full = '';
  let scheduled = false;
  const channel = new Channel<StreamEvt>();
  channel.onmessage = (msg) => {
    if (msg.type === 'delta') {
      full += msg.text;
      if (!scheduled) {
        scheduled = true;
        setTimeout(() => {
          scheduled = false;
          onDelta?.(full);
        }, 60);
      }
    }
    // usage is delivered via the invoke result
  };
  const result = await invoke<LLMResult>('llm_chat_stream', {
    provider,
    baseUrl,
    apiKey,
    model,
    messages,
    tools: tools ?? null,
    onEvent: channel,
  });
  onDelta?.(result.content); // final flush with the exact text
  return result;
}

async function browserStream(
  provider: string,
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: { role: string; content: string }[],
  onDelta?: (fullSoFar: string) => void,
  tools?: ToolDef[]
): Promise<LLMResult> {
  const kind = providerKind(provider);
  let res: Response;
  try {
    res = await fetch(buildSSEUrl(kind, baseUrl, model), {
      method: 'POST',
      headers: sseHeaders(kind, apiKey),
      body: JSON.stringify(sseBody(kind, model, messages, tools)),
    });
  } catch {
    throw new Error(
      'Network request to the LLM provider failed. If the provider blocks browser requests (CORS), run the desktop app: npm run tauri dev.'
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const hint = /model_not_found|does not exist or you do not have access|not a valid model/.test(body)
      ? ' - the provider may have retired this model; pick another under Settings > AI Model'
      : '';
    throw new Error(`LLM request failed (${res.status}): ${body.slice(0, 300)}${hint}`);
  }
  if (!res.body) throw new Error('Streaming is not supported by this response.');
  return parseSSE(kind, res.body, onDelta, messages);
}

function buildSSEUrl(kind: string, baseUrl: string, model: string): string {
  if (kind === 'anthropic') return `${baseUrl}/v1/messages`;
  if (kind === 'gemini') return `${baseUrl}/v1beta/models/${model}:streamGenerateContent?alt=sse`;
  return `${baseUrl}/chat/completions`;
}

function sseHeaders(kind: string, apiKey: string): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (kind === 'anthropic') {
    h['x-api-key'] = apiKey;
    h['anthropic-version'] = '2023-06-01';
    h['anthropic-dangerous-direct-browser-access'] = 'true';
  } else if (kind === 'gemini') {
    h['x-goog-api-key'] = apiKey;
  } else if (apiKey) {
    h['Authorization'] = `Bearer ${apiKey}`;
  }
  return h;
}

function sseBody(
  kind: string,
  model: string,
  messages: { role: string; content: string }[],
  tools?: ToolDef[]
): Record<string, unknown> {
  if (kind === 'anthropic') {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const rest = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));
    return {
      model,
      max_tokens: 4096,
      temperature: 0.4,
      ...(system ? { system } : {}),
      messages: rest,
      stream: true,
      ...(tools?.length
        ? {
            tools: tools.map((d) => ({
              name: d.name,
              description: d.description,
              input_schema: d.parameters,
            })),
          }
        : {}),
    };
  }
  if (kind === 'gemini') {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    return {
      contents,
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      generationConfig: { maxOutputTokens: 4096, temperature: 0.4 },
      ...(tools?.length
        ? {
            tools: [
              {
                functionDeclarations: tools.map((d) => ({
                  name: d.name,
                  description: d.description,
                  parameters: geminiSchema(d.parameters),
                })),
              },
            ],
          }
        : {}),
    };
  }
  return {
    model,
    messages,
    max_tokens: 4096,
    temperature: 0.4,
    stream: true,
    ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
  };
}

/** Gemini wants OpenAPI-style uppercase type names. */
function geminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(geminiSchema);
  if (schema && typeof schema === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
      out[k] = k === 'type' && typeof v === 'string' ? v.toUpperCase() : geminiSchema(v);
    }
    return out;
  }
  return schema;
}

async function parseSSE(
  kind: string,
  body: ReadableStream<Uint8Array>,
  onDelta: ((fullSoFar: string) => void) | undefined,
  messages: { role: string; content: string }[]
): Promise<LLMResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const acc = { full: '' };
  let lastFlush = 0;
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const toolAcc: {
    openai: Map<number, ToolCall>;
    anthropic: Map<number, ToolCall>;
    gemini: ToolCall[];
  } = { openai: new Map(), anthropic: new Map(), gemini: [] };
  const flush = (force = false) => {
    const now = Date.now();
    if (force || now - lastFlush >= 60) {
      lastFlush = now;
      onDelta?.(acc.full);
    }
  };
  const handleData = makeHandler(kind, acc, usage, toolAcc, flush);

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trimEnd();
      buf = buf.slice(idx + 1);
      if (line.startsWith('data:')) handleData(line.slice(5).trim());
    }
  }
  const tail = buf.trim();
  if (tail.startsWith('data:')) handleData(tail.slice(5).trim());
  if (usage.total_tokens === 0 && (usage.prompt_tokens > 0 || usage.completion_tokens > 0)) {
    usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
  }
  if (usage.total_tokens === 0) {
    const pc = messages.reduce((n, m) => n + m.content.length, 0);
    const cc = [...toolAcc.openai.values(), ...toolAcc.anthropic.values(), ...toolAcc.gemini]
      .map((t) => t.arguments.length)
      .reduce((a, b) => a + b, 0);
    usage.prompt_tokens = Math.floor(pc / 4);
    usage.completion_tokens = Math.floor((acc.full.length + cc) / 4);
    usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
  }
  flush(true);
  const calls = [...toolAcc.openai.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, t]) => t)
    .concat([...toolAcc.anthropic.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t), toolAcc.gemini)
    .filter((t) => t.name);
  return { content: acc.full, usage, ...(calls.length ? { tool_calls: calls } : {}) };
}

function makeHandler(
  kind: string,
  acc: { full: string },
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
  toolAcc: {
    openai: Map<number, ToolCall>;
    anthropic: Map<number, ToolCall>;
    gemini: ToolCall[];
  },
  flush: (force?: boolean) => void
): (data: string) => void {
  return (data: string) => {
    if (!data || data === '[DONE]') return;
    let v: any;
    try {
      v = JSON.parse(data);
    } catch {
      return;
    }
    if (kind === 'anthropic') {
      if (v.type === 'content_block_start' && v.content_block?.type === 'tool_use') {
        toolAcc.anthropic.set(v.index ?? 0, {
          id: v.content_block.id ?? '',
          name: v.content_block.name ?? '',
          arguments: '',
        });
      } else if (v.type === 'content_block_delta') {
        if (typeof v.delta?.text === 'string' && v.delta.text) {
          acc.full += v.delta.text;
          flush();
        }
        if (v.delta?.type === 'input_json_delta' && typeof v.delta.partial_json === 'string') {
          const t = toolAcc.anthropic.get(v.index ?? 0);
          if (t) t.arguments += v.delta.partial_json;
        }
      } else if (v.type === 'message_start') {
        usage.prompt_tokens = v.message?.usage?.input_tokens ?? 0;
      } else if (v.type === 'message_delta') {
        usage.completion_tokens = v.usage?.output_tokens ?? usage.completion_tokens;
      } else if (v.type === 'error') {
        throw new Error(`LLM stream error: ${v.error?.message ?? 'unknown'}`);
      }
      return;
    }
    if (kind === 'gemini') {
      if (v.error) throw new Error(`LLM stream error: ${v.error.message ?? 'unknown'}`);
      for (const p of v.candidates?.[0]?.content?.parts ?? []) {
        if (typeof p.text === 'string' && p.text) {
          acc.full += p.text;
          flush();
        }
        if (p.functionCall?.name) {
          toolAcc.gemini.push({
            id: `call_${toolAcc.gemini.length}`,
            name: p.functionCall.name,
            arguments: JSON.stringify(p.functionCall.args ?? {}),
          });
        }
      }
      if (v.usageMetadata) {
        usage.prompt_tokens = v.usageMetadata.promptTokenCount ?? usage.prompt_tokens;
        usage.completion_tokens = v.usageMetadata.candidatesTokenCount ?? usage.completion_tokens;
        usage.total_tokens = v.usageMetadata.totalTokenCount ?? usage.total_tokens;
      }
      return;
    }
    const delta = v.choices?.[0]?.delta;
    const t = delta?.content;
    if (typeof t === 'string' && t) {
      acc.full += t;
      flush();
    }
    for (const tc of delta?.tool_calls ?? []) {
      const idx = typeof tc.index === 'number' ? tc.index : 0;
      const cur = toolAcc.openai.get(idx) ?? { id: '', name: '', arguments: '' };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name += tc.function.name;
      if (typeof tc.function?.arguments === 'string') cur.arguments += tc.function.arguments;
      toolAcc.openai.set(idx, cur);
    }
    if (v.usage) {
      usage.prompt_tokens = v.usage.prompt_tokens ?? usage.prompt_tokens;
      usage.completion_tokens = v.usage.completion_tokens ?? usage.completion_tokens;
      usage.total_tokens = v.usage.total_tokens ?? usage.total_tokens;
    }
  };
}
