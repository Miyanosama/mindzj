import { aiStore, type AiChatInputMessage } from "../../stores/ai";
import type {
    ParagraphAnalysisInput,
    ParagraphKeyPoint,
    PaperChatMessage,
    PaperReference,
    PdfParagraphRecord,
} from "./literatureRepository";

export const PAPER_ANALYSIS_PROMPT_VERSION = "paragraph-analysis-v1";
export const VIBERO_PAPER_SYSTEM_PROMPT = `你是 MindZJ 的论文 AI 助手，专门帮助用户阅读和理解学术论文。请用简洁、专业的语言回答问题。

格式要求：
1. 使用 Markdown 格式输出。
2. 数学公式必须用分隔符包裹，禁止在正文中裸写 LaTeX；行内公式使用 $...$，块级公式使用 $$...$$。
3. LaTeX 花括号和命令必须配对，优先使用常见命令（\\mathbf、\\boldsymbol、\\mathrm、\\mathcal、\\frac）。
4. 回答优先依据已注入的论文全文；无法从论文确定时明确说明。
5. 引用原文时尽量标注页码，例如 [第 3 页]。`;

type RawKeyPoint = {
    label?: unknown;
    evidenceQuotes?: unknown;
    evidence_quotes?: unknown;
};

type RawParagraphAnalysis = {
    translation?: unknown;
    summary?: unknown;
    keyPoints?: unknown;
    key_points?: unknown;
};

function parseJsonObject(raw: string): RawParagraphAnalysis {
    const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    try {
        return JSON.parse(trimmed) as RawParagraphAnalysis;
    } catch {
        const start = trimmed.indexOf("{");
        const end = trimmed.lastIndexOf("}");
        if (start < 0 || end <= start) throw new Error("模型没有返回有效的 JSON 分析结果");
        return JSON.parse(trimmed.slice(start, end + 1)) as RawParagraphAnalysis;
    }
}

function codePointOffset(text: string, utf16Offset: number): number {
    return Array.from(text.slice(0, utf16Offset)).length;
}

function evidenceForQuote(text: string, quote: string, from = 0) {
    const index = text.indexOf(quote, from);
    if (index < 0 || !quote) return null;
    return {
        startOffset: codePointOffset(text, index),
        endOffset: codePointOffset(text, index + quote.length),
        quote,
        nextSearchOffset: index + quote.length,
    };
}

function validateKeyPoints(text: string, value: unknown, summary: string): ParagraphKeyPoint[] {
    const source = Array.isArray(value) ? value as RawKeyPoint[] : [];
    const points: ParagraphKeyPoint[] = [];
    for (const item of source.slice(0, 6)) {
        const label = String(item?.label ?? "").trim();
        const quoteValues = item?.evidenceQuotes ?? item?.evidence_quotes;
        if (!label || !Array.isArray(quoteValues)) continue;
        let cursor = 0;
        const evidence = quoteValues
            .map((entry) => {
                const found = evidenceForQuote(text, String(entry ?? "").trim(), cursor);
                if (found) cursor = found.nextSearchOffset;
                return found && {
                    startOffset: found.startOffset,
                    endOffset: found.endOffset,
                    quote: found.quote,
                };
            })
            .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
        if (evidence.length) points.push({ label, evidence });
    }
    if (points.length) return points;

    const fallbackQuote = text.slice(0, Math.min(text.length, 120)).trim();
    const fallback = evidenceForQuote(text, fallbackQuote);
    return fallback ? [{
        label: summary || "本段核心内容",
        evidence: [{
            startOffset: fallback.startOffset,
            endOffset: fallback.endOffset,
            quote: fallback.quote,
        }],
    }] : [];
}

export async function analyzePaperParagraph(
    paragraph: PdfParagraphRecord,
    paperTitle: string,
    paperParagraphs: PdfParagraphRecord[],
): Promise<ParagraphAnalysisInput> {
    const prompt = `你是严谨的学术论文阅读助手。请分析下面一个英文论文段落，并且只输出 JSON，不要使用 Markdown 代码块。

JSON 格式：
{
  "translation": "忠实、完整、通顺的中文翻译",
  "summary": "一句简短中文总要点",
  "keyPoints": [
    {"label": "简短中文分要点", "evidenceQuotes": ["从原文逐字复制的证据片段"]}
  ]
}

规则：keyPoints 为 1 到 4 项；每项可有多个证据片段；evidenceQuotes 必须从原文逐字复制，不能改写；不要遗漏公式、数值和限定条件。

原文：
${paragraph.text}`;
    const raw = parseJsonObject(await aiStore.completeChat([
        {
            role: "system",
            content: `${buildPaperContext(paperTitle, paperParagraphs)}\n\n你负责结合整篇论文的术语、上下文和论证结构，输出指定段落的可验证翻译与要点 JSON。`,
        },
        { role: "user", content: prompt },
    ]));
    const translation = String(raw.translation ?? "").trim();
    const summary = String(raw.summary ?? "").trim();
    if (!translation || !summary) throw new Error("模型返回的翻译或总要点为空");
    return {
        paragraphId: paragraph.id,
        translation,
        summary,
        keyPoints: validateKeyPoints(paragraph.text, raw.keyPoints ?? raw.key_points, summary),
        provider: aiStore.currentProviderLabel(),
        model: aiStore.currentModelLabel(),
        promptVersion: PAPER_ANALYSIS_PROMPT_VERSION,
    };
}

export async function translateSelectedText(text: string): Promise<string> {
    const source = text.trim();
    if (!source) return "";
    return aiStore.completeChat([
        {
            role: "system",
            content: "你是学术翻译助手。将用户提供的论文原文准确翻译成简体中文，只返回译文。保留术语、数字和公式。",
        },
        { role: "user", content: source },
    ]);
}

export function buildPaperContext(
    title: string,
    paragraphs: PdfParagraphRecord[],
): string {
    const body = paragraphs
        .map((paragraph) => `[第 ${paragraph.pageNumber} 页 · ${paragraph.id}]\n${paragraph.text}`)
        .join("\n\n");
    return `${VIBERO_PAPER_SYSTEM_PROMPT}\n\n[论文标题]\n${title}\n\n[论文全文开始]\n${body}\n[论文全文结束]`;
}

function referenceBlock(references: PaperReference[]): string {
    if (!references.length) return "";
    return references
        .map((reference, index) => `\n[引用 ${index + 1}：${reference.label}]\n${reference.text}\n[引用结束]`)
        .join("\n");
}

export async function chatWithPaper(
    title: string,
    paragraphs: PdfParagraphRecord[],
    history: PaperChatMessage[],
    question: string,
    references: PaperReference[],
    onChunk?: (content: string, fullMessage: string) => void,
): Promise<string> {
    const messages: AiChatInputMessage[] = [
        { role: "system", content: buildPaperContext(title, paragraphs) },
        ...history.map((message) => ({
            role: message.role,
            content: message.role === "user"
                ? `${message.content}${referenceBlock(message.references)}`
                : message.content,
        })),
        { role: "user", content: `${question}${referenceBlock(references)}` },
    ];
    if (onChunk) return aiStore.streamChat(messages, onChunk);
    return aiStore.completeChat(messages);
}
