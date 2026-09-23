import type { PDFPageProxy } from "pdfjs-dist";

export interface PdfBox {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    startOffset?: number;
    endOffset?: number;
}

export interface PdfTextSpan extends PdfBox {
    text: string;
    fontName: string;
    fontSize: number;
    hasEol: boolean;
}

export interface PdfParagraph {
    paragraphIndex: number;
    columnIndex: number;
    text: string;
    box: PdfBox;
    boxes: PdfBox[];
}

export interface PdfPageAnalysis {
    pageNumber: number;
    width: number;
    height: number;
    text: string;
    spans: PdfTextSpan[];
    paragraphs: PdfParagraph[];
    columnCount: number;
}

export interface PdfTextItemInput {
    str: string;
    transform: readonly number[];
    width: number;
    height: number;
    fontName?: string;
    hasEOL?: boolean;
}

interface TextLine extends PdfBox {
    spans: PdfTextSpan[];
    text: string;
    fontSize: number;
    columnIndex: number;
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

function median(values: number[]): number {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2;
}

function unionBoxes(boxes: PdfBox[]): PdfBox {
    return {
        x0: Math.min(...boxes.map((box) => box.x0)),
        y0: Math.min(...boxes.map((box) => box.y0)),
        x1: Math.max(...boxes.map((box) => box.x1)),
        y1: Math.max(...boxes.map((box) => box.y1)),
    };
}

function normalizeItem(
    item: PdfTextItemInput,
    pageWidth: number,
    pageHeight: number,
): PdfTextSpan | null {
    const text = item.str.replace(/\s+/g, " ");
    if (!text.trim()) return null;

    const transform = item.transform;
    const x = transform[4] ?? 0;
    const baseline = transform[5] ?? 0;
    const fallbackHeight = Math.hypot(transform[2] ?? 0, transform[3] ?? 0);
    const height = Math.max(item.height || fallbackHeight || 1, 1);
    const width = Math.max(item.width || Math.hypot(transform[0] ?? 0, transform[1] ?? 0), 1);
    const top = pageHeight - baseline - height;

    return {
        text,
        fontName: item.fontName ?? "",
        fontSize: height / pageHeight,
        hasEol: Boolean(item.hasEOL),
        x0: clamp01(x / pageWidth),
        y0: clamp01(top / pageHeight),
        x1: clamp01((x + width) / pageWidth),
        y1: clamp01((top + height) / pageHeight),
    };
}

function joinInlineText(spans: PdfTextSpan[]): string {
    let result = "";
    for (const span of spans) {
        const next = span.text.trim();
        if (!next) continue;
        if (!result) {
            result = next;
            continue;
        }
        const previous = result.at(-1) ?? "";
        const first = next[0] ?? "";
        const needsSpace =
            !/\s/.test(previous) &&
            !/\s/.test(first) &&
            !/[\u3000-\u9fff]/u.test(previous) &&
            !/[\u3000-\u9fff]/u.test(first) &&
            !/^[,.;:!?%\])}]/.test(next) &&
            !/[([{/]$/.test(result);
        result += `${needsSpace ? " " : ""}${next}`;
    }
    return result.trim();
}

function buildLines(spans: PdfTextSpan[]): TextLine[] {
    const sorted = [...spans].sort((a, b) => {
        const vertical = a.y0 - b.y0;
        return Math.abs(vertical) > 0.003 ? vertical : a.x0 - b.x0;
    });
    const rows: PdfTextSpan[][] = [];

    for (const span of sorted) {
        const center = (span.y0 + span.y1) / 2;
        let bestRow: PdfTextSpan[] | undefined;
        let bestDistance = Number.POSITIVE_INFINITY;
        for (const row of rows) {
            const rowCenter = median(row.map((entry) => (entry.y0 + entry.y1) / 2));
            const tolerance = Math.max(0.0035, median(row.map((entry) => entry.y1 - entry.y0)) * 0.42);
            const distance = Math.abs(center - rowCenter);
            if (distance <= tolerance && distance < bestDistance) {
                bestRow = row;
                bestDistance = distance;
            }
        }
        if (bestRow) bestRow.push(span);
        else rows.push([span]);
    }

    const lines: TextLine[] = [];
    for (const row of rows) {
        row.sort((a, b) => a.x0 - b.x0);
        let segment: PdfTextSpan[] = [];
        for (const span of row) {
            const previous = segment.at(-1);
            const largeGap = previous && span.x0 - previous.x1 > 0.065;
            if (largeGap && segment.length) {
                lines.push(makeLine(segment));
                segment = [];
            }
            segment.push(span);
            if (span.hasEol) {
                lines.push(makeLine(segment));
                segment = [];
            }
        }
        if (segment.length) lines.push(makeLine(segment));
    }
    return lines;
}

function makeLine(spans: PdfTextSpan[]): TextLine {
    const box = unionBoxes(spans);
    return {
        ...box,
        spans: [...spans],
        text: joinInlineText(spans),
        fontSize: median(spans.map((span) => span.fontSize)),
        columnIndex: 0,
    };
}

function assignColumns(lines: TextLine[]): number {
    const candidates = lines.filter((line) => line.x1 - line.x0 < 0.62);
    const left = candidates.filter((line) => line.x1 <= 0.54);
    const right = candidates.filter((line) => line.x0 >= 0.46);
    const leftEdge = left.length ? Math.max(...left.map((line) => line.x1)) : 1;
    const rightEdge = right.length ? Math.min(...right.map((line) => line.x0)) : 0;
    const dualColumn = left.length >= 2 && right.length >= 2 && leftEdge < rightEdge + 0.04;

    for (const line of lines) {
        if (!dualColumn) {
            line.columnIndex = 0;
        } else if (line.x1 <= 0.56) {
            line.columnIndex = 0;
        } else if (line.x0 >= 0.44) {
            line.columnIndex = 1;
        } else {
            line.columnIndex = -1;
        }
    }
    return dualColumn ? 2 : 1;
}

function orderLines(lines: TextLine[], columnCount: number): TextLine[] {
    if (columnCount === 1) return [...lines].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);

    const columnLines = lines.filter((line) => line.columnIndex >= 0);
    const bodyTop = Math.min(...columnLines.map((line) => line.y0));
    const bodyBottom = Math.max(...columnLines.map((line) => line.y1));
    const fullWidth = lines.filter((line) => line.columnIndex < 0);
    const prefix = fullWidth.filter((line) => line.y0 < bodyTop).sort((a, b) => a.y0 - b.y0);
    const suffix = fullWidth.filter((line) => line.y0 >= bodyTop).sort((a, b) => a.y0 - b.y0);
    const left = columnLines.filter((line) => line.columnIndex === 0).sort((a, b) => a.y0 - b.y0);
    const right = columnLines.filter((line) => line.columnIndex === 1).sort((a, b) => a.y0 - b.y0);

    // Full-width text below the body is normally a footer. A rare full-width
    // heading inside the body remains ordered after both columns; its own box
    // is still accurate and can be corrected by a future structure model.
    const footer = suffix.filter((line) => line.y0 >= bodyBottom - 0.01);
    const middle = suffix.filter((line) => line.y0 < bodyBottom - 0.01);
    return [...prefix, ...middle, ...left, ...right, ...footer];
}

function endsParagraph(line: TextLine, columnWidth: number): boolean {
    const text = line.text.trim();
    if (!text) return true;
    const shortLine = line.x1 - line.x0 < columnWidth * 0.78;
    return shortLine && /[.!?。！？;；:]$/.test(text);
}

function startsBlock(text: string): boolean {
    return /^(?:[•●▪◦*-]|\(?\d+[.)]|[A-Z]\.)\s+/.test(text.trim());
}

function joinParagraphLines(lines: TextLine[]): { text: string; boxes: PdfBox[] } {
    let text = "";
    const boxes: PdfBox[] = [];
    for (const line of lines) {
        const next = line.text.trim();
        if (!next) continue;
        let startOffset = text.length;
        if (!text) {
            text = next;
        } else if (/[-‐‑‒–]$/.test(text) && /^[a-z]/.test(next)) {
            text = `${text.slice(0, -1)}${next}`;
            startOffset = Math.max(0, startOffset - 1);
            const previous = boxes.at(-1);
            if (previous?.endOffset !== undefined) previous.endOffset = startOffset;
        } else if (/[\u3000-\u9fff]$/u.test(text) && /^[\u3000-\u9fff]/u.test(next)) {
            text += next;
        } else {
            text += ` ${next}`;
        }
        boxes.push({
            x0: line.x0,
            y0: line.y0,
            x1: line.x1,
            y1: line.y1,
            startOffset,
            endOffset: text.length,
        });
    }
    return { text: text.normalize("NFC").trim(), boxes };
}

function buildParagraphs(lines: TextLine[]): PdfParagraph[] {
    if (!lines.length) return [];
    const bodyFontSize = median(lines.map((line) => line.fontSize).filter((size) => size > 0));
    const groups: TextLine[][] = [];
    let current: TextLine[] = [];

    for (const line of lines) {
        const previous = current.at(-1);
        const columnLines = lines.filter((entry) => entry.columnIndex === line.columnIndex);
        const columnWidth = Math.max(0.2, Math.max(...columnLines.map((entry) => entry.x1)) - Math.min(...columnLines.map((entry) => entry.x0)));
        const verticalGap = previous ? line.y0 - previous.y1 : 0;
        const fontChange = previous
            ? Math.abs(line.fontSize - previous.fontSize) > Math.max(0.002, bodyFontSize * 0.2)
            : false;
        const indented = previous && line.x0 - previous.x0 > 0.025;
        const newParagraph = Boolean(
            previous && (
                line.columnIndex !== previous.columnIndex ||
                verticalGap > Math.max(0.006, bodyFontSize * 0.75) ||
                fontChange ||
                startsBlock(line.text) ||
                (indented && /[.!?。！？]$/.test(previous.text.trim())) ||
                endsParagraph(previous, columnWidth)
            )
        );
        if (newParagraph && current.length) {
            groups.push(current);
            current = [];
        }
        current.push(line);
    }
    if (current.length) groups.push(current);

    return groups
        .map((group, paragraphIndex) => {
            const joined = joinParagraphLines(group);
            const geometry = joined.boxes.map(({ x0, y0, x1, y1 }) => ({ x0, y0, x1, y1 }));
            return {
                paragraphIndex,
                columnIndex: group[0]?.columnIndex ?? 0,
                text: joined.text,
                box: unionBoxes(geometry),
                boxes: joined.boxes,
            };
        })
        .filter((paragraph) => paragraph.text.length > 0);
}

export function analyzePdfTextItems(
    pageNumber: number,
    pageWidth: number,
    pageHeight: number,
    items: readonly PdfTextItemInput[],
): PdfPageAnalysis {
    const fingerprints = new Set<string>();
    const spans: PdfTextSpan[] = [];
    for (const item of items) {
        const span = normalizeItem(item, pageWidth, pageHeight);
        if (!span) continue;
        const fingerprint = `${span.text}|${span.x0.toFixed(4)}|${span.y0.toFixed(4)}|${span.x1.toFixed(4)}|${span.y1.toFixed(4)}`;
        if (fingerprints.has(fingerprint)) continue;
        fingerprints.add(fingerprint);
        spans.push(span);
    }

    const lines = buildLines(spans);
    const columnCount = assignColumns(lines);
    const orderedLines = orderLines(lines, columnCount);
    const paragraphs = buildParagraphs(orderedLines);
    return {
        pageNumber,
        width: pageWidth,
        height: pageHeight,
        text: paragraphs.map((paragraph) => paragraph.text).join("\n\n"),
        spans,
        paragraphs,
        columnCount,
    };
}

export async function analyzePdfPage(
    pageNumber: number,
    page: PDFPageProxy,
): Promise<PdfPageAnalysis> {
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items = content.items.filter(
        (item): item is typeof item & PdfTextItemInput => "str" in item,
    );
    return analyzePdfTextItems(pageNumber, viewport.width, viewport.height, items);
}
