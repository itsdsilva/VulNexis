use russh::client::{self, Handle};
use russh::keys::PublicKey;
use russh::{ChannelMsg, Disconnect};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Mutex;
use std::time::Duration;
use tauri::State;
use chromiumoxide::browser::{Browser, BrowserConfig};
use chromiumoxide::cdp::browser_protocol::page;
use chromiumoxide::Page;
use futures_util::StreamExt;
use std::sync::Arc as StdArc;
use base64::Engine as _;

#[derive(Default)]
struct SshState {
    handle: Mutex<Option<Handle<ClientHandler>>>,
}

struct BrowserState {
    browser: Mutex<Option<Browser>>,
    page: Mutex<Option<Arc<Page>>>,
}

// ---------- LLM (multi-provider) ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ChatMessage {
    pub(crate) role: String,
    pub(crate) content: String,
}

#[derive(Deserialize, Serialize)]
pub(crate) struct ChatUsage {
    pub(crate) prompt_tokens: u64,
    pub(crate) completion_tokens: u64,
    pub(crate) total_tokens: u64,
}

#[derive(Clone, Copy, PartialEq)]
pub(crate) enum ProviderKind {
    /// OpenAI-compatible /chat/completions (OpenRouter, OpenAI, Groq, Cerebras, DeepSeek, Ollama, ...)
    OpenAICompat,
    /// Anthropic Messages API (/v1/messages)
    Anthropic,
    /// Google Gemini generateContent API
    Gemini,
}

fn provider_kind(provider: &str) -> ProviderKind {
    match provider {
        "Anthropic" => ProviderKind::Anthropic,
        "Gemini" => ProviderKind::Gemini,
        _ => ProviderKind::OpenAICompat,
    }
}

pub(crate) const MAX_TOKENS: u32 = 2048;
pub(crate) const TEMPERATURE: f32 = 0.4;

pub(crate) fn truncate_str(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// Build a provider-specific request. `messages` is always the OpenAI-style
/// [{role, content}] shape; this adapts the payload, auth headers and URL.
pub(crate) fn build_chat_request(
    kind: ProviderKind,
    base_url: &str,
    api_key: &str,
    model: &str,
    messages: &[ChatMessage],
    stream: bool,
) -> Result<reqwest::RequestBuilder, String> {
    let client = reqwest::Client::new();
    let base = base_url.trim_end_matches('/');
    match kind {
        ProviderKind::OpenAICompat => {
            let url = format!("{base}/chat/completions");
            let mut rb = client
                .post(&url)
                .header("Content-Type", "application/json")
                .json(&serde_json::json!({
                    "model": model,
                    "messages": messages,
                    "max_tokens": MAX_TOKENS,
                    "temperature": TEMPERATURE,
                    "stream": stream,
                }));
            if !api_key.is_empty() {
                rb = rb.header("Authorization", format!("Bearer {api_key}"));
            }
            Ok(rb)
        }
        ProviderKind::Anthropic => {
            let url = format!("{base}/v1/messages");
            let system: Vec<&str> = messages
                .iter()
                .filter(|m| m.role == "system")
                .map(|m| m.content.as_str())
                .collect();
            // Anthropic requires alternating user/assistant turns; merge runs
            // of same-role messages (tool output arrives as user turns).
            let mut merged: Vec<serde_json::Value> = Vec::new();
            for m in messages.iter().filter(|m| m.role != "system") {
                let role = if m.role == "assistant" { "assistant" } else { "user" };
                if let Some(last) = merged.last_mut() {
                    if last["role"] == serde_json::json!(role) {
                        let prev = last["content"].as_str().unwrap_or_default().to_string();
                        last["content"] = serde_json::json!(format!("{prev}\n\n{}", m.content));
                        continue;
                    }
                }
                merged.push(serde_json::json!({"role": role, "content": m.content}));
            }
            if merged.is_empty() {
                merged.push(serde_json::json!({"role": "user", "content": "Hello"}));
            }
            let mut body = serde_json::json!({
                "model": model,
                "max_tokens": MAX_TOKENS,
                "temperature": TEMPERATURE,
                "messages": merged,
                "stream": stream,
            });
            if !system.is_empty() {
                body["system"] = serde_json::json!(system.join("\n\n"));
            }
            Ok(client
                .post(&url)
                .header("Content-Type", "application/json")
                .header("x-api-key", api_key)
                .header("anthropic-version", "2023-06-01")
                .json(&body))
        }
        ProviderKind::Gemini => {
            let action = if stream {
                "streamGenerateContent?alt=sse"
            } else {
                "generateContent"
            };
            let url = format!("{base}/v1beta/models/{model}:{action}");
            let system: Vec<&str> = messages
                .iter()
                .filter(|m| m.role == "system")
                .map(|m| m.content.as_str())
                .collect();
            let contents: Vec<serde_json::Value> = messages
                .iter()
                .filter(|m| m.role != "system")
                .map(|m| {
                    let role = if m.role == "assistant" { "model" } else { "user" };
                    serde_json::json!({"role": role, "parts": [{"text": m.content}]})
                })
                .collect();
            let mut body = serde_json::json!({
                "contents": contents,
                "generationConfig": {"maxOutputTokens": MAX_TOKENS, "temperature": TEMPERATURE},
            });
            if !system.is_empty() {
                body["systemInstruction"] =
                    serde_json::json!({"parts": [{"text": system.join("\n\n")}]});
            }
            Ok(client
                .post(&url)
                .header("Content-Type", "application/json")
                .header("x-goog-api-key", api_key)
                .json(&body))
        }
    }
}

/// Extract (content, usage) from a non-streaming response body.
fn extract_answer(kind: ProviderKind, body: &serde_json::Value) -> Result<(String, ChatUsage), String> {
    match kind {
        ProviderKind::OpenAICompat => {
            let content = body["choices"][0]["message"]["content"]
                .as_str()
                .map(|s| s.to_string())
                .ok_or_else(|| {
                    format!("LLM returned no choices: {}", truncate_str(&body.to_string(), 300))
                })?;
            let usage = ChatUsage {
                prompt_tokens: body["usage"]["prompt_tokens"].as_u64().unwrap_or(0),
                completion_tokens: body["usage"]["completion_tokens"].as_u64().unwrap_or(0),
                total_tokens: body["usage"]["total_tokens"].as_u64().unwrap_or(0),
            };
            Ok((content, usage))
        }
        ProviderKind::Anthropic => {
            let mut content = String::new();
            if let Some(blocks) = body["content"].as_array() {
                for b in blocks {
                    if b["type"] == "text" {
                        if let Some(t) = b["text"].as_str() {
                            content.push_str(t);
                        }
                    }
                }
            }
            if content.is_empty() {
                return Err(format!("Anthropic returned no text: {}", truncate_str(&body.to_string(), 300)));
            }
            let pt = body["usage"]["input_tokens"].as_u64().unwrap_or(0);
            let ct = body["usage"]["output_tokens"].as_u64().unwrap_or(0);
            Ok((content, ChatUsage { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct }))
        }
        ProviderKind::Gemini => {
            let mut content = String::new();
            if let Some(parts) = body["candidates"][0]["content"]["parts"].as_array() {
                for p in parts {
                    if let Some(t) = p["text"].as_str() {
                        content.push_str(t);
                    }
                }
            }
            if content.is_empty() {
                return Err(format!("Gemini returned no text: {}", truncate_str(&body.to_string(), 300)));
            }
            let u = &body["usageMetadata"];
            Ok((
                content,
                ChatUsage {
                    prompt_tokens: u["promptTokenCount"].as_u64().unwrap_or(0),
                    completion_tokens: u["candidatesTokenCount"].as_u64().unwrap_or(0),
                    total_tokens: u["totalTokenCount"].as_u64().unwrap_or(0),
                },
            ))
        }
    }
}

#[tauri::command]
async fn llm_chat(
    provider: String,
    base_url: String,
    api_key: String,
    model: String,
    messages: Vec<ChatMessage>,
) -> Result<serde_json::Value, String> {
    let kind = provider_kind(&provider);
    let rb = build_chat_request(kind, &base_url, &api_key, &model, &messages, false)?;
    let resp = rb
        .timeout(Duration::from_secs(120))
        .send()
        .await
        .map_err(|e| format!("LLM request failed: {e}"))?;

    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("LLM read failed (status {status}): {e}"))?;

    if !status.is_success() {
        let snippet = truncate_str(&text, 400);
        return Err(format!("LLM error (status {status}): {snippet}"));
    }

    let body: serde_json::Value = serde_json::from_str(&text).map_err(|e| {
        format!(
            "LLM bad response (status {status}): {e} — body: {}",
            truncate_str(&text, 200)
        )
    })?;

    let (content, usage) = extract_answer(kind, &body)?;
    Ok(serde_json::json!({ "content": content, "usage": usage }))
}

// ---------- LLM streaming (SSE -> Tauri Channel) ----------

pub(crate) mod llm_stream;

struct ClientHandler;

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(&mut self, _server_public_key: &PublicKey) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

#[tauri::command]
async fn ssh_connect(
    host: String,
    port: u16,
    username: String,
    password: String,
    state: State<'_, SshState>,
) -> Result<String, String> {
    let config = client::Config {
        inactivity_timeout: Some(Duration::from_secs(600)),
        keepalive_interval: Some(Duration::from_secs(30)),
        ..Default::default()
    };
    let config = Arc::new(config);

    let connect_fut = client::connect(config, (host.as_str(), port), ClientHandler);
    let mut handle = tokio::time::timeout(Duration::from_secs(15), connect_fut)
        .await
        .map_err(|_| "Connection timed out (15s). Check the VM IP and that the VM is running.".to_string())?
        .map_err(|e| format!("Handshake failed: {e}"))?;

    let auth = tokio::time::timeout(
        Duration::from_secs(15),
        handle.authenticate_password(&username, &password),
    )
    .await
    .map_err(|_| "Authentication timed out".to_string())?
    .map_err(|e| format!("Authentication failed: {e}"))?;

    if !auth.success() {
        return Err("Authentication rejected: wrong username or password".to_string());
    }

    let mut guard = state.handle.lock().await;
    *guard = Some(handle);
    Ok("Connected".to_string())
}

#[tauri::command]
async fn ssh_disconnect(state: State<'_, SshState>) -> Result<String, String> {
    let mut guard = state.handle.lock().await;
    if let Some(h) = guard.take() {
        let _ = h
            .disconnect(Disconnect::ByApplication, "user disconnect", "en")
            .await;
    }
    Ok("Disconnected".to_string())
}

#[tauri::command]
async fn ssh_exec(command: String, state: State<'_, SshState>) -> Result<String, String> {
    let mut guard = state.handle.lock().await;
    let handle = guard.as_mut().ok_or("Not connected")?;
    exec_on(handle, &command, 120).await
}

#[tauri::command]
async fn ssh_detect_tools(state: State<'_, SshState>) -> Result<Vec<ToolInfo>, String> {
    let tools = [
        "nmap", "httpx", "subfinder", "naabu", "nuclei", "katana", "ffuf",
        "gau", "assetfinder", "waybackurls", "dnsx", "whatweb", "dirb",
        "gobuster", "nikto", "sqlmap", "amass", "masscan", "curl", "wget",
    ];

    let mut guard = state.handle.lock().await;
    let handle = guard.as_mut().ok_or("Not connected")?;

    let mut results = Vec::new();
    for tool in tools {
        let cmd = format!("command -v {tool} 2>/dev/null && echo __EXISTS__ || echo __MISSING__");
        let out = match exec_on(handle, &cmd, 30).await {
            Ok(o) => o,
            Err(_) => {
                results.push(ToolInfo {
                    name: tool.to_string(),
                    available: false,
                    path: String::new(),
                });
                continue;
            }
        };
        let available = out.contains("__EXISTS__");
        let path = out
            .lines()
            .map(|l| l.trim())
            .find(|l| !l.is_empty() && !l.starts_with("__") && !l.starts_with("[exit"))
            .unwrap_or("")
            .to_string();
        results.push(ToolInfo {
            name: tool.to_string(),
            available,
            path,
        });
    }
    Ok(results)
}

async fn exec_on(
    handle: &mut Handle<ClientHandler>,
    command: &str,
    timeout_secs: u64,
) -> Result<String, String> {
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("Failed to open channel: {e}"))?;

    channel
        .exec(true, command)
        .await
        .map_err(|e| format!("Failed to exec: {e}"))?;

    let mut stdout: Vec<u8> = Vec::new();
    let mut stderr: Vec<u8> = Vec::new();
    let mut exit_code: Option<u32> = None;

    loop {
        match tokio::time::timeout(Duration::from_secs(timeout_secs), channel.wait()).await {
            Err(_) => break,
            Ok(None) => break,
            Ok(Some(ChannelMsg::Data { ref data })) => stdout.extend_from_slice(data),
            Ok(Some(ChannelMsg::ExtendedData { ref data, .. })) => stderr.extend_from_slice(data),
            Ok(Some(ChannelMsg::ExitStatus { exit_status })) => exit_code = Some(exit_status),
            Ok(Some(_)) => {}
        }
    }

    let mut out = String::from_utf8_lossy(&stdout).to_string();
    let err = String::from_utf8_lossy(&stderr).to_string();
    if !err.trim().is_empty() {
        out.push_str("\n--- stderr ---\n");
        out.push_str(&err);
    }
    if let Some(code) = exit_code {
        out.push_str(&format!("\n[exit: {code}]"));
    }
    Ok(out)
}

#[derive(serde::Serialize)]
struct ToolInfo {
    name: String,
    available: bool,
    path: String,
}

// ---------- HTTP inspector ----------

#[derive(Deserialize)]
struct HttpFetchReq {
    url: String,
    method: Option<String>,
    headers: Option<Vec<(String, String)>>,
    body: Option<String>,
}

#[derive(Serialize)]
struct HttpFetchRes {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
    final_url: String,
}

#[tauri::command]
async fn http_fetch(req: HttpFetchReq) -> Result<HttpFetchRes, String> {
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Client error: {e}"))?;

    let method = match req.method.as_deref().unwrap_or("GET").to_uppercase().as_str() {
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "DELETE" => reqwest::Method::DELETE,
        "HEAD" => reqwest::Method::HEAD,
        "OPTIONS" => reqwest::Method::OPTIONS,
        "PATCH" => reqwest::Method::PATCH,
        _ => reqwest::Method::GET,
    };

    let mut request = client.request(method, &req.url);
    if let Some(hs) = &req.headers {
        for (k, v) in hs {
            request = request.header(k, v);
        }
    }
    if let Some(b) = &req.body {
        if !b.is_empty() {
            request = request.body(b.clone());
        }
    }

    let resp = request
        .send()
        .await
        .map_err(|e| format!("Fetch failed: {e}"))?;
    let final_url = resp.url().to_string();
    let status = resp.status().as_u16();
    let headers: Vec<(String, String)> = resp
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    let body = if body.len() > 300_000 {
        format!("{}\n…[truncated, total {} bytes]", &body[..300_000], body.len())
    } else {
        body
    };

    Ok(HttpFetchRes {
        status,
        headers,
        body,
        final_url,
    })
}

#[derive(Deserialize)]
struct BrowserLaunchReq {
    headless: Option<bool>,
}

#[tauri::command]
async fn browser_launch(req: Option<BrowserLaunchReq>, state: tauri::State<'_, StdArc<BrowserState>>) -> Result<String, String> {
    let mut browser_guard = state.browser.lock().await;
    if browser_guard.is_some() {
        return Ok("already_running".to_string());
    }
    let headless = req.as_ref().and_then(|r| r.headless).unwrap_or(true);
    let mut config_builder = BrowserConfig::builder();
    if headless {
        config_builder = config_builder.with_head();
    }
    // Try to use system chrome if available
    let config = config_builder.build().map_err(|e| format!("Browser config error: {e}"))?;
    let (browser, mut handler) = Browser::launch(config).await.map_err(|e| format!("Browser launch failed: {e}"))?;
    tokio::task::spawn(async move {
        while let Some(_event) = handler.next().await {}
    });
    let page = browser.new_page("about:blank").await.map_err(|e| format!("New page failed: {e}"))?;
    let mut page_guard = state.page.lock().await;
    *page_guard = Some(Arc::new(page));
    *browser_guard = Some(browser);
    Ok("launched".to_string())
}

#[derive(Deserialize)]
struct BrowserNavReq {
    url: String,
}

#[tauri::command]
async fn browser_navigate(req: BrowserNavReq, state: tauri::State<'_, StdArc<BrowserState>>) -> Result<String, String> {
    let page_guard = state.page.lock().await;
    let page = page_guard.as_ref().ok_or("Browser not launched")?.clone();
    drop(page_guard);
    page.goto(&req.url).await.map_err(|e| format!("Navigate failed: {e}"))?;
    // Wait a bit for JS
    tokio::time::sleep(Duration::from_millis(1500)).await;
    Ok(page.url().await.map_err(|e| e.to_string())?.unwrap_or(req.url))
}

#[derive(Serialize)]
struct BrowserSnapshot {
    url: String,
    title: String,
    html: String,
    forms: Vec<serde_json::Value>,
    links: Vec<String>,
    inputs: Vec<serde_json::Value>,
}

#[tauri::command]
async fn browser_snapshot(state: tauri::State<'_, StdArc<BrowserState>>) -> Result<BrowserSnapshot, String> {
    let page_guard = state.page.lock().await;
    let page = page_guard.as_ref().ok_or("Browser not launched")?.clone();
    drop(page_guard);
    let url = page.url().await.map_err(|e| e.to_string())?.unwrap_or_default();
    let title = page.get_title().await.map_err(|e| e.to_string())?.unwrap_or_default();
    let html = page.content().await.map_err(|e| format!("Get content failed: {e}"))?;
    // Extract forms/inputs/links via JS
    let js = r#"(function(){
        const forms=[]; document.querySelectorAll('form').forEach((f,i)=>{
            const fields=[]; f.querySelectorAll('input,select,textarea').forEach(el=>{
                fields.push({name:el.name||el.id||'',type:el.type||el.tagName,tag:el.tagName,value:el.value||''});
            });
            forms.push({index:i,action:f.action||location.href,method:(f.method||'get').toLowerCase(),fields});
        });
        const links=[]; document.querySelectorAll('a[href]').forEach(a=>{if(a.href) links.push(a.href);});
        const inputs=[]; document.querySelectorAll('input,textarea,select').forEach(el=>{
            inputs.push({name:el.name||'',id:el.id||'',type:el.type||el.tagName,placeholder:el.placeholder||''});
        });
        return JSON.stringify({forms,links:links.slice(0,200),inputs:inputs.slice(0,100)});
    })()"#;
    let res = page.evaluate(js).await.map_err(|e| format!("Eval failed: {e}"))?;
    let val: serde_json::Value = res.into_value().unwrap_or(serde_json::json!({}));
    let forms = val.get("forms").cloned().unwrap_or(serde_json::json!([])).as_array().cloned().unwrap_or_default();
    let links_arr = val.get("links").cloned().unwrap_or(serde_json::json!([])).as_array().cloned().unwrap_or_default();
    let links: Vec<String> = links_arr.into_iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect();
    let inputs_arr = val.get("inputs").cloned().unwrap_or(serde_json::json!([])).as_array().cloned().unwrap_or_default();
    let inputs: Vec<serde_json::Value> = inputs_arr;
    // Truncate html
    let html_trunc = if html.len() > 150000 { format!("{}...[truncated {} bytes]", &html[..150000], html.len()) } else { html };
    Ok(BrowserSnapshot { url, title, html: html_trunc, forms, links, inputs })
}

#[derive(Deserialize)]
struct BrowserClickReq {
    selector: Option<String>,
    text: Option<String>,
}

#[tauri::command]
async fn browser_click(req: BrowserClickReq, state: tauri::State<'_, StdArc<BrowserState>>) -> Result<String, String> {
    let page_guard = state.page.lock().await;
    let page = page_guard.as_ref().ok_or("Browser not launched")?.clone();
    drop(page_guard);
    if let Some(sel) = req.selector {
        let el = page.find_element(&sel).await.map_err(|e| format!("Element not found: {e}"))?;
        el.click().await.map_err(|e| format!("Click failed: {e}"))?;
    } else if let Some(txt) = req.text {
        let js = format!(r#"(function(){{const els=Array.from(document.querySelectorAll('button,a,input[type=submit]'));const el=els.find(x=>x.textContent&&x.textContent.includes({:?})); if(!el) throw new Error('not found'); el.click(); return 'ok';}})()"#, txt);
        page.evaluate(js).await.map_err(|e| format!("Click by text failed: {e}"))?;
    } else {
        return Err("selector or text required".to_string());
    }
    tokio::time::sleep(Duration::from_millis(1000)).await;
    Ok("clicked".to_string())
}

#[derive(Deserialize)]
struct BrowserTypeReq {
    selector: String,
    value: String,
}

#[tauri::command]
async fn browser_type(req: BrowserTypeReq, state: tauri::State<'_, StdArc<BrowserState>>) -> Result<String, String> {
    let page_guard = state.page.lock().await;
    let page = page_guard.as_ref().ok_or("Browser not launched")?.clone();
    drop(page_guard);
    let el = page.find_element(&req.selector).await.map_err(|e| format!("Element not found: {e}"))?;
    el.type_str(&req.value).await.map_err(|e| format!("Type failed: {e}"))?;
    Ok("typed".to_string())
}

#[derive(Deserialize)]
struct BrowserEvalReq {
    script: String,
}

#[tauri::command]
async fn browser_eval(req: BrowserEvalReq, state: tauri::State<'_, StdArc<BrowserState>>) -> Result<serde_json::Value, String> {
    let page_guard = state.page.lock().await;
    let page = page_guard.as_ref().ok_or("Browser not launched")?.clone();
    drop(page_guard);
    let res = page.evaluate(req.script).await.map_err(|e| format!("Eval failed: {e}"))?;
    Ok(res.into_value().unwrap_or(serde_json::Value::Null))
}

#[tauri::command]
async fn browser_get_cookies(state: tauri::State<'_, StdArc<BrowserState>>) -> Result<serde_json::Value, String> {
    let page_guard = state.page.lock().await;
    let page = page_guard.as_ref().ok_or("Browser not launched")?.clone();
    drop(page_guard);
    let cookies = page.get_cookies().await.map_err(|e| format!("Get cookies failed: {e}"))?;
    Ok(serde_json::to_value(cookies).unwrap_or(serde_json::json!([])))
}

#[tauri::command]
async fn browser_screenshot(state: tauri::State<'_, StdArc<BrowserState>>) -> Result<String, String> {
    let page_guard = state.page.lock().await;
    let page = page_guard.as_ref().ok_or("Browser not launched")?.clone();
    drop(page_guard);
    // Try basic screenshot
    let data = page.screenshot(chromiumoxide::cdp::browser_protocol::page::CaptureScreenshotParams::default()).await.map_err(|e| format!("Screenshot failed: {e}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(data))
}

#[tauri::command]
async fn browser_close(state: tauri::State<'_, StdArc<BrowserState>>) -> Result<String, String> {
    let mut browser_guard = state.browser.lock().await;
    if let Some(mut b) = browser_guard.take() {
        let _ = b.close().await;
    }
    let mut page_guard = state.page.lock().await;
    *page_guard = None;
    Ok("closed".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .manage(SshState::default())
        .manage(StdArc::new(BrowserState {
            browser: Mutex::new(None),
            page: Mutex::new(None),
        }))
        .invoke_handler(tauri::generate_handler![
            ssh_connect,
            ssh_disconnect,
            ssh_exec,
            ssh_detect_tools,
            llm_chat,
            llm_stream::llm_chat_stream,
            http_fetch,
            browser_launch,
            browser_navigate,
            browser_snapshot,
            browser_click,
            browser_type,
            browser_eval,
            browser_get_cookies,
            browser_screenshot,
            browser_close
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
