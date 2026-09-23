use crate::kernel::error::{KernelError, KernelResult};
use rusqlite::Connection;
use std::path::Path;

const SCHEMA_VERSION: i64 = 3;

pub fn open(vault_root: &Path) -> KernelResult<Connection> {
    let database_path = vault_root.join(".mindzj").join("literature.db");
    let connection = Connection::open(database_path)
        .map_err(|error| KernelError::Database(error.to_string()))?;
    connection
        .execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;",
        )
        .map_err(|error| KernelError::Database(error.to_string()))?;
    migrate(&connection)?;
    Ok(connection)
}

fn migrate(connection: &Connection) -> KernelResult<()> {
    let current_version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| KernelError::Database(error.to_string()))?;

    if current_version < 1 {
        connection
            .execute_batch(
                "BEGIN IMMEDIATE;
                 CREATE TABLE IF NOT EXISTS papers (
                    id TEXT PRIMARY KEY,
                    relative_path TEXT NOT NULL UNIQUE,
                    content_hash TEXT NOT NULL,
                    title TEXT,
                    page_count INTEGER,
                    parse_status TEXT NOT NULL DEFAULT 'pending',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS idx_papers_content_hash
                    ON papers(content_hash);
                 CREATE TABLE IF NOT EXISTS processing_jobs (
                    id TEXT PRIMARY KEY,
                    paper_id TEXT,
                    job_type TEXT NOT NULL,
                    status TEXT NOT NULL,
                    progress REAL NOT NULL DEFAULT 0,
                    error_message TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY(paper_id) REFERENCES papers(id) ON DELETE CASCADE
                 );
                 PRAGMA user_version = 1;
                 COMMIT;",
            )
            .map_err(|error| KernelError::Database(error.to_string()))?;
    }

    if current_version < 2 {
        connection
            .execute_batch(
                "BEGIN IMMEDIATE;
                 CREATE TABLE IF NOT EXISTS pages (
                    id TEXT PRIMARY KEY,
                    paper_id TEXT NOT NULL,
                    page_number INTEGER NOT NULL,
                    width REAL NOT NULL,
                    height REAL NOT NULL,
                    text_content TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(paper_id, page_number),
                    FOREIGN KEY(paper_id) REFERENCES papers(id) ON DELETE CASCADE
                 );
                 CREATE INDEX IF NOT EXISTS idx_pages_paper_page
                    ON pages(paper_id, page_number);
                 CREATE TABLE IF NOT EXISTS paragraphs (
                    id TEXT PRIMARY KEY,
                    paper_id TEXT NOT NULL,
                    page_id TEXT NOT NULL,
                    page_number INTEGER NOT NULL,
                    paragraph_index INTEGER NOT NULL,
                    column_index INTEGER NOT NULL DEFAULT 0,
                    text_content TEXT NOT NULL,
                    source_hash TEXT NOT NULL,
                    bbox_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(paper_id, page_number, paragraph_index),
                    FOREIGN KEY(paper_id) REFERENCES papers(id) ON DELETE CASCADE,
                    FOREIGN KEY(page_id) REFERENCES pages(id) ON DELETE CASCADE
                 );
                 CREATE INDEX IF NOT EXISTS idx_paragraphs_paper_page
                    ON paragraphs(paper_id, page_number, paragraph_index);
                 CREATE TABLE IF NOT EXISTS paragraph_boxes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    paragraph_id TEXT NOT NULL,
                    page_id TEXT NOT NULL,
                    box_index INTEGER NOT NULL,
                    x0 REAL NOT NULL,
                    y0 REAL NOT NULL,
                    x1 REAL NOT NULL,
                    y1 REAL NOT NULL,
                    FOREIGN KEY(paragraph_id) REFERENCES paragraphs(id) ON DELETE CASCADE,
                    FOREIGN KEY(page_id) REFERENCES pages(id) ON DELETE CASCADE
                 );
                 CREATE INDEX IF NOT EXISTS idx_paragraph_boxes_paragraph
                    ON paragraph_boxes(paragraph_id, box_index);
                 CREATE VIRTUAL TABLE IF NOT EXISTS paragraphs_fts USING fts5(
                    paragraph_id UNINDEXED,
                    paper_id UNINDEXED,
                    page_number UNINDEXED,
                    text_content,
                    tokenize = 'unicode61 remove_diacritics 2'
                 );
                 PRAGMA user_version = 2;
                 COMMIT;",
            )
            .map_err(|error| KernelError::Database(error.to_string()))?;
    }

    if current_version < 3 {
        connection
            .execute_batch(
                "BEGIN IMMEDIATE;
                 ALTER TABLE paragraph_boxes ADD COLUMN start_offset INTEGER;
                 ALTER TABLE paragraph_boxes ADD COLUMN end_offset INTEGER;
                 CREATE TABLE IF NOT EXISTS paragraph_analyses (
                    paragraph_id TEXT PRIMARY KEY,
                    paper_id TEXT NOT NULL,
                    source_hash TEXT NOT NULL,
                    translation TEXT NOT NULL,
                    summary TEXT NOT NULL,
                    key_points_json TEXT NOT NULL DEFAULT '[]',
                    provider TEXT NOT NULL,
                    model TEXT NOT NULL,
                    prompt_version TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY(paragraph_id) REFERENCES paragraphs(id) ON DELETE CASCADE,
                    FOREIGN KEY(paper_id) REFERENCES papers(id) ON DELETE CASCADE
                 );
                 CREATE INDEX IF NOT EXISTS idx_paragraph_analyses_paper
                    ON paragraph_analyses(paper_id);
                 CREATE TABLE IF NOT EXISTS paper_chat_sessions (
                    paper_id TEXT PRIMARY KEY,
                    messages_json TEXT NOT NULL DEFAULT '[]',
                    context_injected INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY(paper_id) REFERENCES papers(id) ON DELETE CASCADE
                 );
                 PRAGMA user_version = 3;
                 COMMIT;",
            )
            .map_err(|error| KernelError::Database(error.to_string()))?;
    }

    if current_version > SCHEMA_VERSION {
        return Err(KernelError::Database(format!(
            "literature.db schema version {} is newer than supported version {}",
            current_version, SCHEMA_VERSION
        )));
    }
    Ok(())
}
