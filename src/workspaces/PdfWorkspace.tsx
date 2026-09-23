import {
    Component,
    For,
    Show,
    createEffect,
    createMemo,
    createSignal,
    onCleanup,
    onMount,
    untrack,
} from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type {
    PDFDocumentLoadingTask,
    PDFDocumentProxy,
    RenderTask,
    TextLayer,
} from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { vaultStore } from "../stores/vault";
import { editorStore } from "../stores/editor";
import { aiStore } from "../stores/ai";
import { processingJobStore, type ProcessingJobStatus } from "../stores/processingJobs";
import { displayName } from "../utils/displayName";
import { toVaultAssetUrl } from "../utils/vaultPaths";
import { t } from "../i18n";
import { analyzePdfPage, type PdfPageAnalysis } from "../services/pdf/layout";
import {
    getParagraphAnalyses,
    getPdfParagraphs,
    getPdfRecord,
    saveParagraphAnalysis,
    saveProcessingJob,
    indexPdfDocument,
    searchPdfDocument,
    type ParagraphAnalysisRecord,
    type PaperReference,
    type PdfParagraphRecord,
    type PdfSearchResult,
} from "../services/pdf/literatureRepository";
import { analyzePaperParagraph, translateSelectedText } from "../services/pdf/paperAiService";
import { ParagraphCardLane } from "../components/pdf/ParagraphCardLane";
import { PdfAiChatPanel } from "../components/pdf/PdfAiChatPanel";

let pdfModulePromise: Promise<typeof import("pdfjs-dist")> | null = null;

function loadPdfModule() {
    pdfModulePromise ??= import("pdfjs-dist").then((pdfjs) => {
        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
        return pdfjs;
    });
    return pdfModulePromise;
}

const MIN_ZOOM = 0.35;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.15;

function clampZoom(value: number): number {
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

function toolbarButtonStyle(disabled = false) {
    return {
        height: "30px",
        "min-width": "30px",
        padding: "0 9px",
        border: "1px solid var(--mz-border)",
        "border-radius": "var(--mz-radius-sm)",
        background: "var(--mz-bg-primary)",
        color: "var(--mz-text-secondary)",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? "0.45" : "1",
        "font-family": "var(--mz-font-sans)",
        "font-size": "var(--mz-font-size-xs)",
    } as const;
}

type IndexState = "idle" | "indexing" | "ready" | "requires_ocr" | "failed";
type ReadingMode = "paged" | "continuous";

const ContinuousPdfPage: Component<{
    pdf: PDFDocumentProxy;
    pageNumber: number;
    zoom: number;
    scrollRoot: () => HTMLDivElement | undefined;
    activeResult: PdfSearchResult | null;
    estimatedWidth: number;
    estimatedHeight: number;
    paragraphs: PdfParagraphRecord[];
    analyses: ParagraphAnalysisRecord[];
    showCards: boolean;
    evidenceBoxes: import("../services/pdf/layout").PdfBox[];
    onEvidenceChange: (pageNumber: number, boxes: import("../services/pdf/layout").PdfBox[] | null) => void;
    onInsertReference: (reference: PaperReference) => void;
}> = (props) => {
    let pageRef: HTMLDivElement | undefined;
    let canvasRef: HTMLCanvasElement | undefined;
    let textLayerRef: HTMLDivElement | undefined;
    let observer: IntersectionObserver | null = null;
    let renderTask: RenderTask | null = null;
    let textLayer: TextLayer | null = null;
    let renderGeneration = 0;
    const [shouldRender, setShouldRender] = createSignal(false);
    const [naturalWidth, setNaturalWidth] = createSignal(props.estimatedWidth);
    const [naturalHeight, setNaturalHeight] = createSignal(props.estimatedHeight);

    const clearRenderedPage = () => {
        renderTask?.cancel();
        renderTask = null;
        textLayer?.cancel();
        textLayer = null;
        textLayerRef?.replaceChildren();
        if (canvasRef) {
            canvasRef.width = 0;
            canvasRef.height = 0;
        }
    };

    onMount(() => {
        if (!pageRef) return;
        observer = new IntersectionObserver(
            ([entry]) => setShouldRender(entry.isIntersecting),
            {
                root: props.scrollRoot() ?? null,
                rootMargin: "1000px 0px",
                threshold: 0,
            },
        );
        observer.observe(pageRef);
    });

    createEffect(() => {
        const visible = shouldRender();
        const currentZoom = props.zoom;
        if (!visible) {
            renderGeneration += 1;
            clearRenderedPage();
            return;
        }

        const generation = ++renderGeneration;
        clearRenderedPage();
        void props.pdf
            .getPage(props.pageNumber)
            .then(async (page) => {
                if (generation !== renderGeneration) return;
                const natural = page.getViewport({ scale: 1 });
                const viewport = page.getViewport({ scale: currentZoom });
                setNaturalWidth(natural.width);
                setNaturalHeight(natural.height);

                const canvas = canvasRef;
                const textContainer = textLayerRef;
                if (!canvas || !textContainer) return;
                const context = canvas.getContext("2d", { alpha: false });
                if (!context) throw new Error("Canvas 2D context is unavailable");
                const outputScale = Math.max(1, window.devicePixelRatio || 1);
                canvas.width = Math.floor(viewport.width * outputScale);
                canvas.height = Math.floor(viewport.height * outputScale);
                canvas.style.width = `${Math.floor(viewport.width)}px`;
                canvas.style.height = `${Math.floor(viewport.height)}px`;
                const transform =
                    outputScale === 1
                        ? undefined
                        : ([outputScale, 0, 0, outputScale, 0, 0] as [
                              number,
                              number,
                              number,
                              number,
                              number,
                              number,
                          ]);

                renderTask = page.render({ canvasContext: context, viewport, transform });
                const [pdfModule, textContent] = await Promise.all([
                    loadPdfModule(),
                    page.getTextContent(),
                ]);
                if (generation !== renderGeneration) return;
                textContainer.replaceChildren();
                textContainer.style.setProperty("--scale-factor", String(currentZoom));
                textLayer = new pdfModule.TextLayer({
                    textContentSource: textContent,
                    container: textContainer,
                    viewport,
                });
                await Promise.all([renderTask.promise, textLayer.render()]);
            })
            .catch((reason: unknown) => {
                if (generation !== renderGeneration) return;
                if (reason instanceof Error && (reason.name === "RenderingCancelledException" || reason.name === "AbortException")) return;
                console.error(`[PdfWorkspace] failed to render continuous page ${props.pageNumber}:`, reason);
            });
    });

    onCleanup(() => {
        renderGeneration += 1;
        observer?.disconnect();
        clearRenderedPage();
    });

    return (
        <div ref={pageRef} data-pdf-page={props.pageNumber} class="mz-pdf-page-with-cards">
            <div
                class="mz-pdf-page-surface"
                style={{
                    width: `${naturalWidth() * props.zoom}px`,
                    height: `${naturalHeight() * props.zoom}px`,
                }}
            >
                <canvas ref={canvasRef} aria-label={t("pdf.pageCanvas", { page: props.pageNumber })} style={{ display: "block" }} />
                <div ref={textLayerRef} class="mz-pdf-text-layer" aria-label={t("pdf.textLayer")} />
                <Show when={props.activeResult?.pageNumber === props.pageNumber}>
                    <PdfHighlightOverlay boxes={props.activeResult?.boxes ?? []} kind="search" />
                </Show>
                <Show when={props.evidenceBoxes.length}>
                    <PdfHighlightOverlay boxes={props.evidenceBoxes} kind="evidence" />
                </Show>
                <span class="mz-pdf-page-badge">{props.pageNumber}</span>
            </div>
            <Show when={props.showCards}>
                <ParagraphCardLane
                    pageNumber={props.pageNumber}
                    pageHeight={naturalHeight() * props.zoom}
                    paragraphs={props.paragraphs}
                    analyses={props.analyses}
                    onEvidenceChange={(boxes) => props.onEvidenceChange(props.pageNumber, boxes)}
                    onInsertReference={props.onInsertReference}
                />
            </Show>
        </div>
    );
};

const PdfHighlightOverlay: Component<{
    boxes: import("../services/pdf/layout").PdfBox[];
    kind: "search" | "evidence";
}> = (props) => (
    <div class={`mz-pdf-highlight-layer is-${props.kind}`}>
        <For each={props.boxes}>
            {(box) => <div style={{ left: `${box.x0 * 100}%`, top: `${box.y0 * 100}%`, width: `${(box.x1 - box.x0) * 100}%`, height: `${(box.y1 - box.y0) * 100}%` }} />}
        </For>
    </div>
);

export const PdfWorkspace: Component<{
    filePath: string;
    active?: boolean;
}> = (props) => {
    let canvasRef: HTMLCanvasElement | undefined;
    let textLayerRef: HTMLDivElement | undefined;
    let scrollRef: HTMLDivElement | undefined;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    let renderTask: RenderTask | null = null;
    let textLayer: TextLayer | null = null;
    let loadGeneration = 0;
    let renderGeneration = 0;
    let continuousScrollFrame = 0;
    const pageCache = new Map<number, PdfPageAnalysis>();

    const [documentProxy, setDocumentProxy] = createSignal<PDFDocumentProxy | null>(null);
    const [pageNumber, setPageNumber] = createSignal(1);
    const [pageCount, setPageCount] = createSignal(0);
    const [zoom, setZoom] = createSignal(1.15);
    const [readingMode, setReadingMode] = createSignal<ReadingMode>("paged");
    const [estimatedPageSize, setEstimatedPageSize] = createSignal({ width: 612, height: 792 });
    const [loading, setLoading] = createSignal(true);
    const [rendering, setRendering] = createSignal(false);
    const [error, setError] = createSignal<string | null>(null);
    const [indexState, setIndexState] = createSignal<IndexState>("idle");
    const [indexProgress, setIndexProgress] = createSignal(0);
    const [searchQuery, setSearchQuery] = createSignal("");
    const [searching, setSearching] = createSignal(false);
    const [searchResults, setSearchResults] = createSignal<PdfSearchResult[]>([]);
    const [showSearch, setShowSearch] = createSignal(false);
    const [activeResult, setActiveResult] = createSignal<PdfSearchResult | null>(null);
    const [paperId, setPaperId] = createSignal<string | null>(null);
    const [paragraphs, setParagraphs] = createSignal<PdfParagraphRecord[]>([]);
    const [analyses, setAnalyses] = createSignal<ParagraphAnalysisRecord[]>([]);
    const [showCards, setShowCards] = createSignal(true);
    const [showAiChat, setShowAiChat] = createSignal(false);
    const [paperAiEnabled, setPaperAiEnabled] = createSignal(false);
    const [queuedReference, setQueuedReference] = createSignal<PaperReference | null>(null);
    const [activeEvidence, setActiveEvidence] = createSignal<{
        pageNumber: number;
        boxes: import("../services/pdf/layout").PdfBox[];
    } | null>(null);
    const [pretranslationStatus, setPretranslationStatus] = createSignal<ProcessingJobStatus | "idle">("idle");
    const [pretranslationProgress, setPretranslationProgress] = createSignal(0);
    const [pretranslationError, setPretranslationError] = createSignal<string | null>(null);
    const [selectionPopup, setSelectionPopup] = createSignal<{ text: string; x: number; y: number } | null>(null);
    const [selectionTranslation, setSelectionTranslation] = createSignal<string | null>(null);
    const [translatingSelection, setTranslatingSelection] = createSignal(false);
    const [pretranslationControl, setPretranslationControl] = createSignal<"running" | "pause" | "cancel">("running");

    const fileName = createMemo(() => displayName(props.filePath));
    const assetUrl = createMemo(() => {
        const root = vaultStore.vaultInfo()?.path ?? "";
        return root ? toVaultAssetUrl(root, props.filePath) : "";
    });

    createEffect(() => {
        if (!props.active) return;
        editorStore.updateStats("");
        editorStore.setCursorLine(pageNumber());
        editorStore.setCursorCol(1);
    });

    const destroyDocument = () => {
        renderTask?.cancel();
        renderTask = null;
        textLayer?.cancel();
        textLayer = null;
        textLayerRef?.replaceChildren();
        void loadingTask?.destroy();
        loadingTask = null;
        const current = untrack(documentProxy);
        if (current) void current.destroy();
        setDocumentProxy(null);
        pageCache.clear();
    };

    createEffect(() => {
        const url = assetUrl();
        const relativePath = props.filePath;
        const generation = ++loadGeneration;
        destroyDocument();
        setPageNumber(1);
        setPageCount(0);
        setIndexState("idle");
        setIndexProgress(0);
        setSearchResults([]);
        setActiveResult(null);
        setPaperId(null);
        setParagraphs([]);
        setAnalyses([]);
        setQueuedReference(null);
        setPaperAiEnabled(false);
        setActiveEvidence(null);
        setPretranslationStatus("idle");
        setPretranslationProgress(0);
        setPretranslationError(null);
        setSelectionPopup(null);
        setSelectionTranslation(null);
        setError(null);
        setLoading(true);
        if (!url) {
            setLoading(false);
            setError(t("pdf.noVault"));
            return;
        }

        void loadPdfModule()
            .then(({ getDocument }) => {
                if (generation !== loadGeneration) return null;
                const task = getDocument({ url });
                loadingTask = task;
                return task.promise;
            })
            .then((pdf) => {
                if (!pdf) return;
                if (generation !== loadGeneration) {
                    void pdf.destroy();
                    return;
                }
                loadingTask = null;
                setDocumentProxy(pdf);
                setPageCount(pdf.numPages);
                setLoading(false);
                void pdf.getPage(1).then((page) => {
                    if (generation !== loadGeneration) return;
                    const viewport = page.getViewport({ scale: 1 });
                    setEstimatedPageSize({ width: viewport.width, height: viewport.height });
                });
                requestAnimationFrame(() => void fitWidth());
                void prepareDocumentIndex(pdf, relativePath, generation);
            })
            .catch((reason: unknown) => {
                if (generation !== loadGeneration) return;
                console.error("[PdfWorkspace] failed to load PDF:", reason);
                setLoading(false);
                setError(reason instanceof Error ? reason.message : t("pdf.loadFailed"));
            });
    });

    createEffect(() => {
        const pdf = documentProxy();
        const currentPage = pageNumber();
        const currentZoom = zoom();
        const mode = readingMode();
        if (loading()) return;
        if (mode === "continuous") {
            renderGeneration += 1;
            renderTask?.cancel();
            renderTask = null;
            textLayer?.cancel();
            textLayer = null;
            textLayerRef?.replaceChildren();
            setRendering(false);
            return;
        }
        const canvas = canvasRef;
        if (!pdf || !canvas) return;

        const generation = ++renderGeneration;
        renderTask?.cancel();
        renderTask = null;
        textLayer?.cancel();
        textLayer = null;
        textLayerRef?.replaceChildren();
        setRendering(true);

        void pdf
            .getPage(currentPage)
            .then(async (page) => {
                if (generation !== renderGeneration) return;
                const viewport = page.getViewport({ scale: currentZoom });
                const outputScale = Math.max(1, window.devicePixelRatio || 1);
                const context = canvas.getContext("2d", { alpha: false });
                if (!context) throw new Error("Canvas 2D context is unavailable");

                canvas.width = Math.floor(viewport.width * outputScale);
                canvas.height = Math.floor(viewport.height * outputScale);
                canvas.style.width = `${Math.floor(viewport.width)}px`;
                canvas.style.height = `${Math.floor(viewport.height)}px`;

                const transform =
                    outputScale === 1
                        ? undefined
                        : ([outputScale, 0, 0, outputScale, 0, 0] as [
                              number,
                              number,
                              number,
                              number,
                              number,
                              number,
                          ]);
                renderTask = page.render({ canvasContext: context, viewport, transform });
                const analysisPromise = getPageAnalysis(pdf, currentPage);
                const textContentPromise = page.getTextContent();
                const pdfModule = await loadPdfModule();
                const textContent = await textContentPromise;
                if (generation !== renderGeneration) return;

                const textContainer = textLayerRef;
                if (!textContainer) throw new Error("PDF text layer container is unavailable");
                textContainer.replaceChildren();
                textContainer.style.setProperty("--scale-factor", String(currentZoom));
                textLayer = new pdfModule.TextLayer({
                    textContentSource: textContent,
                    container: textContainer,
                    viewport,
                });
                const textLayerPromise = textLayer.render();

                await Promise.all([renderTask.promise, analysisPromise, textLayerPromise]);
            })
            .then(() => {
                if (generation === renderGeneration) setRendering(false);
            })
            .catch((reason: unknown) => {
                if (generation !== renderGeneration) return;
                if (reason instanceof Error && reason.name === "RenderingCancelledException") return;
                console.error("[PdfWorkspace] failed to render page:", reason);
                setRendering(false);
                setError(reason instanceof Error ? reason.message : t("pdf.renderFailed"));
            });
    });

    onCleanup(() => {
        loadGeneration += 1;
        renderGeneration += 1;
        cancelAnimationFrame(continuousScrollFrame);
        destroyDocument();
    });

    async function getPageAnalysis(pdf: PDFDocumentProxy, nextPage: number) {
        if (pageCache.has(nextPage)) return pageCache.get(nextPage)!;
        const page = await pdf.getPage(nextPage);
        const analysis = await analyzePdfPage(nextPage, page);
        pageCache.set(nextPage, analysis);
        return analysis;
    }

    async function prepareDocumentIndex(
        pdf: PDFDocumentProxy,
        relativePath: string,
        generation: number,
    ) {
        try {
            const record = await getPdfRecord(relativePath);
            setPaperId(record.id);
            if (record.parseStatus === "ready" && record.pageCount === pdf.numPages) {
                if (generation === loadGeneration) {
                    setIndexState("ready");
                    await loadPaperAiData(relativePath, generation);
                }
                return;
            }
            if (generation !== loadGeneration) return;
            setIndexState("indexing");
            const pages: PdfPageAnalysis[] = [];
            for (let number = 1; number <= pdf.numPages; number += 1) {
                if (generation !== loadGeneration) return;
                pages.push(await getPageAnalysis(pdf, number));
                setIndexProgress(number / pdf.numPages);
                if (number % 3 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
            }
            const summary = await indexPdfDocument(relativePath, pages);
            if (generation !== loadGeneration) return;
            setIndexState(summary.parseStatus === "requires_ocr" ? "requires_ocr" : "ready");
            setPaperId(summary.paperId);
            await loadPaperAiData(relativePath, generation);
        } catch (reason) {
            if (generation !== loadGeneration) return;
            console.error("[PdfWorkspace] failed to index PDF:", reason);
            setIndexState("failed");
        }
    }

    async function loadPaperAiData(relativePath: string, generation: number) {
        const [nextParagraphs, nextAnalyses] = await Promise.all([
            getPdfParagraphs(relativePath),
            getParagraphAnalyses(relativePath),
        ]);
        if (generation !== loadGeneration) return;
        setParagraphs(nextParagraphs);
        setAnalyses(nextAnalyses);
        const completed = nextParagraphs.filter((paragraph) =>
            nextAnalyses.some((analysis) =>
                analysis.paragraphId === paragraph.id && analysis.sourceHash === paragraph.sourceHash,
            ),
        ).length;
        setPretranslationProgress(nextParagraphs.length ? completed / nextParagraphs.length : 0);
        if (nextParagraphs.length && completed === nextParagraphs.length) setPretranslationStatus("completed");
    }

    async function fitWidth() {
        const pdf = documentProxy();
        if (!pdf || !scrollRef) return;
        const page = await pdf.getPage(pageNumber());
        const natural = page.getViewport({ scale: 1 });
        const availableWidth = Math.max(240, scrollRef.clientWidth - 56);
        setZoom(clampZoom(availableWidth / natural.width));
    }

    function goToPage(next: number) {
        const max = pageCount();
        if (!max) return;
        const target = Math.max(1, Math.min(max, Math.round(next)));
        setPageNumber(target);
        if (readingMode() === "continuous") {
            requestAnimationFrame(() => {
                const page = scrollRef?.querySelector<HTMLElement>(`[data-pdf-page="${target}"]`);
                if (!page || !scrollRef) return;
                const rootRect = scrollRef.getBoundingClientRect();
                const pageRect = page.getBoundingClientRect();
                scrollRef.scrollTo({
                    top: scrollRef.scrollTop + pageRect.top - rootRect.top - 16,
                    left: 0,
                });
            });
        } else {
            scrollRef?.scrollTo({ top: 0, left: 0 });
        }
    }

    function toggleReadingMode() {
        const nextMode: ReadingMode = readingMode() === "paged" ? "continuous" : "paged";
        setReadingMode(nextMode);
        requestAnimationFrame(() => goToPage(pageNumber()));
    }

    function updateContinuousPageNumber() {
        if (readingMode() !== "continuous" || !scrollRef) return;
        cancelAnimationFrame(continuousScrollFrame);
        continuousScrollFrame = requestAnimationFrame(() => {
            if (!scrollRef) return;
            const rootRect = scrollRef.getBoundingClientRect();
            let mostVisiblePage = pageNumber();
            let greatestVisibleHeight = -1;
            for (const element of scrollRef.querySelectorAll<HTMLElement>("[data-pdf-page]")) {
                const rect = element.getBoundingClientRect();
                const visibleHeight = Math.max(
                    0,
                    Math.min(rect.bottom, rootRect.bottom) - Math.max(rect.top, rootRect.top),
                );
                if (visibleHeight > greatestVisibleHeight) {
                    greatestVisibleHeight = visibleHeight;
                    mostVisiblePage = Number(element.dataset.pdfPage) || mostVisiblePage;
                }
            }
            if (mostVisiblePage !== pageNumber()) setPageNumber(mostVisiblePage);
        });
    }

    async function performSearch() {
        const query = searchQuery().trim();
        setShowSearch(true);
        setActiveResult(null);
        if (!query) {
            setSearchResults([]);
            return;
        }
        setSearching(true);
        try {
            setSearchResults(await searchPdfDocument(props.filePath, query));
        } catch (reason) {
            console.error("[PdfWorkspace] PDF search failed:", reason);
            setSearchResults([]);
        } finally {
            setSearching(false);
        }
    }

    function selectResult(result: PdfSearchResult) {
        setActiveResult(result);
        goToPage(result.pageNumber);
    }

    function closeSearchResults() {
        setShowSearch(false);
        setActiveResult(null);
    }

    function showEvidence(page: number, boxes: import("../services/pdf/layout").PdfBox[] | null) {
        setActiveEvidence(boxes?.length ? { pageNumber: page, boxes } : null);
    }

    function insertReference(reference: PaperReference) {
        setQueuedReference(reference);
        setShowAiChat(true);
    }

    async function persistPretranslationJob(
        status: ProcessingJobStatus,
        progress: number,
        errorMessage?: string,
    ) {
        const id = `translate-paragraphs:${paperId() ?? props.filePath}`;
        const job = {
            id,
            paperId: paperId() ?? undefined,
            type: "translate_paragraphs" as const,
            status,
            progress,
            errorMessage,
        };
        processingJobStore.upsert(job);
        await saveProcessingJob({
            id,
            paperId: job.paperId,
            jobType: job.type,
            status,
            progress,
            errorMessage,
        });
    }

    async function startPretranslation() {
        if (pretranslationStatus() === "running") return;
        if (!aiStore.isConfigured()) {
            setPretranslationError("请先在设置 → 模型接入中配置并测试 AI 模型。");
            return;
        }
        const allParagraphs = paragraphs();
        if (!allParagraphs.length) {
            setPretranslationError("论文文字尚未识别完成。");
            return;
        }
        const existing = new Map(analyses().map((analysis) => [analysis.paragraphId, analysis]));
        const pending = allParagraphs.filter((paragraph) => {
            const cached = existing.get(paragraph.id);
            return !cached || cached.sourceHash !== paragraph.sourceHash;
        });
        if (!pending.length) {
            setPretranslationStatus("completed");
            setPretranslationProgress(1);
            return;
        }

        setPretranslationControl("running");
        setPretranslationStatus("running");
        setPretranslationError(null);
        let completed = allParagraphs.length - pending.length;
        await persistPretranslationJob("running", completed / allParagraphs.length);
        try {
            for (const paragraph of pending) {
                if (pretranslationControl() !== "running") break;
                const input = await analyzePaperParagraph(paragraph, fileName(), allParagraphs);
                const saved = await saveParagraphAnalysis(props.filePath, input);
                setAnalyses((current) => [
                    ...current.filter((entry) => entry.paragraphId !== saved.paragraphId),
                    saved,
                ].sort((a, b) => a.pageNumber - b.pageNumber || a.paragraphIndex - b.paragraphIndex));
                completed += 1;
                const progress = completed / allParagraphs.length;
                setPretranslationProgress(progress);
                await persistPretranslationJob("running", progress);
                await new Promise<void>((resolve) => setTimeout(resolve, 0));
            }
            if (pretranslationControl() === "pause") {
                setPretranslationStatus("paused");
                await persistPretranslationJob("paused", completed / allParagraphs.length);
            } else if (pretranslationControl() === "cancel") {
                setPretranslationStatus("cancelled");
                await persistPretranslationJob("cancelled", completed / allParagraphs.length);
            } else {
                setPretranslationStatus("completed");
                setPretranslationProgress(1);
                await persistPretranslationJob("completed", 1);
            }
        } catch (reason) {
            const message = reason instanceof Error ? reason.message : String(reason);
            setPretranslationError(message);
            setPretranslationStatus("failed");
            await persistPretranslationJob("failed", completed / allParagraphs.length, message).catch(() => undefined);
        }
    }

    function handleTextSelection(event: MouseEvent) {
        const selection = window.getSelection();
        const text = selection?.toString().trim() ?? "";
        if (!selection || selection.isCollapsed || !text) {
            if (!(event.target as HTMLElement).closest(".mz-pdf-selection-popup")) {
                setSelectionPopup(null);
                setSelectionTranslation(null);
            }
            return;
        }
        const anchor = selection.anchorNode instanceof Element
            ? selection.anchorNode
            : selection.anchorNode?.parentElement;
        if (!anchor?.closest(".mz-pdf-text-layer")) return;
        const rect = selection.getRangeAt(0).getBoundingClientRect();
        setSelectionPopup({
            text,
            x: Math.max(12, Math.min(window.innerWidth - 330, rect.left + rect.width / 2)),
            y: Math.max(12, rect.top - 44),
        });
        setSelectionTranslation(null);
    }

    async function translateSelection() {
        const selected = selectionPopup();
        if (!selected || translatingSelection()) return;
        if (!aiStore.isConfigured()) {
            setSelectionTranslation("请先在设置中配置 AI 模型。");
            return;
        }
        setTranslatingSelection(true);
        try {
            setSelectionTranslation(await translateSelectedText(selected.text));
        } catch (reason) {
            setSelectionTranslation(reason instanceof Error ? reason.message : String(reason));
        } finally {
            setTranslatingSelection(false);
        }
    }

    async function openInDefaultApp() {
        await invoke("open_in_default_app", { relativePath: props.filePath });
    }

    async function revealInFileManager() {
        await invoke("reveal_in_file_manager", { relativePath: props.filePath });
    }

    return (
        <section class="mz-pdf-workspace" data-active={props.active ? "true" : "false"} style={{ position: "relative", flex: "1", display: "flex", "flex-direction": "column", "min-width": "0", "min-height": "0", overflow: "hidden", background: "var(--mz-bg-primary)" }}>
            <header style={{ height: "42px", display: "flex", "align-items": "center", gap: "8px", padding: "0 10px", "flex-shrink": "0", background: "var(--mz-bg-secondary)", "border-bottom": "1px solid var(--mz-border)" }}>
                <strong title={props.filePath} style={{ flex: "1", "min-width": "80px", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap", color: "var(--mz-text-primary)", "font-size": "var(--mz-font-size-sm)" }}>{fileName()}</strong>
                <Show when={indexState() === "indexing"}>
                    <span style={{ color: "var(--mz-text-muted)", "font-size": "11px" }}>{t("pdf.indexing", { progress: Math.round(indexProgress() * 100) })}</span>
                </Show>
                <Show when={indexState() === "requires_ocr"}>
                    <span style={{ color: "var(--mz-warning, #d19a66)", "font-size": "11px" }}>{t("pdf.requiresOcr")}</span>
                </Show>
                <button
                    style={toolbarButtonStyle()}
                    classList={{ "is-active": showCards() }}
                    title="显示或隐藏段落要点卡片"
                    onClick={() => setShowCards((value) => !value)}
                >
                    卡片
                </button>
                <div style={{ display: "flex", "align-items": "center", gap: "4px" }}>
                    <input type="search" value={searchQuery()} placeholder={t("pdf.searchPlaceholder")} onInput={(event) => setSearchQuery(event.currentTarget.value)} onFocus={() => setShowSearch(true)} onKeyDown={(event) => { if (event.key === "Enter") void performSearch(); if (event.key === "Escape") closeSearchResults(); }} style={{ width: "170px", height: "30px", padding: "0 8px", border: "1px solid var(--mz-border)", "border-radius": "var(--mz-radius-sm)", background: "var(--mz-bg-primary)", color: "var(--mz-text-primary)", "font-size": "12px" }} />
                    <button style={toolbarButtonStyle(searching())} disabled={searching()} onClick={() => void performSearch()}>{t("pdf.search")}</button>
                </div>
                <button style={toolbarButtonStyle(pageNumber() <= 1)} disabled={pageNumber() <= 1} title={t("pdf.previousPage")} onClick={() => goToPage(pageNumber() - 1)}>‹</button>
                <button style={toolbarButtonStyle()} title={readingMode() === "paged" ? t("pdf.switchToContinuous") : t("pdf.switchToPaged")} onClick={toggleReadingMode}>
                    {readingMode() === "paged" ? t("pdf.continuousMode") : t("pdf.pagedMode")}
                </button>
                <input aria-label={t("pdf.pageNumber")} type="number" min="1" max={pageCount() || 1} value={pageNumber()} onChange={(event) => goToPage(Number(event.currentTarget.value))} style={{ width: "52px", height: "30px", "box-sizing": "border-box", border: "1px solid var(--mz-border)", "border-radius": "var(--mz-radius-sm)", background: "var(--mz-bg-primary)", color: "var(--mz-text-primary)", "text-align": "center" }} />
                <span style={{ color: "var(--mz-text-muted)", "font-size": "12px" }}>/ {pageCount() || "—"}</span>
                <button style={toolbarButtonStyle(pageNumber() >= pageCount())} disabled={!pageCount() || pageNumber() >= pageCount()} title={t("pdf.nextPage")} onClick={() => goToPage(pageNumber() + 1)}>›</button>
                <div style={{ width: "1px", height: "20px", background: "var(--mz-border)" }} />
                <button style={toolbarButtonStyle(zoom() <= MIN_ZOOM)} disabled={zoom() <= MIN_ZOOM} title={t("pdf.zoomOut")} onClick={() => setZoom((value) => clampZoom(value - ZOOM_STEP))}>−</button>
                <span style={{ width: "48px", "text-align": "center", color: "var(--mz-text-secondary)", "font-size": "12px" }}>{Math.round(zoom() * 100)}%</span>
                <button style={toolbarButtonStyle(zoom() >= MAX_ZOOM)} disabled={zoom() >= MAX_ZOOM} title={t("pdf.zoomIn")} onClick={() => setZoom((value) => clampZoom(value + ZOOM_STEP))}>+</button>
                <button style={toolbarButtonStyle()} onClick={() => void fitWidth()}>{t("pdf.fitWidth")}</button>
                <button style={toolbarButtonStyle()} title={t("livePreview.openInDefaultApp")} onClick={() => void openInDefaultApp()}>↗</button>
                <button style={toolbarButtonStyle()} title={t("context.showInExplorer")} onClick={() => void revealInFileManager()}>⌕</button>
            </header>

            <div style={{ flex: "1", display: "flex", "min-height": "0", "min-width": "0" }}>
                <div ref={scrollRef} class="mz-pdf-scroll" onMouseUp={handleTextSelection} onScroll={() => { updateContinuousPageNumber(); setSelectionPopup(null); setSelectionTranslation(null); }} style={{ flex: "1", "min-width": "0", "min-height": "0", overflow: "auto", padding: "28px", background: "color-mix(in srgb, var(--mz-bg-tertiary) 80%, #777 20%)" }}>
                    <Show when={!loading() && !error()} fallback={<div style={{ height: "100%", display: "flex", "align-items": "center", "justify-content": "center", color: error() ? "var(--mz-danger, #e06c75)" : "var(--mz-text-muted)", "font-size": "var(--mz-font-size-sm)", "white-space": "pre-wrap", "text-align": "center" }}>{error() ?? t("pdf.loading")}</div>}>
                        <Show when={readingMode() === "continuous"} fallback={
                            <div style={{ width: "max-content", "min-width": "100%", display: "flex", "justify-content": "center", "align-items": "flex-start" }}>
                                <div class="mz-pdf-page-with-cards">
                                    <div class="mz-pdf-page-surface">
                                    <canvas ref={canvasRef} aria-label={t("pdf.pageCanvas", { page: pageNumber() })} style={{ display: "block" }} />
                                    <div ref={textLayerRef} class="mz-pdf-text-layer" aria-label={t("pdf.textLayer")} />
                                    <Show when={activeResult()?.pageNumber === pageNumber()}>
                                        <PdfHighlightOverlay boxes={activeResult()?.boxes ?? []} kind="search" />
                                    </Show>
                                    <Show when={activeEvidence()?.pageNumber === pageNumber()}>
                                        <PdfHighlightOverlay boxes={activeEvidence()?.boxes ?? []} kind="evidence" />
                                    </Show>
                                    <Show when={rendering()}>
                                        <div style={{ position: "absolute", inset: "0", display: "flex", "align-items": "center", "justify-content": "center", background: "rgba(255,255,255,0.55)", color: "#333", "font-size": "13px", "line-height": "1.4" }}>{t("pdf.rendering")}</div>
                                    </Show>
                                    </div>
                                    <Show when={paperAiEnabled() && showCards() && analyses().length > 0}>
                                        <ParagraphCardLane
                                            pageNumber={pageNumber()}
                                            pageHeight={(canvasRef?.getBoundingClientRect().height || estimatedPageSize().height * zoom())}
                                            paragraphs={paragraphs()}
                                            analyses={analyses()}
                                            onEvidenceChange={(boxes) => showEvidence(pageNumber(), boxes)}
                                            onInsertReference={insertReference}
                                        />
                                    </Show>
                                </div>
                            </div>
                        }>
                            <div style={{ width: "max-content", "min-width": "100%", display: "flex", "flex-direction": "column", "align-items": "center", gap: "24px" }}>
                                <For each={Array.from({ length: pageCount() }, (_, index) => index + 1)}>
                                    {(number) => (
                                        <ContinuousPdfPage
                                            pdf={documentProxy()!}
                                            pageNumber={number}
                                            zoom={zoom()}
                                            scrollRoot={() => scrollRef}
                                            activeResult={activeResult()}
                                            estimatedWidth={estimatedPageSize().width}
                                            estimatedHeight={estimatedPageSize().height}
                                            paragraphs={paragraphs()}
                                            analyses={analyses()}
                                            showCards={paperAiEnabled() && showCards() && analyses().length > 0}
                                            evidenceBoxes={activeEvidence()?.pageNumber === number ? activeEvidence()?.boxes ?? [] : []}
                                            onEvidenceChange={showEvidence}
                                            onInsertReference={insertReference}
                                        />
                                    )}
                                </For>
                            </div>
                        </Show>
                    </Show>
                </div>

                <Show when={showSearch()}>
                    <aside style={{ width: "290px", "flex-shrink": "0", display: "flex", "flex-direction": "column", background: "var(--mz-bg-secondary)", "border-left": "1px solid var(--mz-border)", overflow: "hidden" }}>
                        <div style={{ height: "38px", display: "flex", "align-items": "center", padding: "0 10px", "border-bottom": "1px solid var(--mz-border)", color: "var(--mz-text-secondary)", "font-size": "12px" }}>
                            <span style={{ flex: "1" }}>{searching() ? t("pdf.searching") : t("pdf.searchResultCount", { count: searchResults().length })}</span>
                            <button style={{ ...toolbarButtonStyle(), border: "none", background: "transparent" }} onClick={closeSearchResults}>×</button>
                        </div>
                        <div style={{ flex: "1", overflow: "auto", padding: "6px" }}>
                            <Show when={searchResults().length > 0} fallback={<div style={{ padding: "18px 10px", color: "var(--mz-text-muted)", "font-size": "12px", "text-align": "center" }}>{searchQuery().trim() ? t("pdf.noSearchResults") : t("pdf.searchHint")}</div>}>
                                <For each={searchResults()}>
                                    {(result) => <button onClick={() => selectResult(result)} style={{ width: "100%", display: "block", padding: "9px 10px", margin: "0 0 5px", border: activeResult()?.paragraphId === result.paragraphId ? "1px solid var(--mz-accent)" : "1px solid transparent", "border-radius": "var(--mz-radius-sm)", background: activeResult()?.paragraphId === result.paragraphId ? "color-mix(in srgb, var(--mz-accent) 12%, var(--mz-bg-primary))" : "var(--mz-bg-primary)", color: "var(--mz-text-primary)", "text-align": "left", cursor: "pointer" }}>
                                        <span style={{ display: "block", color: "var(--mz-accent)", "font-size": "11px", "font-weight": "600", "margin-bottom": "4px" }}>{t("pdf.pageResult", { page: result.pageNumber })}</span>
                                        <span style={{ display: "-webkit-box", "-webkit-line-clamp": "4", "-webkit-box-orient": "vertical", overflow: "hidden", "font-size": "12px", "line-height": "1.5" }}>{result.snippet}</span>
                                    </button>}
                                </For>
                            </Show>
                        </div>
                    </aside>
                </Show>
                <Show when={showAiChat()}>
                    <PdfAiChatPanel
                        relativePath={props.filePath}
                        title={fileName()}
                        paragraphs={paragraphs()}
                        translationStatus={pretranslationStatus()}
                        translationProgress={pretranslationProgress()}
                        translationError={pretranslationError()}
                        onGenerateCards={startPretranslation}
                        onContextStateChange={setPaperAiEnabled}
                        queuedReference={queuedReference()}
                        onReferenceConsumed={() => setQueuedReference(null)}
                        onClose={() => setShowAiChat(false)}
                    />
                </Show>
            </div>
            <Show when={!showAiChat()}>
                <button
                    class="mz-pdf-ai-edge-button"
                    title="打开 AI 阅读助手"
                    onClick={() => setShowAiChat(true)}
                >
                    <span>AI 阅读</span>
                    <Show when={pretranslationStatus() === "running"}>
                        <small>{Math.round(pretranslationProgress() * 100)}%</small>
                    </Show>
                </button>
            </Show>
            <Show when={selectionPopup()}>
                {(popup) => (
                    <div class="mz-pdf-selection-popup" style={{ left: `${popup().x}px`, top: `${popup().y}px` }}>
                        <div class="mz-pdf-selection-actions">
                            <button disabled={translatingSelection()} onClick={() => void translateSelection()}>{translatingSelection() ? "翻译中…" : "翻译"}</button>
                            <button onClick={() => insertReference({ label: "选中的原文", text: popup().text })}>引用到 AI</button>
                            <button onClick={() => { setSelectionPopup(null); setSelectionTranslation(null); }}>×</button>
                        </div>
                        <Show when={selectionTranslation()}>
                            <div
                                class="mz-pdf-selection-translation"
                                draggable
                                onDragStart={(event) => {
                                    const reference = { label: "悬浮翻译", text: `${popup().text}\n\n译文：${selectionTranslation()}` };
                                    const transfer = event.dataTransfer;
                                    if (!transfer) return;
                                    transfer.setData("application/x-mindzj-paper-reference", JSON.stringify(reference));
                                    transfer.setData("text/plain", reference.text);
                                }}
                            >
                                {selectionTranslation()}
                            </div>
                        </Show>
                    </div>
                )}
            </Show>
        </section>
    );
};
