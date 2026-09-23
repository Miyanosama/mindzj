use crate::kernel::error::{KernelError, KernelResult};
use crate::literature::database;
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub struct LiteratureRepository {
    vault_root: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperRecord {
    pub id: String,
    pub relative_path: String,
    pub content_hash: String,
    pub title: String,
    pub page_count: Option<i64>,
    pub parse_status: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfBoxInput {
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
    #[serde(default)]
    pub start_offset: Option<usize>,
    #[serde(default)]
    pub end_offset: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfParagraphInput {
    pub paragraph_index: i64,
    pub column_index: i64,
    pub text: String,
    pub boxes: Vec<PdfBoxInput>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfPageInput {
    pub page_number: i64,
    pub width: f64,
    pub height: f64,
    pub text: String,
    pub paragraphs: Vec<PdfParagraphInput>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfIndexSummary {
    pub paper_id: String,
    pub page_count: usize,
    pub paragraph_count: usize,
    pub parse_status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfSearchResult {
    pub paragraph_id: String,
    pub page_number: i64,
    pub paragraph_index: i64,
    pub snippet: String,
    pub text: String,
    pub boxes: Vec<PdfBoxInput>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfParagraphRecord {
    pub id: String,
    pub paper_id: String,
    pub page_number: i64,
    pub paragraph_index: i64,
    pub column_index: i64,
    pub text: String,
    pub source_hash: String,
    pub boxes: Vec<PdfBoxInput>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceRef {
    pub start_offset: usize,
    pub end_offset: usize,
    pub quote: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParagraphKeyPoint {
    pub label: String,
    pub evidence: Vec<EvidenceRef>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParagraphAnalysisInput {
    pub paragraph_id: String,
    pub translation: String,
    pub summary: String,
    pub key_points: Vec<ParagraphKeyPoint>,
    pub provider: String,
    pub model: String,
    pub prompt_version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParagraphAnalysisRecord {
    pub paragraph_id: String,
    pub paper_id: String,
    pub page_number: i64,
    pub paragraph_index: i64,
    pub source_hash: String,
    pub translation: String,
    pub summary: String,
    pub key_points: Vec<ParagraphKeyPoint>,
    pub provider: String,
    pub model: String,
    pub prompt_version: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperReference {
    pub paragraph_id: Option<String>,
    pub page_number: Option<i64>,
    pub label: String,
    pub text: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperChatMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub references: Vec<PaperReference>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperChatSession {
    pub paper_id: String,
    pub messages: Vec<PaperChatMessage>,
    pub context_injected: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessingJobRecord {
    pub id: String,
    pub paper_id: Option<String>,
    pub job_type: String,
    pub status: String,
    pub progress: f64,
    pub error_message: Option<String>,
}

impl LiteratureRepository {
    pub fn initialize(vault_root: &Path) -> KernelResult<Self> {
        let repository = Self {
            vault_root: vault_root.to_path_buf(),
        };
        let _ = repository.connection()?;
        Ok(repository)
    }

    fn connection(&self) -> KernelResult<Connection> {
        database::open(&self.vault_root)
    }

    pub fn register_pdf(&self, relative_path: &str) -> KernelResult<String> {
        Ok(self.ensure_pdf(relative_path)?.id)
    }

    pub fn ensure_pdf(&self, relative_path: &str) -> KernelResult<PaperRecord> {
        let absolute_path = self.vault_root.join(relative_path);
        let content_hash = hash_file(&absolute_path)?;
        let title = absolute_path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("Untitled")
            .to_string();
        let now = Utc::now().to_rfc3339();
        let connection = self.connection()?;
        let existing: Option<(String, String)> = connection
            .query_row(
                "SELECT id, content_hash FROM papers WHERE relative_path = ?1",
                [relative_path],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| KernelError::Database(error.to_string()))?;
        let paper_id = existing
            .as_ref()
            .map(|(id, _)| id.clone())
            .unwrap_or_else(|| Uuid::new_v4().to_string());

        if existing
            .as_ref()
            .is_some_and(|(_, previous_hash)| previous_hash != &content_hash)
        {
            connection
                .execute(
                    "DELETE FROM paragraphs_fts WHERE paper_id = ?1",
                    [&paper_id],
                )
                .map_err(|error| KernelError::Database(error.to_string()))?;
            connection
                .execute("DELETE FROM pages WHERE paper_id = ?1", [&paper_id])
                .map_err(|error| KernelError::Database(error.to_string()))?;
            connection
                .execute(
                    "DELETE FROM paper_chat_sessions WHERE paper_id = ?1",
                    [&paper_id],
                )
                .map_err(|error| KernelError::Database(error.to_string()))?;
        }

        connection
            .execute(
                "INSERT INTO papers (
                    id, relative_path, content_hash, title, parse_status,
                    created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?5)
                 ON CONFLICT(relative_path) DO UPDATE SET
                    content_hash = excluded.content_hash,
                    title = excluded.title,
                    parse_status = CASE
                        WHEN papers.content_hash = excluded.content_hash
                        THEN papers.parse_status
                        ELSE 'pending'
                    END,
                    updated_at = excluded.updated_at",
                params![paper_id, relative_path, content_hash, title, now],
            )
            .map_err(|error| KernelError::Database(error.to_string()))?;
        self.get_paper(relative_path)?.ok_or_else(|| {
            KernelError::Database("PDF registration completed without a paper record".into())
        })
    }

    pub fn get_paper(&self, relative_path: &str) -> KernelResult<Option<PaperRecord>> {
        let connection = self.connection()?;
        connection
            .query_row(
                "SELECT id, relative_path, content_hash, title, page_count, parse_status
                 FROM papers WHERE relative_path = ?1",
                [relative_path],
                |row| {
                    Ok(PaperRecord {
                        id: row.get(0)?,
                        relative_path: row.get(1)?,
                        content_hash: row.get(2)?,
                        title: row.get(3)?,
                        page_count: row.get(4)?,
                        parse_status: row.get(5)?,
                    })
                },
            )
            .optional()
            .map_err(|error| KernelError::Database(error.to_string()))
    }

    pub fn move_path(&self, from: &str, to: &str) -> KernelResult<usize> {
        let from = from.replace('\\', "/").trim_end_matches('/').to_string();
        let to = to.replace('\\', "/").trim_end_matches('/').to_string();
        if from.is_empty() || to.is_empty() {
            return Ok(0);
        }
        let connection = self.connection()?;
        let now = Utc::now().to_rfc3339();
        connection
            .execute(
                "UPDATE papers
                 SET relative_path = CASE
                       WHEN relative_path = ?1 THEN ?2
                       ELSE ?2 || substr(relative_path, length(?1) + 1)
                     END,
                     updated_at = ?3
                 WHERE relative_path = ?1
                    OR substr(relative_path, 1, length(?1) + 1) = ?1 || '/'",
                params![from, to, now],
            )
            .map_err(|error| KernelError::Database(error.to_string()))
    }

    pub fn replace_pdf_content(
        &self,
        relative_path: &str,
        pages: &[PdfPageInput],
    ) -> KernelResult<PdfIndexSummary> {
        let paper = self.ensure_pdf(relative_path)?;
        let mut connection = self.connection()?;
        let transaction = connection
            .transaction()
            .map_err(|error| KernelError::Database(error.to_string()))?;
        let now = Utc::now().to_rfc3339();

        transaction
            .execute(
                "DELETE FROM paragraphs_fts WHERE paper_id = ?1",
                [&paper.id],
            )
            .map_err(|error| KernelError::Database(error.to_string()))?;
        transaction
            .execute("DELETE FROM pages WHERE paper_id = ?1", [&paper.id])
            .map_err(|error| KernelError::Database(error.to_string()))?;

        let mut paragraph_count = 0usize;
        for page in pages {
            let page_id = stable_id(&format!("{}:page:{}", paper.id, page.page_number));
            transaction
                .execute(
                    "INSERT INTO pages (
                        id, paper_id, page_number, width, height, text_content, created_at, updated_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                    params![
                        page_id,
                        paper.id,
                        page.page_number,
                        page.width,
                        page.height,
                        page.text,
                        now
                    ],
                )
                .map_err(|error| KernelError::Database(error.to_string()))?;

            for paragraph in &page.paragraphs {
                let source_hash = hash_text(&paragraph.text);
                let paragraph_id = stable_id(&format!(
                    "{}:{}:{}:{}",
                    paper.content_hash, page.page_number, paragraph.paragraph_index, source_hash
                ));
                let bbox_json = serde_json::to_string(&paragraph.boxes)?;
                transaction
                    .execute(
                        "INSERT INTO paragraphs (
                            id, paper_id, page_id, page_number, paragraph_index, column_index,
                            text_content, source_hash, bbox_json, created_at, updated_at
                         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
                        params![
                            paragraph_id,
                            paper.id,
                            page_id,
                            page.page_number,
                            paragraph.paragraph_index,
                            paragraph.column_index,
                            paragraph.text,
                            source_hash,
                            bbox_json,
                            now
                        ],
                    )
                    .map_err(|error| KernelError::Database(error.to_string()))?;
                transaction
                    .execute(
                        "INSERT INTO paragraphs_fts (
                            paragraph_id, paper_id, page_number, text_content
                         ) VALUES (?1, ?2, ?3, ?4)",
                        params![paragraph_id, paper.id, page.page_number, paragraph.text],
                    )
                    .map_err(|error| KernelError::Database(error.to_string()))?;
                for (box_index, box_value) in paragraph.boxes.iter().enumerate() {
                    transaction
                        .execute(
                            "INSERT INTO paragraph_boxes (
                                paragraph_id, page_id, box_index, x0, y0, x1, y1,
                                start_offset, end_offset
                             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                            params![
                                paragraph_id,
                                page_id,
                                box_index as i64,
                                box_value.x0,
                                box_value.y0,
                                box_value.x1,
                                box_value.y1,
                                box_value.start_offset.map(|value| value as i64),
                                box_value.end_offset.map(|value| value as i64)
                            ],
                        )
                        .map_err(|error| KernelError::Database(error.to_string()))?;
                }
                paragraph_count += 1;
            }
        }

        let parse_status = if pages.iter().any(|page| !page.paragraphs.is_empty()) {
            "ready"
        } else {
            "requires_ocr"
        };
        transaction
            .execute(
                "UPDATE papers SET page_count = ?1, parse_status = ?2, updated_at = ?3
                 WHERE id = ?4",
                params![pages.len() as i64, parse_status, now, paper.id],
            )
            .map_err(|error| KernelError::Database(error.to_string()))?;
        transaction
            .commit()
            .map_err(|error| KernelError::Database(error.to_string()))?;

        Ok(PdfIndexSummary {
            paper_id: paper.id,
            page_count: pages.len(),
            paragraph_count,
            parse_status: parse_status.into(),
        })
    }

    pub fn get_paragraphs(&self, relative_path: &str) -> KernelResult<Vec<PdfParagraphRecord>> {
        let Some(paper) = self.get_paper(relative_path)? else {
            return Ok(Vec::new());
        };
        let connection = self.connection()?;
        let mut statement = connection
            .prepare(
                "SELECT id, paper_id, page_number, paragraph_index, column_index,
                        text_content, source_hash, bbox_json
                 FROM paragraphs
                 WHERE paper_id = ?1
                 ORDER BY page_number, paragraph_index",
            )
            .map_err(|error| KernelError::Database(error.to_string()))?;
        let rows = statement
            .query_map([paper.id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                ))
            })
            .map_err(|error| KernelError::Database(error.to_string()))?;
        let mut paragraphs = Vec::new();
        for row in rows {
            let (
                id,
                paper_id,
                page_number,
                paragraph_index,
                column_index,
                text,
                source_hash,
                boxes_json,
            ) = row.map_err(|error| KernelError::Database(error.to_string()))?;
            paragraphs.push(PdfParagraphRecord {
                id,
                paper_id,
                page_number,
                paragraph_index,
                column_index,
                text,
                source_hash,
                boxes: serde_json::from_str(&boxes_json)?,
            });
        }
        Ok(paragraphs)
    }

    pub fn get_paragraph_analyses(
        &self,
        relative_path: &str,
    ) -> KernelResult<Vec<ParagraphAnalysisRecord>> {
        let Some(paper) = self.get_paper(relative_path)? else {
            return Ok(Vec::new());
        };
        let connection = self.connection()?;
        let mut statement = connection
            .prepare(
                "SELECT a.paragraph_id, a.paper_id, p.page_number, p.paragraph_index,
                        a.source_hash, a.translation, a.summary, a.key_points_json,
                        a.provider, a.model, a.prompt_version, a.updated_at
                 FROM paragraph_analyses a
                 JOIN paragraphs p ON p.id = a.paragraph_id
                 WHERE a.paper_id = ?1 AND a.source_hash = p.source_hash
                 ORDER BY p.page_number, p.paragraph_index",
            )
            .map_err(|error| KernelError::Database(error.to_string()))?;
        let rows = statement
            .query_map([paper.id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, String>(10)?,
                    row.get::<_, String>(11)?,
                ))
            })
            .map_err(|error| KernelError::Database(error.to_string()))?;
        let mut analyses = Vec::new();
        for row in rows {
            let (
                paragraph_id,
                paper_id,
                page_number,
                paragraph_index,
                source_hash,
                translation,
                summary,
                key_points_json,
                provider,
                model,
                prompt_version,
                updated_at,
            ) = row.map_err(|error| KernelError::Database(error.to_string()))?;
            analyses.push(ParagraphAnalysisRecord {
                paragraph_id,
                paper_id,
                page_number,
                paragraph_index,
                source_hash,
                translation,
                summary,
                key_points: serde_json::from_str(&key_points_json)?,
                provider,
                model,
                prompt_version,
                updated_at,
            });
        }
        Ok(analyses)
    }

    pub fn save_paragraph_analysis(
        &self,
        relative_path: &str,
        input: &ParagraphAnalysisInput,
    ) -> KernelResult<ParagraphAnalysisRecord> {
        let paper = self.ensure_pdf(relative_path)?;
        let connection = self.connection()?;
        let paragraph: Option<(String, i64, i64, String)> = connection
            .query_row(
                "SELECT source_hash, page_number, paragraph_index, text_content
                 FROM paragraphs WHERE id = ?1 AND paper_id = ?2",
                params![input.paragraph_id, paper.id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .map_err(|error| KernelError::Database(error.to_string()))?;
        let Some((source_hash, page_number, paragraph_index, source_text)) = paragraph else {
            return Err(KernelError::Database("Paragraph no longer exists".into()));
        };
        validate_key_points(&source_text, &input.key_points)?;
        let key_points_json = serde_json::to_string(&input.key_points)?;
        let now = Utc::now().to_rfc3339();
        connection
            .execute(
                "INSERT INTO paragraph_analyses (
                    paragraph_id, paper_id, source_hash, translation, summary,
                    key_points_json, provider, model, prompt_version, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
                 ON CONFLICT(paragraph_id) DO UPDATE SET
                    source_hash = excluded.source_hash,
                    translation = excluded.translation,
                    summary = excluded.summary,
                    key_points_json = excluded.key_points_json,
                    provider = excluded.provider,
                    model = excluded.model,
                    prompt_version = excluded.prompt_version,
                    updated_at = excluded.updated_at",
                params![
                    input.paragraph_id,
                    paper.id,
                    source_hash,
                    input.translation,
                    input.summary,
                    key_points_json,
                    input.provider,
                    input.model,
                    input.prompt_version,
                    now
                ],
            )
            .map_err(|error| KernelError::Database(error.to_string()))?;
        Ok(ParagraphAnalysisRecord {
            paragraph_id: input.paragraph_id.clone(),
            paper_id: paper.id,
            page_number,
            paragraph_index,
            source_hash,
            translation: input.translation.clone(),
            summary: input.summary.clone(),
            key_points: input.key_points.clone(),
            provider: input.provider.clone(),
            model: input.model.clone(),
            prompt_version: input.prompt_version.clone(),
            updated_at: now,
        })
    }

    pub fn get_chat_session(&self, relative_path: &str) -> KernelResult<PaperChatSession> {
        let paper = self.ensure_pdf(relative_path)?;
        let connection = self.connection()?;
        let stored: Option<(String, bool)> = connection
            .query_row(
                "SELECT messages_json, context_injected FROM paper_chat_sessions WHERE paper_id = ?1",
                [&paper.id],
                |row| Ok((row.get(0)?, row.get::<_, i64>(1)? != 0)),
            )
            .optional()
            .map_err(|error| KernelError::Database(error.to_string()))?;
        let (messages, context_injected) = match stored {
            Some((json, injected)) => (serde_json::from_str(&json)?, injected),
            None => (Vec::new(), false),
        };
        Ok(PaperChatSession {
            paper_id: paper.id,
            messages,
            context_injected,
        })
    }

    pub fn save_chat_session(
        &self,
        relative_path: &str,
        messages: &[PaperChatMessage],
        context_injected: bool,
    ) -> KernelResult<PaperChatSession> {
        if messages
            .iter()
            .any(|message| !matches!(message.role.as_str(), "user" | "assistant"))
        {
            return Err(KernelError::Database(
                "Paper chat messages must use user or assistant roles".into(),
            ));
        }
        let paper = self.ensure_pdf(relative_path)?;
        let connection = self.connection()?;
        let json = serde_json::to_string(messages)?;
        let now = Utc::now().to_rfc3339();
        connection
            .execute(
                "INSERT INTO paper_chat_sessions (
                    paper_id, messages_json, context_injected, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?4)
                 ON CONFLICT(paper_id) DO UPDATE SET
                    messages_json = excluded.messages_json,
                    context_injected = excluded.context_injected,
                    updated_at = excluded.updated_at",
                params![paper.id, json, context_injected as i64, now],
            )
            .map_err(|error| KernelError::Database(error.to_string()))?;
        Ok(PaperChatSession {
            paper_id: paper.id,
            messages: messages.to_vec(),
            context_injected,
        })
    }

    pub fn upsert_processing_job(&self, job: &ProcessingJobRecord) -> KernelResult<()> {
        let connection = self.connection()?;
        let now = Utc::now().to_rfc3339();
        connection
            .execute(
                "INSERT INTO processing_jobs (
                    id, paper_id, job_type, status, progress, error_message, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
                 ON CONFLICT(id) DO UPDATE SET
                    paper_id = excluded.paper_id,
                    status = excluded.status,
                    progress = excluded.progress,
                    error_message = excluded.error_message,
                    updated_at = excluded.updated_at",
                params![
                    job.id,
                    job.paper_id,
                    job.job_type,
                    job.status,
                    job.progress,
                    job.error_message,
                    now
                ],
            )
            .map_err(|error| KernelError::Database(error.to_string()))?;
        Ok(())
    }

    pub fn search_pdf(
        &self,
        relative_path: &str,
        query: &str,
        limit: usize,
    ) -> KernelResult<Vec<PdfSearchResult>> {
        let Some(paper) = self.get_paper(relative_path)? else {
            return Ok(Vec::new());
        };
        let query = query.trim();
        if query.is_empty() {
            return Ok(Vec::new());
        }
        let connection = self.connection()?;
        let fts_query = format!("\"{}\"", query.replace('"', "\"\""));
        let safe_limit = limit.clamp(1, 100) as i64;
        let mut results = search_rows(
            &connection,
            "SELECT p.id, p.page_number, p.paragraph_index,
                    snippet(paragraphs_fts, 3, '[', ']', ' … ', 18),
                    p.text_content, p.bbox_json
             FROM paragraphs_fts
             JOIN paragraphs p ON p.id = paragraphs_fts.paragraph_id
             WHERE paragraphs_fts MATCH ?1 AND paragraphs_fts.paper_id = ?2
             ORDER BY p.page_number, p.paragraph_index, bm25(paragraphs_fts)
             LIMIT ?3",
            params![fts_query, paper.id, safe_limit],
        )?;
        if results.is_empty() {
            let like_query = format!("%{}%", query);
            results = search_rows(
                &connection,
                "SELECT id, page_number, paragraph_index, text_content,
                        text_content, bbox_json
                 FROM paragraphs
                 WHERE paper_id = ?1 AND text_content LIKE ?2
                 ORDER BY page_number, paragraph_index
                 LIMIT ?3",
                params![paper.id, like_query, safe_limit],
            )?;
        }
        Ok(results)
    }
}

fn validate_key_points(source: &str, key_points: &[ParagraphKeyPoint]) -> KernelResult<()> {
    let source_chars: Vec<char> = source.chars().collect();
    for point in key_points {
        if point.label.trim().is_empty() || point.evidence.is_empty() {
            return Err(KernelError::Database(
                "Every key point requires a label and evidence".into(),
            ));
        }
        for evidence in &point.evidence {
            if evidence.start_offset >= evidence.end_offset
                || evidence.end_offset > source_chars.len()
            {
                return Err(KernelError::Database(
                    "Evidence range is outside its paragraph".into(),
                ));
            }
            let actual: String = source_chars[evidence.start_offset..evidence.end_offset]
                .iter()
                .collect();
            if actual != evidence.quote {
                return Err(KernelError::Database(
                    "Evidence quote does not match its source range".into(),
                ));
            }
        }
    }
    Ok(())
}

fn search_rows<P: rusqlite::Params>(
    connection: &Connection,
    sql: &str,
    params: P,
) -> KernelResult<Vec<PdfSearchResult>> {
    let mut statement = connection
        .prepare(sql)
        .map_err(|error| KernelError::Database(error.to_string()))?;
    let rows = statement
        .query_map(params, |row| {
            let boxes_json: String = row.get(5)?;
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                boxes_json,
            ))
        })
        .map_err(|error| KernelError::Database(error.to_string()))?;
    let mut results = Vec::new();
    for row in rows {
        let (paragraph_id, page_number, paragraph_index, snippet, text, boxes_json) =
            row.map_err(|error| KernelError::Database(error.to_string()))?;
        results.push(PdfSearchResult {
            paragraph_id,
            page_number,
            paragraph_index,
            snippet,
            text,
            boxes: serde_json::from_str(&boxes_json)?,
        });
    }
    Ok(results)
}

fn stable_id(value: &str) -> String {
    hash_text(value)
}

fn hash_text(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    hex::encode(hasher.finalize())
}

fn hash_file(path: &Path) -> KernelResult<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(hex::encode(hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn indexes_and_searches_pdf_paragraphs() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp.path().join(".mindzj")).unwrap();
        std::fs::write(temp.path().join("paper.pdf"), b"fake pdf bytes").unwrap();
        let repository = LiteratureRepository::initialize(temp.path()).unwrap();
        let page = PdfPageInput {
            page_number: 1,
            width: 600.0,
            height: 800.0,
            text: "Neural interfaces improve communication.".into(),
            paragraphs: vec![PdfParagraphInput {
                paragraph_index: 0,
                column_index: 0,
                text: "Neural interfaces improve communication.".into(),
                boxes: vec![PdfBoxInput {
                    x0: 0.1,
                    y0: 0.2,
                    x1: 0.5,
                    y1: 0.24,
                    start_offset: Some(0),
                    end_offset: Some(40),
                }],
            }],
        };

        let summary = repository
            .replace_pdf_content("paper.pdf", &[page])
            .unwrap();
        assert_eq!(summary.paragraph_count, 1);
        assert_eq!(summary.parse_status, "ready");

        let results = repository
            .search_pdf("paper.pdf", "Neural interfaces", 20)
            .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].page_number, 1);
        assert_eq!(results[0].boxes.len(), 1);

        assert_eq!(
            repository
                .move_path("paper.pdf", "papers/paper.pdf")
                .unwrap(),
            1
        );
        let moved = repository.get_paper("papers/paper.pdf").unwrap().unwrap();
        assert_eq!(moved.id, summary.paper_id);
        assert_eq!(
            repository
                .search_pdf("papers/paper.pdf", "communication", 20)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn persists_validated_analysis_and_paper_chat() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp.path().join(".mindzj")).unwrap();
        std::fs::write(temp.path().join("paper.pdf"), b"fake pdf bytes").unwrap();
        let repository = LiteratureRepository::initialize(temp.path()).unwrap();
        let page = PdfPageInput {
            page_number: 1,
            width: 600.0,
            height: 800.0,
            text: "Neural interfaces improve communication.".into(),
            paragraphs: vec![PdfParagraphInput {
                paragraph_index: 0,
                column_index: 0,
                text: "Neural interfaces improve communication.".into(),
                boxes: vec![PdfBoxInput {
                    x0: 0.1,
                    y0: 0.2,
                    x1: 0.5,
                    y1: 0.24,
                    start_offset: Some(0),
                    end_offset: Some(40),
                }],
            }],
        };
        repository
            .replace_pdf_content("paper.pdf", &[page])
            .unwrap();
        let paragraph = repository.get_paragraphs("paper.pdf").unwrap().remove(0);
        let saved = repository
            .save_paragraph_analysis(
                "paper.pdf",
                &ParagraphAnalysisInput {
                    paragraph_id: paragraph.id.clone(),
                    translation: "神经接口改善交流。".into(),
                    summary: "神经接口有助于交流。".into(),
                    key_points: vec![ParagraphKeyPoint {
                        label: "神经接口".into(),
                        evidence: vec![EvidenceRef {
                            start_offset: 0,
                            end_offset: 17,
                            quote: "Neural interfaces".into(),
                        }],
                    }],
                    provider: "test".into(),
                    model: "test-model".into(),
                    prompt_version: "v1".into(),
                },
            )
            .unwrap();
        assert_eq!(saved.paragraph_id, paragraph.id);
        assert_eq!(
            repository
                .get_paragraph_analyses("paper.pdf")
                .unwrap()
                .len(),
            1
        );

        let messages = vec![PaperChatMessage {
            id: "message-1".into(),
            role: "user".into(),
            content: "What is the finding?".into(),
            references: vec![PaperReference {
                paragraph_id: Some(paragraph.id),
                page_number: Some(1),
                label: "finding".into(),
                text: "Neural interfaces".into(),
            }],
            created_at: "2026-09-23T00:00:00Z".into(),
        }];
        repository
            .save_chat_session("paper.pdf", &messages, true)
            .unwrap();
        let session = repository.get_chat_session("paper.pdf").unwrap();
        assert!(session.context_injected);
        assert_eq!(session.messages.len(), 1);
        assert_eq!(session.messages[0].references[0].page_number, Some(1));
    }

    #[test]
    fn moving_a_folder_updates_nested_paper_paths() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp.path().join(".mindzj")).unwrap();
        std::fs::create_dir_all(temp.path().join("biology")).unwrap();
        std::fs::write(temp.path().join("biology/paper.pdf"), b"fake pdf bytes").unwrap();
        let repository = LiteratureRepository::initialize(temp.path()).unwrap();
        let paper_id = repository.register_pdf("biology/paper.pdf").unwrap();

        assert_eq!(repository.move_path("biology", "biochemistry").unwrap(), 1);
        assert_eq!(
            repository
                .get_paper("biochemistry/paper.pdf")
                .unwrap()
                .unwrap()
                .id,
            paper_id
        );
    }

    #[test]
    fn search_results_follow_document_order() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp.path().join(".mindzj")).unwrap();
        std::fs::write(temp.path().join("paper.pdf"), b"fake pdf bytes").unwrap();
        let repository = LiteratureRepository::initialize(temp.path()).unwrap();
        let pages = [26, 8, 9, 1].map(|page_number| PdfPageInput {
            page_number,
            width: 600.0,
            height: 800.0,
            text: format!("Brain result on page {page_number}."),
            paragraphs: vec![PdfParagraphInput {
                paragraph_index: 0,
                column_index: 0,
                text: format!("Brain result on page {page_number}."),
                boxes: vec![PdfBoxInput {
                    x0: 0.1,
                    y0: 0.2,
                    x1: 0.5,
                    y1: 0.24,
                    start_offset: Some(0),
                    end_offset: Some(31),
                }],
            }],
        });

        repository.replace_pdf_content("paper.pdf", &pages).unwrap();
        let results = repository.search_pdf("paper.pdf", "Brain", 20).unwrap();
        let page_numbers: Vec<i64> = results.iter().map(|result| result.page_number).collect();

        assert_eq!(page_numbers, vec![1, 8, 9, 26]);
    }
}
