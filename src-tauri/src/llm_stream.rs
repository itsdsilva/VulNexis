// LLM streaming: SSE from the provider, forwarded to the webview as Tauri
// Channel events ({type:"delta",text} and {type:"usage",...}). Native tool
// calls are accumulated from the stream and returned in the invoke result.

use crate::{build_chat_request, provider_kind, ChatMessage, ChatUsage, ProviderKind};
use futures_util::StreamExt;
use serde::Serialize;
use std::collections::BTreeMap;
use std::time::Duration;
use tauri::ipc::Channel;

#[derive(Clone, Serialize)]
#[serde(tag = "type")]
pub enum LlmStreamEvent {
    #[serde(rename = "delta")]
    Delta { text: String },
    #[serde(rename = "usage")]
    Usage {
        prompt_tokens: u64,
        completion_tokens: u64,
        total_tokens: u64,
    },
}

/// Accumulates streamed tool-call fragments. OpenAI streams partial
/// function-call JSON by index; Anthropic streams input_json_delta by block
/// index; Gemini delivers whole functionCall parts.
#[derive(Default)]
pub(crate) struct ToolAcc {
    openai: BTreeMap<u64, (String, String, String)>, // id, name, args
    anthropic: BTreeMap<u64, (String, String, String)>, // id, name, args
    gemini: Vec<(String, String)>,                   // name, args
}

impl ToolAcc {
    /// Finalize into [{id, name, arguments}] sorted by stream order.
    pub(crate) fn finish(&self) -> Vec<serde_json::Value> {
        let mut out: Vec<serde_json::Value> = Vec::new();
        for (_, (id, name, args)) in self.openai.iter() {
            out.push(serde_json::json!({ "id": id, "name": name, "arguments": args }));
        }
        for (_, (id, name, args)) in self.anthropic.iter() {
            out.push(serde_json::json!({ "id": id, "name": name, "arguments": args }));
        }
        for (n, (name, args)) in self.gemini.iter().enumerate() {
            out.push(serde_json::json!({ "id": format!("call_{n}"), "name": name, "arguments": args }));
        }
        out.retain(|tc| !tc["name"].as_str().unwrap_or("").is_empty());
        out
    }
}

/// Handle one SSE `data:` line for the given provider. Emits delta events,
/// accumulates usage and tool-call fragments. Returns Err on provider errors.
fn process_sse_line(
    kind: ProviderKind,
    data: &str,
    full: &mut String,
    usage: &mut ChatUsage,
    acc: &mut ToolAcc,
    on_event: &Channel<LlmStreamEvent>,
) -> Result<(), String> {
    if data.is_empty() || data == "[DONE]" {
        return Ok(());
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(data) else {
        return Ok(()); // keep-alive or partial line — ignore
    };
    match kind {
        ProviderKind::OpenAICompat => {
            if let Some(t) = v["choices"][0]["delta"]["content"].as_str() {
                if !t.is_empty() {
                    full.push_str(t);
                    let _ = on_event.send(LlmStreamEvent::Delta { text: t.to_string() });
                }
            }
            if let Some(tcs) = v["choices"][0]["delta"]["tool_calls"].as_array() {
                for tc in tcs {
                    let idx = tc["index"].as_u64().unwrap_or(0);
                    let e = acc
                        .openai
                        .entry(idx)
                        .or_insert_with(|| (String::new(), String::new(), String::new()));
                    if let Some(id) = tc["id"].as_str() {
                        e.0 = id.to_string();
                    }
                    if let Some(n) = tc["function"]["name"].as_str() {
                        e.1.push_str(n);
                    }
                    if let Some(a) = tc["function"]["arguments"].as_str() {
                        e.2.push_str(a);
                    }
                }
            }
            if v["usage"].is_object() {
                usage.prompt_tokens = v["usage"]["prompt_tokens"].as_u64().unwrap_or(usage.prompt_tokens);
                usage.completion_tokens = v["usage"]["completion_tokens"]
                    .as_u64()
                    .unwrap_or(usage.completion_tokens);
                usage.total_tokens = v["usage"]["total_tokens"].as_u64().unwrap_or(usage.total_tokens);
            }
            Ok(())
        }
        ProviderKind::Anthropic => match v["type"].as_str().unwrap_or("") {
            "content_block_start" => {
                if v["content_block"]["type"] == "tool_use" {
                    let idx = v["index"].as_u64().unwrap_or(0);
                    acc.anthropic.insert(
                        idx,
                        (
                            v["content_block"]["id"].as_str().unwrap_or("").to_string(),
                            v["content_block"]["name"].as_str().unwrap_or("").to_string(),
                            String::new(),
                        ),
                    );
                }
                Ok(())
            }
            "content_block_delta" => {
                if let Some(t) = v["delta"]["text"].as_str() {
                    if !t.is_empty() {
                        full.push_str(t);
                        let _ = on_event.send(LlmStreamEvent::Delta { text: t.to_string() });
                    }
                }
                if v["delta"]["type"] == "input_json_delta" {
                    if let Some(pj) = v["delta"]["partial_json"].as_str() {
                        let idx = v["index"].as_u64().unwrap_or(0);
                        acc.anthropic
                            .entry(idx)
                            .or_insert_with(|| (String::new(), String::new(), String::new()))
                            .2
                            .push_str(pj);
                    }
                }
                Ok(())
            }
            "message_start" => {
                usage.prompt_tokens = v["message"]["usage"]["input_tokens"].as_u64().unwrap_or(0);
                Ok(())
            }
            "message_delta" => {
                usage.completion_tokens = v["usage"]["output_tokens"].as_u64().unwrap_or(usage.completion_tokens);
                Ok(())
            }
            "error" => Err(format!(
                "LLM stream error: {}",
                v["error"]["message"].as_str().unwrap_or("unknown")
            )),
            _ => Ok(()),
        },
        ProviderKind::Gemini => {
            if v["error"].is_object() {
                return Err(format!(
                    "LLM stream error: {}",
                    v["error"]["message"].as_str().unwrap_or("unknown")
                ));
            }
            if let Some(parts) = v["candidates"][0]["content"]["parts"].as_array() {
                for p in parts {
                    if let Some(t) = p["text"].as_str() {
                        if !t.is_empty() {
                            full.push_str(t);
                            let _ = on_event.send(LlmStreamEvent::Delta { text: t.to_string() });
                        }
                    }
                    if p["functionCall"].is_object() {
                        let name = p["functionCall"]["name"].as_str().unwrap_or("").to_string();
                        let args =
                            serde_json::to_string(&p["functionCall"]["args"]).unwrap_or_default();
                        if !name.is_empty() {
                            acc.gemini.push((name, args));
                        }
                    }
                }
            }
            if v["usageMetadata"].is_object() {
                let u = &v["usageMetadata"];
                usage.prompt_tokens = u["promptTokenCount"].as_u64().unwrap_or(usage.prompt_tokens);
                usage.completion_tokens = u["candidatesTokenCount"]
                    .as_u64()
                    .unwrap_or(usage.completion_tokens);
                usage.total_tokens = u["totalTokenCount"].as_u64().unwrap_or(usage.total_tokens);
            }
            Ok(())
        }
    }
}

#[tauri::command]
pub async fn llm_chat_stream(
    provider: String,
    base_url: String,
    api_key: String,
    model: String,
    messages: Vec<ChatMessage>,
    tools: Option<Vec<serde_json::Value>>,
    on_event: Channel<LlmStreamEvent>,
) -> Result<serde_json::Value, String> {
    let kind = provider_kind(&provider);
    let rb = build_chat_request(
        kind,
        &base_url,
        &api_key,
        &model,
        &messages,
        true,
        tools.as_deref(),
    )?;
    let resp = rb
        .timeout(Duration::from_secs(600))
        .send()
        .await
        .map_err(|e| format!("LLM request failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        let hint = if text.contains("model_not_found")
            || text.contains("does not exist or you do not have access")
            || text.contains("not a valid model")
        {
            " - the provider may have retired this model; pick another under Settings > AI Model"
        } else {
            ""
        };
        return Err(format!(
            "LLM error (status {status}): {}{hint}",
            text.chars().take(400).collect::<String>()
        ));
    }

    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut full = String::new();
    let mut usage = ChatUsage {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
    };
    let mut acc = ToolAcc::default();

    loop {
        let chunk = match stream.next().await {
            Some(Ok(b)) => b,
            Some(Err(e)) => return Err(format!("stream read failed: {e}")),
            None => break,
        };
        buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(pos) = buf.find('\n') {
            let line: String = buf.drain(..=pos).collect();
            let line = line.trim_end();
            if let Some(data) = line.strip_prefix("data:") {
                process_sse_line(kind, data.trim(), &mut full, &mut usage, &mut acc, &on_event)?;
            }
        }
    }
    // Flush a trailing line that never got its newline.
    if let Some(data) = buf.trim().strip_prefix("data:") {
        let _ = process_sse_line(kind, data.trim(), &mut full, &mut usage, &mut acc, &on_event);
    }

    let tool_calls = acc.finish();
    if usage.total_tokens == 0 && (usage.prompt_tokens > 0 || usage.completion_tokens > 0) {
        usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
    }
    // Some providers don't report usage on streams; estimate from character
    // counts so budgets and cost tracking keep working. Tool-call arguments
    // count toward completion tokens too.
    if usage.total_tokens == 0 {
        let prompt_chars: usize = messages.iter().map(|m| m.content.len()).sum();
        let calls_chars: usize = tool_calls
            .iter()
            .map(|tc| tc["arguments"].as_str().map(|s| s.len()).unwrap_or(0))
            .sum();
        usage.prompt_tokens = (prompt_chars as u64) / 4;
        usage.completion_tokens = ((full.len() + calls_chars) as u64) / 4;
        usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
    }
    let _ = on_event.send(LlmStreamEvent::Usage {
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens,
    });
    Ok(serde_json::json!({ "content": full, "usage": usage, "tool_calls": tool_calls }))
}
