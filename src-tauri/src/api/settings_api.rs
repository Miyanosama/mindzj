use crate::kernel::error::CommandError;
use crate::kernel::types::{
    AiProviderType, AppSettings, GlobalWindowState, HotkeyBinding, Theme, ViewMode, WorkspaceState,
};
use crate::kernel::AppState;
use base64::Engine;
use keyring::{Entry, Error as KeyringError};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{ipc::Channel, LogicalPosition, LogicalSize, Manager, State};

const MIN_RESTORED_WINDOW_WIDTH: u32 = 320;
const MIN_RESTORED_WINDOW_HEIGHT: u32 = 240;
const MAX_REASONABLE_WINDOW_COORD: i32 = 10000;
const AI_KEYRING_SERVICE: &str = "MindZJ AI";

fn sanitize_window_state(mut state: GlobalWindowState) -> GlobalWindowState {
    if matches!(state.width, Some(width) if width < MIN_RESTORED_WINDOW_WIDTH) {
        state.width = None;
    }
    if matches!(state.height, Some(height) if height < MIN_RESTORED_WINDOW_HEIGHT) {
        state.height = None;
    }
    if matches!(state.x, Some(x) if x.abs() > MAX_REASONABLE_WINDOW_COORD)
        || matches!(state.y, Some(y) if y.abs() > MAX_REASONABLE_WINDOW_COORD)
    {
        state.x = None;
        state.y = None;
    }
    state
}

fn parse_ai_provider_type(provider: &str) -> Option<AiProviderType> {
    match provider.trim() {
        "Ollama" | "ollama" => Some(AiProviderType::Ollama),
        "LMStudio" | "LM Studio" | "lmstudio" | "lm-studio" => Some(AiProviderType::LMStudio),
        "ApiKeyLLM" | "API Key LLM" | "api-key-llm" | "apikeyllm" => {
            Some(AiProviderType::ApiKeyLLM)
        }
        "Claude" | "claude" => Some(AiProviderType::Claude),
        "OpenAI" | "openai" => Some(AiProviderType::OpenAI),
        "Grok" | "grok" | "xAI" | "xai" => Some(AiProviderType::Grok),
        "Gemini" | "gemini" => Some(AiProviderType::Gemini),
        "DeepSeek" | "deepseek" => Some(AiProviderType::DeepSeek),
        "Custom" | "custom" => Some(AiProviderType::Custom),
        _ => None,
    }
}

fn ai_keyring_account(provider: &str) -> String {
    format!("provider:{}", provider.trim())
}

fn keyring_error(action: &str, error: KeyringError) -> CommandError {
    CommandError {
        code: "AI_KEYRING_ERROR".into(),
        message: format!(
            "Failed to {action} API key in the operating-system credential store: {error}"
        ),
    }
}

fn read_keyring_secret(provider: &str) -> Result<Option<String>, CommandError> {
    let entry = Entry::new(AI_KEYRING_SERVICE, &ai_keyring_account(provider))
        .map_err(|error| keyring_error("open", error))?;
    match entry.get_password() {
        Ok(value) if !value.trim().is_empty() => Ok(Some(value.trim().to_string())),
        Ok(_) | Err(KeyringError::NoEntry) => Ok(None),
        Err(error) => Err(keyring_error("read", error)),
    }
}

fn write_keyring_secret(provider: &str, value: Option<&str>) -> Result<(), CommandError> {
    let entry = Entry::new(AI_KEYRING_SERVICE, &ai_keyring_account(provider))
        .map_err(|error| keyring_error("open", error))?;
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => {
            entry
                .set_password(value)
                .map_err(|error| keyring_error("save", error))?;
            let stored = entry
                .get_password()
                .map_err(|error| keyring_error("verify", error))?;
            if stored != value {
                return Err(CommandError {
                    code: "AI_KEYRING_ERROR".into(),
                    message: "The operating-system credential store did not preserve the API key."
                        .into(),
                });
            }
            Ok(())
        }
        None => match entry.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(error) => Err(keyring_error("delete", error)),
        },
    }
}

fn provider_type_name(provider_type: &AiProviderType) -> &'static str {
    match provider_type {
        AiProviderType::Ollama => "Ollama",
        AiProviderType::LMStudio => "LMStudio",
        AiProviderType::ApiKeyLLM => "ApiKeyLLM",
        AiProviderType::Claude => "Claude",
        AiProviderType::OpenAI => "OpenAI",
        AiProviderType::Grok => "Grok",
        AiProviderType::Gemini => "Gemini",
        AiProviderType::DeepSeek => "DeepSeek",
        AiProviderType::Custom => "Custom",
    }
}

fn migrate_legacy_config_key(
    config: &mut crate::kernel::types::AiProviderConfig,
) -> Result<bool, CommandError> {
    let provider = config
        .id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| provider_type_name(&config.provider_type));
    let legacy_secret = config
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if let Some(secret) = legacy_secret {
        write_keyring_secret(provider, Some(&secret))?;
        config.api_key = None;
        config.has_api_key = true;
        return Ok(true);
    }

    config.api_key = None;
    let has_api_key = read_keyring_secret(provider)?.is_some();
    let changed = config.has_api_key != has_api_key;
    config.has_api_key = has_api_key;
    Ok(changed)
}

fn provider_matches_config(
    provider: &str,
    config_id: Option<&str>,
    provider_type: &AiProviderType,
) -> bool {
    let trimmed = provider.trim();
    if let Some(id) = config_id {
        return id == trimmed;
    }
    match parse_ai_provider_type(trimmed) {
        Some(parsed) => &parsed == provider_type,
        None => false,
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatCompletionRequest {
    url: String,
    headers: Option<HashMap<String, String>>,
    body: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiGetJsonRequest {
    url: String,
    headers: Option<HashMap<String, String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAudioTranscriptionRequest {
    url: String,
    headers: Option<HashMap<String, String>>,
    file_name: String,
    mime_type: String,
    base64_data: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiTextToSpeechRequest {
    url: String,
    headers: Option<HashMap<String, String>>,
    body: Value,
    output_dir: Option<String>,
    file_name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiTextToSpeechResult {
    path: String,
    file_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatCompletionStreamRequest {
    url: String,
    headers: Option<HashMap<String, String>>,
    body: Value,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiStreamEvent {
    data: String,
    done: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderConnectionTestRequest {
    provider: String,
    provider_type: AiProviderType,
    endpoint: Option<String>,
    model: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderConnectionTestResult {
    model: String,
    content: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiModelDiscoveryRequest {
    endpoint: String,
    api_key: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiDiscoveredModel {
    id: String,
    display_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiModelDiscoveryResult {
    models: Vec<AiDiscoveredModel>,
}

fn validate_ai_url(url: &str) -> Result<(), CommandError> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(CommandError {
            code: "INVALID_AI_ENDPOINT".into(),
            message: "AI endpoint must start with http:// or https://".into(),
        });
    }
    Ok(())
}

fn build_ai_headers(
    custom_headers: Option<HashMap<String, String>>,
    include_content_type: bool,
) -> Result<HeaderMap, CommandError> {
    let mut headers = HeaderMap::new();
    if include_content_type {
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    }
    if let Some(custom_headers) = custom_headers {
        for (name, value) in custom_headers {
            let header_name =
                HeaderName::from_bytes(name.as_bytes()).map_err(|e| CommandError {
                    code: "INVALID_AI_HEADER".into(),
                    message: e.to_string(),
                })?;
            let header_value = HeaderValue::from_str(&value).map_err(|e| CommandError {
                code: "INVALID_AI_HEADER".into(),
                message: e.to_string(),
            })?;
            headers.insert(header_name, header_value);
        }
    }
    Ok(headers)
}

fn ai_provider_status_error(status: reqwest::StatusCode, text: String) -> CommandError {
    CommandError {
        code: "AI_PROVIDER_ERROR".into(),
        message: format!(
            "{}{}",
            status.as_u16(),
            if text.is_empty() {
                String::new()
            } else {
                format!(": {}", text)
            }
        ),
    }
}

fn default_audio_output_dir(app: &tauri::AppHandle) -> Result<PathBuf, CommandError> {
    if let Some(dir) = dirs::audio_dir().or_else(dirs::download_dir) {
        return Ok(dir.join("MindZJ"));
    }
    let app_dir = app.path().app_data_dir().map_err(|e| CommandError {
        code: "APP_DIR_ERROR".into(),
        message: e.to_string(),
    })?;
    Ok(app_dir.join("audio"))
}

fn resolve_audio_output_dir(
    app: &tauri::AppHandle,
    output_dir: Option<String>,
) -> Result<PathBuf, CommandError> {
    if let Some(raw) = output_dir {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }
    default_audio_output_dir(app)
}

fn sanitize_audio_file_name(raw: Option<String>) -> String {
    let fallback = format!(
        "mindzj_grok_tts_{}.mp3",
        chrono::Local::now().format("%Y%m%d_%H%M%S")
    );
    let source = raw
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&fallback);
    let mut result: String = source
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    while result.starts_with('.') || result.starts_with('_') {
        result.remove(0);
    }
    if result.is_empty() {
        result = fallback;
    }
    if !result.to_ascii_lowercase().ends_with(".mp3") {
        result.push_str(".mp3");
    }
    result
}

// ---------------------------------------------------------------------------
// Window state persistence helpers (shared between setup hook and commands)
// ---------------------------------------------------------------------------

/// Read the persisted window state from disk. Returns `None` if the file
/// doesn't exist or cannot be parsed.
pub fn load_window_state_sync(app: &tauri::AppHandle) -> Option<GlobalWindowState> {
    let app_dir = app.path().app_data_dir().ok()?;
    let state_path = app_dir.join("window-state.json");
    if !state_path.exists() {
        return None;
    }
    let content = std::fs::read_to_string(&state_path).ok()?;
    serde_json::from_str::<GlobalWindowState>(&content)
        .ok()
        .map(sanitize_window_state)
}

/// Apply a window state to the given webview window. Called BEFORE the
/// window becomes visible to avoid a visible resize flash.
pub fn apply_window_state(window: &tauri::WebviewWindow, state: &GlobalWindowState) {
    let state = sanitize_window_state(state.clone());
    if let (Some(w), Some(h)) = (state.width, state.height) {
        if w > 0 && h > 0 {
            let _ = window.set_size(LogicalSize::new(w as f64, h as f64));
        }
    }
    if let (Some(x), Some(y)) = (state.x, state.y) {
        let _ = window.set_position(LogicalPosition::new(x as f64, y as f64));
    }
    if state.maximized == Some(true) {
        let _ = window.maximize();
    }
}

/// Get current application settings for the vault in the calling window.
#[tauri::command]
pub async fn get_settings(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<AppSettings, CommandError> {
    let ctx = state.get_vault_context(window.label())?;
    let (settings, migrated) = {
        let mut settings = ctx.settings.write().map_err(|_| CommandError {
            code: "LOCK_ERROR".into(),
            message: "Failed to acquire settings lock".into(),
        })?;
        let mut migrated = false;
        if let Some(config) = settings.ai_provider.as_mut() {
            migrated |= migrate_legacy_config_key(config)?;
        }
        for config in &mut settings.ai_custom_providers {
            migrated |= migrate_legacy_config_key(config)?;
        }
        (settings.clone(), migrated)
    };
    if migrated {
        ctx.save_settings().map_err(CommandError::from)?;
    }
    Ok(settings)
}

fn ai_models_url(endpoint: &str) -> String {
    let mut base = endpoint.trim().trim_end_matches('/').to_string();
    for suffix in ["/chat/completions", "/responses", "/messages"] {
        if base.to_ascii_lowercase().ends_with(suffix) {
            base.truncate(base.len() - suffix.len());
            break;
        }
    }
    if base.to_ascii_lowercase().ends_with("/models") {
        base
    } else {
        format!("{base}/models")
    }
}

/// Update application settings (full replace + persist).
#[tauri::command]
pub async fn update_settings(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    mut settings: AppSettings,
) -> Result<(), CommandError> {
    let ctx = state.get_vault_context(window.label())?;
    if let Some(config) = settings.ai_provider.as_mut() {
        config.api_key = None;
    }
    for config in &mut settings.ai_custom_providers {
        config.api_key = None;
    }
    {
        let mut s = ctx.settings.write().map_err(|_| CommandError {
            code: "LOCK_ERROR".into(),
            message: "Failed to acquire settings lock".into(),
        })?;
        *s = settings;
    }
    ctx.save_settings().map_err(CommandError::from)?;
    Ok(())
}

#[tauri::command]
pub async fn get_ai_api_key(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    provider: String,
) -> Result<Option<String>, CommandError> {
    let ctx = state.get_vault_context(window.label())?;
    if let Some(secret) = read_keyring_secret(&provider)? {
        let changed = {
            let mut settings = ctx.settings.write().map_err(|_| CommandError {
                code: "LOCK_ERROR".into(),
                message: "Failed to acquire settings lock".into(),
            })?;
            let mut changed = false;
            if let Some(config) = settings.ai_provider.as_mut() {
                if provider_matches_config(&provider, config.id.as_deref(), &config.provider_type) {
                    changed |= config.api_key.take().is_some() || !config.has_api_key;
                    config.has_api_key = true;
                }
            }
            for config in &mut settings.ai_custom_providers {
                if provider_matches_config(&provider, config.id.as_deref(), &config.provider_type) {
                    changed |= config.api_key.take().is_some() || !config.has_api_key;
                    config.has_api_key = true;
                }
            }
            changed
        };
        if changed {
            ctx.save_settings().map_err(CommandError::from)?;
        }
        return Ok(Some(secret));
    }

    let legacy_key = {
        let settings = ctx.settings.read().map_err(|_| CommandError {
            code: "LOCK_ERROR".into(),
            message: "Failed to acquire settings lock".into(),
        })?;
        settings
            .ai_provider
            .as_ref()
            .filter(|config| {
                provider_matches_config(&provider, config.id.as_deref(), &config.provider_type)
            })
            .and_then(|config| config.api_key.clone())
            .or_else(|| {
                settings
                    .ai_custom_providers
                    .iter()
                    .find(|config| {
                        provider_matches_config(
                            &provider,
                            config.id.as_deref(),
                            &config.provider_type,
                        )
                    })
                    .and_then(|config| config.api_key.clone())
            })
            .filter(|value| !value.trim().is_empty())
    };
    if let Some(key) = legacy_key {
        write_keyring_secret(&provider, Some(&key))?;
        {
            let mut settings = ctx.settings.write().map_err(|_| CommandError {
                code: "LOCK_ERROR".into(),
                message: "Failed to acquire settings lock".into(),
            })?;
            if let Some(config) = settings.ai_provider.as_mut() {
                if provider_matches_config(&provider, config.id.as_deref(), &config.provider_type) {
                    config.api_key = None;
                    config.has_api_key = true;
                }
            }
            for config in settings.ai_custom_providers.iter_mut() {
                if provider_matches_config(&provider, config.id.as_deref(), &config.provider_type) {
                    config.api_key = None;
                    config.has_api_key = true;
                }
            }
        }
        ctx.save_settings().map_err(CommandError::from)?;
        return Ok(Some(key.trim().to_string()));
    }

    Ok(None)
}

#[tauri::command]
pub async fn set_ai_api_key(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    provider: String,
    api_key: Option<String>,
) -> Result<(), CommandError> {
    let value = api_key.unwrap_or_default().trim().to_string();
    let stored = if value.is_empty() { None } else { Some(value) };
    write_keyring_secret(&provider, stored.as_deref())?;
    let has_api_key = stored.is_some();
    let ctx = state.get_vault_context(window.label())?;
    {
        let mut settings = ctx.settings.write().map_err(|_| CommandError {
            code: "LOCK_ERROR".into(),
            message: "Failed to acquire settings lock".into(),
        })?;
        if let Some(config) = settings.ai_provider.as_mut() {
            if provider_matches_config(&provider, config.id.as_deref(), &config.provider_type) {
                config.api_key = None;
                config.has_api_key = has_api_key;
            }
        }
        for config in settings.ai_custom_providers.iter_mut() {
            if provider_matches_config(&provider, config.id.as_deref(), &config.provider_type) {
                config.api_key = None;
                config.has_api_key = has_api_key;
            }
        }
    }
    ctx.save_settings().map_err(CommandError::from)?;
    Ok(())
}

#[tauri::command]
pub async fn discover_ai_provider_models(
    request: AiModelDiscoveryRequest,
) -> Result<AiModelDiscoveryResult, CommandError> {
    let endpoint = request.endpoint.trim();
    validate_ai_url(endpoint)?;
    let api_key = request.api_key.trim();
    if api_key.is_empty() {
        return Err(CommandError {
            code: "AI_API_KEY_REQUIRED".into(),
            message: "API key is required to retrieve models.".into(),
        });
    }

    let anthropic = endpoint.to_ascii_lowercase().contains("api.anthropic.com");
    let mut url = ai_models_url(endpoint);
    if anthropic && !url.contains('?') {
        url.push_str("?limit=1000");
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| CommandError {
            code: "AI_PROVIDER_ERROR".into(),
            message: error.to_string(),
        })?;
    let mut builder = client.get(url);
    if anthropic {
        builder = builder
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01");
    } else {
        builder = builder.bearer_auth(api_key);
    }
    let response = builder.send().await.map_err(|error| CommandError {
        code: "AI_PROVIDER_ERROR".into(),
        message: error.to_string(),
    })?;
    let status = response.status();
    let text = response.text().await.map_err(|error| CommandError {
        code: "AI_PROVIDER_ERROR".into(),
        message: error.to_string(),
    })?;
    if !status.is_success() {
        return Err(ai_provider_status_error(status, text));
    }
    let body: Value = serde_json::from_str(&text).map_err(|error| CommandError {
        code: "AI_PROVIDER_ERROR".into(),
        message: format!("Invalid provider response: {error}"),
    })?;
    let data = body
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| CommandError {
            code: "AI_PROVIDER_ERROR".into(),
            message: "The provider response did not contain a model list.".into(),
        })?;
    let mut models: Vec<AiDiscoveredModel> = data
        .iter()
        .filter_map(|item| {
            let id = item.get("id")?.as_str()?.trim();
            if id.is_empty() {
                return None;
            }
            let display_name = item
                .get("display_name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or(id);
            Some(AiDiscoveredModel {
                id: id.to_string(),
                display_name: display_name.to_string(),
            })
        })
        .collect();
    models.sort_by(|left, right| {
        left.display_name
            .to_ascii_lowercase()
            .cmp(&right.display_name.to_ascii_lowercase())
            .then_with(|| left.id.cmp(&right.id))
    });
    models.dedup_by(|left, right| left.id == right.id);
    if models.is_empty() {
        return Err(CommandError {
            code: "AI_PROVIDER_ERROR".into(),
            message: "The provider returned an empty model list.".into(),
        });
    }

    Ok(AiModelDiscoveryResult { models })
}

#[tauri::command]
pub async fn test_ai_provider_connection(
    request: AiProviderConnectionTestRequest,
) -> Result<AiProviderConnectionTestResult, CommandError> {
    let endpoint = request.endpoint.as_deref().unwrap_or_default().trim();
    validate_ai_url(endpoint)?;
    let model = request.model.trim();
    if model.is_empty() {
        return Err(CommandError {
            code: "INVALID_AI_MODEL".into(),
            message: "AI model is empty.".into(),
        });
    }
    let api_key = read_keyring_secret(&request.provider)?.ok_or_else(|| CommandError {
        code: "AI_API_KEY_REQUIRED".into(),
        message: "API key is required for this provider.".into(),
    })?;
    let base = endpoint.trim_end_matches('/');
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| CommandError {
            code: "AI_PROVIDER_ERROR".into(),
            message: error.to_string(),
        })?;

    let is_anthropic = matches!(request.provider_type, AiProviderType::Claude)
        || base.to_ascii_lowercase().contains("api.anthropic.com");
    let supported = matches!(
        request.provider_type,
        AiProviderType::Claude
            | AiProviderType::OpenAI
            | AiProviderType::DeepSeek
            | AiProviderType::ApiKeyLLM
            | AiProviderType::Custom
    );
    if !supported {
        return Err(CommandError {
            code: "UNSUPPORTED_AI_PROVIDER".into(),
            message: "Secure connection testing currently supports OpenAI, DeepSeek, Anthropic, and compatible custom providers.".into(),
        });
    }

    let (response, anthropic) = if is_anthropic {
        let url = if base.ends_with("/messages") {
            base.to_string()
        } else {
            format!("{base}/messages")
        };
        let response = client
            .post(url)
            .header("x-api-key", &api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&serde_json::json!({
                "model": model,
                "max_tokens": 8,
                "messages": [{ "role": "user", "content": "Reply with OK." }]
            }))
            .send()
            .await
            .map_err(|error| CommandError {
                code: "AI_PROVIDER_ERROR".into(),
                message: error.to_string(),
            })?;
        (response, true)
    } else {
        let url = if base.ends_with("/chat/completions") {
            base.to_string()
        } else {
            format!("{base}/chat/completions")
        };
        let response = client
            .post(url)
            .bearer_auth(&api_key)
            .json(&serde_json::json!({
                "model": model,
                "max_tokens": 8,
                "messages": [{ "role": "user", "content": "Reply with OK." }]
            }))
            .send()
            .await
            .map_err(|error| CommandError {
                code: "AI_PROVIDER_ERROR".into(),
                message: error.to_string(),
            })?;
        (response, false)
    };

    let status = response.status();
    let text = response.text().await.map_err(|error| CommandError {
        code: "AI_PROVIDER_ERROR".into(),
        message: error.to_string(),
    })?;
    if !status.is_success() {
        return Err(ai_provider_status_error(status, text));
    }
    let body: Value = serde_json::from_str(&text).map_err(|error| CommandError {
        code: "AI_PROVIDER_ERROR".into(),
        message: format!("Invalid provider response: {error}"),
    })?;
    let content = if anthropic {
        body.get("content")
            .and_then(Value::as_array)
            .and_then(|items| {
                items
                    .iter()
                    .find_map(|item| item.get("text").and_then(Value::as_str))
            })
    } else {
        body.pointer("/choices/0/message/content")
            .and_then(Value::as_str)
    }
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .map(str::to_string);

    Ok(AiProviderConnectionTestResult {
        model: model.to_string(),
        content,
    })
}

#[tauri::command]
pub async fn ai_chat_completion(request: AiChatCompletionRequest) -> Result<Value, CommandError> {
    let url = request.url.trim();
    validate_ai_url(url)?;
    let headers = build_ai_headers(request.headers, true)?;

    let response = reqwest::Client::new()
        .post(url)
        .headers(headers)
        .json(&request.body)
        .send()
        .await
        .map_err(|e| CommandError {
            code: "AI_PROVIDER_ERROR".into(),
            message: e.to_string(),
        })?;

    let status = response.status();
    let text = response.text().await.map_err(|e| CommandError {
        code: "AI_PROVIDER_ERROR".into(),
        message: e.to_string(),
    })?;

    if !status.is_success() {
        return Err(CommandError {
            code: "AI_PROVIDER_ERROR".into(),
            message: format!(
                "{}{}",
                status.as_u16(),
                if text.is_empty() {
                    String::new()
                } else {
                    format!(": {}", text)
                }
            ),
        });
    }

    serde_json::from_str(&text).map_err(|e| CommandError {
        code: "AI_PROVIDER_ERROR".into(),
        message: format!("Invalid AI response JSON: {}", e),
    })
}

/// Stream an OpenAI/Anthropic/Gemini-compatible SSE response through a Tauri
/// Channel. The frontend receives provider-native `data:` payloads and can
/// normalize deltas without buffering the whole paper response.
#[tauri::command]
pub async fn ai_chat_completion_stream(
    request: AiChatCompletionStreamRequest,
    on_event: Channel<AiStreamEvent>,
) -> Result<(), CommandError> {
    let url = request.url.trim();
    validate_ai_url(url)?;
    let headers = build_ai_headers(request.headers, true)?;
    let response = reqwest::Client::new()
        .post(url)
        .headers(headers)
        .json(&request.body)
        .send()
        .await
        .map_err(|e| CommandError {
            code: "AI_PROVIDER_ERROR".into(),
            message: e.to_string(),
        })?;
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(ai_provider_status_error(status, text));
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    use futures_util::StreamExt;
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| CommandError {
            code: "AI_PROVIDER_ERROR".into(),
            message: e.to_string(),
        })?;
        buffer.push_str(&String::from_utf8_lossy(&bytes));
        while let Some(index) = buffer.find('\n') {
            let line = buffer[..index].trim_end_matches('\r').to_string();
            buffer.drain(..=index);
            let trimmed = line.trim();
            if let Some(data) = trimmed.strip_prefix("data:") {
                let data = data.trim().to_string();
                if !data.is_empty() {
                    on_event
                        .send(AiStreamEvent {
                            data: data.clone(),
                            done: data == "[DONE]",
                        })
                        .map_err(|e| CommandError {
                            code: "AI_STREAM_ERROR".into(),
                            message: e.to_string(),
                        })?;
                }
            }
        }
    }
    let trailing = buffer.trim();
    if let Some(data) = trailing.strip_prefix("data:") {
        let data = data.trim().to_string();
        if !data.is_empty() {
            on_event
                .send(AiStreamEvent {
                    data: data.clone(),
                    done: data == "[DONE]",
                })
                .map_err(|e| CommandError {
                    code: "AI_STREAM_ERROR".into(),
                    message: e.to_string(),
                })?;
        }
    }
    on_event
        .send(AiStreamEvent {
            data: String::new(),
            done: true,
        })
        .map_err(|e| CommandError {
            code: "AI_STREAM_ERROR".into(),
            message: e.to_string(),
        })?;
    Ok(())
}

#[tauri::command]
pub async fn ai_get_json(request: AiGetJsonRequest) -> Result<Value, CommandError> {
    let url = request.url.trim();
    validate_ai_url(url)?;
    let headers = build_ai_headers(request.headers, false)?;

    let response = reqwest::Client::new()
        .get(url)
        .headers(headers)
        .send()
        .await
        .map_err(|e| CommandError {
            code: "AI_PROVIDER_ERROR".into(),
            message: e.to_string(),
        })?;

    let status = response.status();
    let text = response.text().await.map_err(|e| CommandError {
        code: "AI_PROVIDER_ERROR".into(),
        message: e.to_string(),
    })?;

    if !status.is_success() {
        return Err(CommandError {
            code: "AI_PROVIDER_ERROR".into(),
            message: format!(
                "{}{}",
                status.as_u16(),
                if text.is_empty() {
                    String::new()
                } else {
                    format!(": {}", text)
                }
            ),
        });
    }

    serde_json::from_str(&text).map_err(|e| CommandError {
        code: "AI_PROVIDER_ERROR".into(),
        message: format!("Invalid AI response JSON: {}", e),
    })
}

#[tauri::command]
pub async fn ai_transcribe_audio(
    request: AiAudioTranscriptionRequest,
) -> Result<Value, CommandError> {
    let url = request.url.trim();
    validate_ai_url(url)?;
    let headers = build_ai_headers(request.headers, false)?;
    let data = base64::engine::general_purpose::STANDARD
        .decode(&request.base64_data)
        .map_err(|e| CommandError {
            code: "DECODE_ERROR".into(),
            message: format!("Failed to decode audio data: {}", e),
        })?;
    let file_name = request.file_name.trim();
    let file_name = if file_name.is_empty() {
        "mindzj-recording.wav"
    } else {
        file_name
    };
    let mime_type = request.mime_type.trim();
    let mime_type = if mime_type.is_empty() {
        "audio/wav"
    } else {
        mime_type
    };
    let file_part = reqwest::multipart::Part::bytes(data)
        .file_name(file_name.to_string())
        .mime_str(mime_type)
        .map_err(|e| CommandError {
            code: "AI_PROVIDER_ERROR".into(),
            message: e.to_string(),
        })?;
    let form = reqwest::multipart::Form::new().part("file", file_part);

    let response = reqwest::Client::new()
        .post(url)
        .headers(headers)
        .multipart(form)
        .send()
        .await
        .map_err(|e| CommandError {
            code: "AI_PROVIDER_ERROR".into(),
            message: e.to_string(),
        })?;

    let status = response.status();
    let text = response.text().await.map_err(|e| CommandError {
        code: "AI_PROVIDER_ERROR".into(),
        message: e.to_string(),
    })?;

    if !status.is_success() {
        return Err(ai_provider_status_error(status, text));
    }

    serde_json::from_str(&text).map_err(|e| CommandError {
        code: "AI_PROVIDER_ERROR".into(),
        message: format!("Invalid STT response JSON: {}", e),
    })
}

#[tauri::command]
pub async fn ai_text_to_speech(
    app: tauri::AppHandle,
    request: AiTextToSpeechRequest,
) -> Result<AiTextToSpeechResult, CommandError> {
    let url = request.url.trim();
    validate_ai_url(url)?;
    let headers = build_ai_headers(request.headers, true)?;

    let response = reqwest::Client::new()
        .post(url)
        .headers(headers)
        .json(&request.body)
        .send()
        .await
        .map_err(|e| CommandError {
            code: "AI_PROVIDER_ERROR".into(),
            message: e.to_string(),
        })?;

    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(ai_provider_status_error(status, text));
    }

    let bytes = response.bytes().await.map_err(|e| CommandError {
        code: "AI_PROVIDER_ERROR".into(),
        message: e.to_string(),
    })?;
    if bytes.is_empty() {
        return Err(CommandError {
            code: "AI_PROVIDER_ERROR".into(),
            message: "TTS response contained no audio data".into(),
        });
    }

    let output_dir = resolve_audio_output_dir(&app, request.output_dir)?;
    std::fs::create_dir_all(&output_dir).map_err(|e| CommandError {
        code: "IO_ERROR".into(),
        message: format!("Failed to create audio export folder: {}", e),
    })?;
    let file_name = sanitize_audio_file_name(request.file_name);
    let output_path = output_dir.join(&file_name);
    std::fs::write(&output_path, bytes.as_ref()).map_err(|e| CommandError {
        code: "IO_ERROR".into(),
        message: format!("Failed to write audio file: {}", e),
    })?;

    Ok(AiTextToSpeechResult {
        path: output_path.to_string_lossy().to_string(),
        file_name,
    })
}

/// Update the active skin. Accepts either the legacy `Light`/`Dark`/
/// `System` enum payload or a free-form string (built-in skin ID like
/// `"github-dark"` or a `"custom:<name>"` reference to a user-imported
/// theme).
#[tauri::command]
pub async fn set_theme(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    theme: Theme,
) -> Result<(), CommandError> {
    let ctx = state.get_vault_context(window.label())?;
    {
        let mut s = ctx.settings.write().map_err(|_| CommandError {
            code: "LOCK_ERROR".into(),
            message: "Failed to acquire settings lock".into(),
        })?;
        s.theme = theme.as_id();
    }
    ctx.save_settings().map_err(CommandError::from)?;
    Ok(())
}

/// Update font size.
#[tauri::command]
pub async fn set_font_size(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    size: u32,
) -> Result<(), CommandError> {
    if size < 8 || size > 72 {
        return Err(CommandError {
            code: "INVALID_VALUE".into(),
            message: "Font size must be between 8 and 72".into(),
        });
    }
    let ctx = state.get_vault_context(window.label())?;
    {
        let mut s = ctx.settings.write().map_err(|_| CommandError {
            code: "LOCK_ERROR".into(),
            message: "Failed to acquire settings lock".into(),
        })?;
        s.font_size = size;
    }
    ctx.save_settings().map_err(CommandError::from)?;
    Ok(())
}

/// Update default view mode.
#[tauri::command]
pub async fn set_view_mode(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    mode: ViewMode,
) -> Result<(), CommandError> {
    let ctx = state.get_vault_context(window.label())?;
    {
        let mut s = ctx.settings.write().map_err(|_| CommandError {
            code: "LOCK_ERROR".into(),
            message: "Failed to acquire settings lock".into(),
        })?;
        s.default_view_mode = mode;
    }
    ctx.save_settings().map_err(CommandError::from)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Workspace commands
// ---------------------------------------------------------------------------

/// Load workspace state from .mindzj/workspace.json
#[tauri::command]
pub async fn load_workspace(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<WorkspaceState, CommandError> {
    let ctx = state.get_vault_context(window.label())?;
    ctx.load_workspace().map_err(CommandError::from)
}

/// Save workspace state to .mindzj/workspace.json
#[tauri::command]
pub async fn save_workspace(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    workspace: WorkspaceState,
) -> Result<(), CommandError> {
    let ctx = state.get_vault_context(window.label())?;
    ctx.save_workspace(&workspace).map_err(CommandError::from)
}

// ---------------------------------------------------------------------------
// Hotkey commands
// ---------------------------------------------------------------------------

/// Load custom hotkey bindings from .mindzj/hotkeys.json
#[tauri::command]
pub async fn get_hotkeys(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Vec<HotkeyBinding>, CommandError> {
    let ctx = state.get_vault_context(window.label())?;
    ctx.load_hotkeys().map_err(CommandError::from)
}

/// Save custom hotkey bindings to .mindzj/hotkeys.json
#[tauri::command]
pub async fn save_hotkeys(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    bindings: Vec<HotkeyBinding>,
) -> Result<(), CommandError> {
    let ctx = state.get_vault_context(window.label())?;
    ctx.save_hotkeys(&bindings).map_err(CommandError::from)
}

// ---------------------------------------------------------------------------
// Global window state commands (not per-vault)
// ---------------------------------------------------------------------------

/// Load global window state from app data directory.
/// This is shared across ALL vaults so the window always restores to the same
/// position/size regardless of which vault is opened.
#[tauri::command]
pub async fn get_window_state(app: tauri::AppHandle) -> Result<GlobalWindowState, CommandError> {
    let app_dir = app.path().app_data_dir().map_err(|e| CommandError {
        code: "PATH_ERROR".into(),
        message: e.to_string(),
    })?;
    let state_path = app_dir.join("window-state.json");
    if state_path.exists() {
        let content = std::fs::read_to_string(&state_path).map_err(|e| CommandError {
            code: "IO_ERROR".into(),
            message: e.to_string(),
        })?;
        serde_json::from_str(&content).map_err(|e| CommandError {
            code: "PARSE_ERROR".into(),
            message: e.to_string(),
        })
    } else {
        Ok(GlobalWindowState::default())
    }
}

/// Save global window state to app data directory.
/// Merges with existing state so partial updates (e.g. maximized-only) preserve
/// the previous position/size values.
#[tauri::command]
pub async fn save_window_state(
    app: tauri::AppHandle,
    window_state: GlobalWindowState,
) -> Result<(), CommandError> {
    let app_dir = app.path().app_data_dir().map_err(|e| CommandError {
        code: "PATH_ERROR".into(),
        message: e.to_string(),
    })?;
    std::fs::create_dir_all(&app_dir).map_err(|e| CommandError {
        code: "IO_ERROR".into(),
        message: e.to_string(),
    })?;
    let state_path = app_dir.join("window-state.json");
    // Read existing state to merge with incoming partial update
    let mut merged = if state_path.exists() {
        std::fs::read_to_string(&state_path)
            .ok()
            .and_then(|c| serde_json::from_str::<GlobalWindowState>(&c).ok())
            .unwrap_or_default()
    } else {
        GlobalWindowState::default()
    };
    // Merge: only overwrite fields that are Some in the incoming state
    if window_state.x.is_some() {
        merged.x = window_state.x;
    }
    if window_state.y.is_some() {
        merged.y = window_state.y;
    }
    if window_state.width.is_some() {
        merged.width = window_state.width;
    }
    if window_state.height.is_some() {
        merged.height = window_state.height;
    }
    if window_state.maximized.is_some() {
        merged.maximized = window_state.maximized;
    }
    let merged = sanitize_window_state(merged);
    let json = serde_json::to_string_pretty(&merged).map_err(|e| CommandError {
        code: "SERIALIZE_ERROR".into(),
        message: e.to_string(),
    })?;
    std::fs::write(&state_path, json).map_err(|e| CommandError {
        code: "IO_ERROR".into(),
        message: e.to_string(),
    })?;
    Ok(())
}
