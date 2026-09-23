import { invoke } from "@tauri-apps/api/core";
import type { PdfBox, PdfPageAnalysis } from "./layout";

export interface PaperRecord {
    id: string;
    relativePath: string;
    contentHash: string;
    title: string;
    pageCount: number | null;
    parseStatus: "pending" | "ready" | "requires_ocr" | string;
}

export interface PdfIndexSummary {
    paperId: string;
    pageCount: number;
    paragraphCount: number;
    parseStatus: "ready" | "requires_ocr" | string;
}

export interface PdfSearchResult {
    paragraphId: string;
    pageNumber: number;
    paragraphIndex: number;
    snippet: string;
    text: string;
    boxes: PdfBox[];
}

export interface PdfParagraphRecord {
    id: string;
    paperId: string;
    pageNumber: number;
    paragraphIndex: number;
    columnIndex: number;
    text: string;
    sourceHash: string;
    boxes: PdfBox[];
}

export interface EvidenceRef {
    startOffset: number;
    endOffset: number;
    quote: string;
}

export interface ParagraphKeyPoint {
    label: string;
    evidence: EvidenceRef[];
}

export interface ParagraphAnalysisInput {
    paragraphId: string;
    translation: string;
    summary: string;
    keyPoints: ParagraphKeyPoint[];
    provider: string;
    model: string;
    promptVersion: string;
}

export interface ParagraphAnalysisRecord extends ParagraphAnalysisInput {
    paperId: string;
    pageNumber: number;
    paragraphIndex: number;
    sourceHash: string;
    updatedAt: string;
}

export interface PaperReference {
    paragraphId?: string;
    pageNumber?: number;
    label: string;
    text: string;
}

export interface PaperChatMessage {
    id: string;
    role: "user" | "assistant";
    content: string;
    references: PaperReference[];
    createdAt: string;
}

export interface PaperChatSession {
    paperId: string;
    messages: PaperChatMessage[];
    contextInjected: boolean;
}

export function getPdfRecord(relativePath: string): Promise<PaperRecord> {
    return invoke("get_pdf_record", { relativePath });
}

export function indexPdfDocument(
    relativePath: string,
    pages: PdfPageAnalysis[],
): Promise<PdfIndexSummary> {
    return invoke("index_pdf_document", {
        relativePath,
        pages: pages.map((page) => ({
            pageNumber: page.pageNumber,
            width: page.width,
            height: page.height,
            text: page.text,
            paragraphs: page.paragraphs.map((paragraph) => ({
                paragraphIndex: paragraph.paragraphIndex,
                columnIndex: paragraph.columnIndex,
                text: paragraph.text,
                boxes: paragraph.boxes,
            })),
        })),
    });
}

export function searchPdfDocument(
    relativePath: string,
    query: string,
): Promise<PdfSearchResult[]> {
    return invoke("search_pdf_document", { relativePath, query, limit: 50 });
}

export function getPdfParagraphs(relativePath: string): Promise<PdfParagraphRecord[]> {
    return invoke("get_pdf_paragraphs", { relativePath });
}

export function getParagraphAnalyses(relativePath: string): Promise<ParagraphAnalysisRecord[]> {
    return invoke("get_paragraph_analyses", { relativePath });
}

export function saveParagraphAnalysis(
    relativePath: string,
    analysis: ParagraphAnalysisInput,
): Promise<ParagraphAnalysisRecord> {
    return invoke("save_paragraph_analysis", { relativePath, analysis });
}

export function getPaperChatSession(relativePath: string): Promise<PaperChatSession> {
    return invoke("get_paper_chat_session", { relativePath });
}

export function savePaperChatSession(
    relativePath: string,
    messages: PaperChatMessage[],
    contextInjected: boolean,
): Promise<PaperChatSession> {
    return invoke("save_paper_chat_session", { relativePath, messages, contextInjected });
}

export function saveProcessingJob(job: {
    id: string;
    paperId?: string;
    jobType: string;
    status: string;
    progress: number;
    errorMessage?: string;
}): Promise<void> {
    return invoke("save_processing_job", { job });
}
