import { For, createMemo, createSignal, type Component } from "solid-js";
import type { PdfBox } from "../../services/pdf/layout";
import type {
    EvidenceRef,
    ParagraphAnalysisRecord,
    PaperReference,
    PdfParagraphRecord,
} from "../../services/pdf/literatureRepository";

export const PAPER_REFERENCE_MIME = "application/x-mindzj-paper-reference";

function evidenceBoxes(paragraph: PdfParagraphRecord, evidence: EvidenceRef[]): PdfBox[] {
    const ranged = paragraph.boxes.filter((box) =>
        box.startOffset !== undefined && box.endOffset !== undefined,
    );
    if (!ranged.length) return paragraph.boxes;
    return ranged.filter((box) => evidence.some((ref) =>
        (box.endOffset ?? 0) > ref.startOffset && (box.startOffset ?? 0) < ref.endOffset,
    ));
}

function toReference(
    paragraph: PdfParagraphRecord,
    label: string,
    evidence?: EvidenceRef[],
): PaperReference {
    return {
        paragraphId: paragraph.id,
        pageNumber: paragraph.pageNumber,
        label,
        text: evidence?.length ? evidence.map((entry) => entry.quote).join(" … ") : paragraph.text,
    };
}

export const ParagraphCardLane: Component<{
    pageNumber: number;
    pageHeight: number;
    paragraphs: PdfParagraphRecord[];
    analyses: ParagraphAnalysisRecord[];
    onEvidenceChange: (boxes: PdfBox[] | null) => void;
    onInsertReference: (reference: PaperReference) => void;
}> = (props) => {
    const [expandedId, setExpandedId] = createSignal<string | null>(null);
    const cards = createMemo(() => {
        const byParagraph = new Map(props.paragraphs.map((paragraph) => [paragraph.id, paragraph]));
        let previousBottom = 0;
        return props.analyses
            .filter((analysis) => analysis.pageNumber === props.pageNumber)
            .map((analysis) => {
                const paragraph = byParagraph.get(analysis.paragraphId);
                if (!paragraph) return null;
                const anchor = (paragraph.boxes[0]?.y0 ?? 0) * props.pageHeight;
                const top = Math.max(anchor, previousBottom);
                previousBottom = top + 106;
                return { analysis, paragraph, top };
            })
            .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
    });

    function startDrag(
        event: DragEvent,
        paragraph: PdfParagraphRecord,
        label: string,
        evidence?: EvidenceRef[],
    ) {
        const reference = toReference(paragraph, label, evidence);
        event.dataTransfer?.setData(PAPER_REFERENCE_MIME, JSON.stringify(reference));
        event.dataTransfer?.setData("text/plain", reference.text);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy";
    }

    return (
        <aside class="mz-pdf-card-lane" style={{ height: `${props.pageHeight}px` }}>
            <For each={cards()}>
                {(entry) => (
                    <article
                        class="mz-pdf-paragraph-card"
                        classList={{ "is-expanded": expandedId() === entry.paragraph.id }}
                        style={{ top: `${entry.top}px` }}
                        draggable
                        onDragStart={(event) => startDrag(event, entry.paragraph, entry.analysis.summary)}
                        onMouseEnter={() => props.onEvidenceChange(entry.paragraph.boxes)}
                        onMouseLeave={() => props.onEvidenceChange(null)}
                        onClick={() => setExpandedId((value) => value === entry.paragraph.id ? null : entry.paragraph.id)}
                    >
                        <div class="mz-pdf-card-page">第 {entry.paragraph.pageNumber} 页</div>
                        <p class="mz-pdf-card-summary">{entry.analysis.summary}</p>
                        <div class="mz-pdf-card-tags">
                            <For each={entry.analysis.keyPoints}>
                                {(point) => (
                                    <button
                                        class="mz-pdf-card-tag"
                                        draggable
                                        title={point.evidence.map((item) => item.quote).join("\n")}
                                        onMouseEnter={(event) => {
                                            event.stopPropagation();
                                            props.onEvidenceChange(evidenceBoxes(entry.paragraph, point.evidence));
                                        }}
                                        onMouseLeave={(event) => {
                                            event.stopPropagation();
                                            props.onEvidenceChange(null);
                                        }}
                                        onClick={(event) => {
                                            event.stopPropagation();
                                            props.onEvidenceChange(evidenceBoxes(entry.paragraph, point.evidence));
                                        }}
                                        onDblClick={(event) => {
                                            event.stopPropagation();
                                            props.onInsertReference(toReference(entry.paragraph, point.label, point.evidence));
                                        }}
                                        onDragStart={(event) => {
                                            event.stopPropagation();
                                            startDrag(event, entry.paragraph, point.label, point.evidence);
                                        }}
                                    >
                                        {point.label}
                                    </button>
                                )}
                            </For>
                        </div>
                        <div class="mz-pdf-card-translation">{entry.analysis.translation}</div>
                        <button
                            class="mz-pdf-card-quote"
                            title="添加到 AI 对话"
                            onClick={(event) => {
                                event.stopPropagation();
                                props.onInsertReference(toReference(entry.paragraph, entry.analysis.summary));
                            }}
                        >
                            引用
                        </button>
                    </article>
                )}
            </For>
        </aside>
    );
};
