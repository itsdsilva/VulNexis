// LLM streaming: SSE from the provider, forwarded to the webview as Tauri
// Channel events ({type:"delta",text} and {type:"usage",...}).

use crate::{build_chat_request, provider_kind, ChatMessage, ChatUsage, ProviderKind};
use futures_util::StreamExt;
use serde::Serialize;
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

/// Handle one SSE `data:` line for the given provider. Emits delta events and
/// accumulates usage. Returns Err on provider-reported errors.
fn process_sse_line(
    kind: ProviderKind,
    data: &str,
    full: &mut String,
    usage: &mut ChatUsage,
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
            "content_block_delta" => {
                if let Some(t) = v["delta"]["text"].as_str() {
                    if !t.is_empty() {
                        full.push_str(t);
                        let _ = on_event.send(LlmStreamEvent::Delta { text: t.to_string() });
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
    on_event: Channel<LlmStreamEvent>,
) -> Result<serde_json::Value, String> {
    let kind = provider_kind(&provider);
    let rb = build_chat_request(kind, &base_url, &api_key, &model, &messages, true)?;
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
                process_sse_line(kind, data.trim(), &mut full, &mut usage, &on_event)?;
            }
        }
    }
    // Flush a trailing line that never got its newline.
    if let Some(data) = buf.trim().strip_prefix("data:") {
        let _ = process_sse_line(kind, data.trim(), &mut full, &mut usage, &on_event);
    }

    if usage.total_tokens == 0 && (usage.prompt_tokens > 0 || usage.completion_tokens > 0) {
        usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
    }
    // Some providers don't report usage on streams; estimate from character
    // counts so budgets and cost tracking keep working.
    if usage.total_tokens == 0 {
        let prompt_chars: usize = messages.iter().map(|m| m.content.len()).sum();
        usage.prompt_tokens = (prompt_chars as u64) / 4;
        usage.completion_tokens = (full.len() as u64) / 4;
        usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
    }
    let _ = on_event.send(LlmStreamEvent::Usage {
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens,
    });
    Ok(serde_json::json!({ "content": full, "usage": usage }))
}
