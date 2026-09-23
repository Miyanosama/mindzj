use crate::kernel::error::CommandError;
use crate::kernel::AppState;
use crate::literature::repository::{
    PaperChatMessage, PaperChatSession, PaperRecord, ParagraphAnalysisInput,
    ParagraphAnalysisRecord, PdfIndexSummary, PdfPageInput, PdfParagraphRecord, PdfSearchResult,
    ProcessingJobRecord,
};
use crate::literature::LiteratureRepository;
use tauri::State;

#[tauri::command]
pub async fn get_pdf_record(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    relative_path: String,
) -> Result<PaperRecord, CommandError> {
    let context = state.get_vault_context(window.label())?;
    let repository = LiteratureRepository::initialize(context.vault.root())?;
    repository
        .ensure_pdf(&relative_path)
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn index_pdf_document(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    relative_path: String,
    pages: Vec<PdfPageInput>,
) -> Result<PdfIndexSummary, CommandError> {
    let context = state.get_vault_context(window.label())?;
    let repository = LiteratureRepository::initialize(context.vault.root())?;
    repository
        .replace_pdf_content(&relative_path, &pages)
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn search_pdf_document(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    relative_path: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<PdfSearchResult>, CommandError> {
    let context = state.get_vault_context(window.label())?;
    let repository = LiteratureRepository::initialize(context.vault.root())?;
    repository
        .search_pdf(&relative_path, &query, limit.unwrap_or(50))
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn get_pdf_paragraphs(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    relative_path: String,
) -> Result<Vec<PdfParagraphRecord>, CommandError> {
    let context = state.get_vault_context(window.label())?;
    LiteratureRepository::initialize(context.vault.root())?
        .get_paragraphs(&relative_path)
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn get_paragraph_analyses(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    relative_path: String,
) -> Result<Vec<ParagraphAnalysisRecord>, CommandError> {
    let context = state.get_vault_context(window.label())?;
    LiteratureRepository::initialize(context.vault.root())?
        .get_paragraph_analyses(&relative_path)
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn save_paragraph_analysis(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    relative_path: String,
    analysis: ParagraphAnalysisInput,
) -> Result<ParagraphAnalysisRecord, CommandError> {
    let context = state.get_vault_context(window.label())?;
    LiteratureRepository::initialize(context.vault.root())?
        .save_paragraph_analysis(&relative_path, &analysis)
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn get_paper_chat_session(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    relative_path: String,
) -> Result<PaperChatSession, CommandError> {
    let context = state.get_vault_context(window.label())?;
    LiteratureRepository::initialize(context.vault.root())?
        .get_chat_session(&relative_path)
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn save_paper_chat_session(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    relative_path: String,
    messages: Vec<PaperChatMessage>,
    context_injected: bool,
) -> Result<PaperChatSession, CommandError> {
    let context = state.get_vault_context(window.label())?;
    LiteratureRepository::initialize(context.vault.root())?
        .save_chat_session(&relative_path, &messages, context_injected)
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn save_processing_job(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    job: ProcessingJobRecord,
) -> Result<(), CommandError> {
    let context = state.get_vault_context(window.label())?;
    LiteratureRepository::initialize(context.vault.root())?
        .upsert_processing_job(&job)
        .map_err(CommandError::from)
}
