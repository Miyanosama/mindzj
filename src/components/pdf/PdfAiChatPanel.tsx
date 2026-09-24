import { For, Show, createEffect, createSignal, on, type Component } from "solid-js";
import { aiStore } from "../../stores/ai";
import { buildPaperContext, chatWithPaper } from "../../services/pdf/paperAiService";
import {
    getPaperChatSession,
    savePaperChatSession,
    type PaperChatMessage,
    type PaperReference,
    type PdfParagraphRecord,
} from "../../services/pdf/literatureRepository";
import { enhanceMarkdownPreviewHtml, renderMarkdownPreviewHtml } from "../editor/ReadingView";

function messageId() {
    return crypto.randomUUID();
}

const MarkdownContent: Component<{ content: string; class?: string }> = (props) => {
    let containerRef: HTMLDivElement | undefined;

    createEffect(() => {
        const content = props.content;
        if (!containerRef) return;
        containerRef.innerHTML = renderMarkdownPreviewHtml(content, "", "");
        void enhanceMarkdownPreviewHtml(containerRef);
    });

    return <div ref={containerRef} class={props.class} />;
};

export const PdfAiChatPanel: Component<{
    relativePath: string;
    title: string;
    paragraphs: PdfParagraphRecord[];
    onContextStateChange?: (enabled: boolean) => void;
    onClose: () => void;
    style?: import("solid-js").JSX.CSSProperties;
}> = (props) => {
    let inputRef: HTMLTextAreaElement | undefined;
    let messageListRef: HTMLDivElement | undefined;
    const [messages, setMessages] = createSignal<PaperChatMessage[]>([]);
    const [contextInjected, setContextInjected] = createSignal(false);
    const [references, setReferences] = createSignal<PaperReference[]>([]);
    const [input, setInput] = createSignal("");
    const [loading, setLoading] = createSignal(false);
    const [error, setError] = createSignal<string | null>(null);
    const [dragging, setDragging] = createSignal(false);
    const [sessionLoaded, setSessionLoaded] = createSignal(false);
    const [enabling, setEnabling] = createSignal(false);
    const [inputMode, setInputMode] = createSignal<"edit" | "preview">("edit");

    createEffect(on(() => props.relativePath, (relativePath) => {
        setMessages([]);
        setContextInjected(false);
        setReferences([]);
        setError(null);
        setSessionLoaded(false);
        void getPaperChatSession(relativePath)
            .then((session) => {
                setMessages(session.messages);
                setContextInjected(session.contextInjected);
                props.onContextStateChange?.(session.contextInjected);
                setSessionLoaded(true);
            })
            .catch((reason) => {
                setError(reason instanceof Error ? reason.message : String(reason));
                setSessionLoaded(true);
            });
    }, { defer: false }));

    createEffect(() => {
        messages();
        requestAnimationFrame(() => {
            if (messageListRef) messageListRef.scrollTop = messageListRef.scrollHeight;
        });
    });

    function addReference(reference: PaperReference) {
        setReferences((current) => current.some((entry) =>
            entry.paragraphId === reference.paragraphId && entry.text === reference.text,
        ) ? current : [...current, reference]);
    }

    function handleDrop(event: DragEvent) {
        event.preventDefault();
        setDragging(false);
        const text = event.dataTransfer?.getData("text/plain")?.trim();
        if (text) addReference({ label: "拖拽的原文", text });
    }

    async function persist(next: PaperChatMessage[], injected: boolean) {
        await savePaperChatSession(props.relativePath, next, injected);
    }

    async function send() {
        const question = input().trim();
        const attached = references();
        if ((!question && !attached.length) || loading()) return;
        if (!aiStore.isConfigured()) {
            setError("请先在设置 → 模型接入中配置并测试 AI 模型。");
            return;
        }
        if (!props.paragraphs.length) {
            setError("论文文字尚未识别完成，暂时无法注入全文。");
            return;
        }
        const userContent = question || "请分析我引用的内容。";
        const userMessage: PaperChatMessage = {
            id: messageId(), role: "user", content: userContent, references: attached, createdAt: new Date().toISOString(),
        };
        const history = messages();
        const sessionHistory = history.some((message) => message.role === "system") ? history : [{
            id: `paper-context:${props.relativePath}`,
            role: "system" as const,
            content: buildPaperContext(props.title, props.paragraphs),
            references: [],
            createdAt: new Date().toISOString(),
        }, ...history];
        const assistantMessage: PaperChatMessage = {
            id: messageId(), role: "assistant", content: "", references: [], createdAt: new Date().toISOString(),
        };
        const withUser = [...sessionHistory, userMessage];
        setMessages([...withUser, assistantMessage]);
        setInput("");
        setReferences([]);
        setLoading(true);
        setError(null);
        setContextInjected(true);
        props.onContextStateChange?.(true);
        try {
            await persist(withUser, true);
            const answer = await chatWithPaper(props.title, props.paragraphs, sessionHistory, userContent, attached, (_chunk, fullMessage) => {
                setMessages((current) => current.map((message) => message.id === assistantMessage.id ? { ...message, content: fullMessage } : message));
            });
            const completed = [...withUser, { ...assistantMessage, content: answer }];
            setMessages(completed);
            await persist(completed, true);
        } catch (reason) {
            setMessages(withUser);
            setError(reason instanceof Error ? reason.message : String(reason));
        } finally {
            setLoading(false);
        }
    }

    async function clearChat() {
        setMessages([]);
        setReferences([]);
        setError(null);
        await persist([], contextInjected()).catch((reason) => setError(String(reason)));
    }

    async function enablePaperAi() {
        if (enabling()) return;
        if (!aiStore.isConfigured()) {
            setError("请先在设置 → 模型接入中配置并测试 AI 模型。");
            return;
        }
        setEnabling(true);
        setError(null);
        try {
            await persist(messages(), true);
            setContextInjected(true);
            props.onContextStateChange?.(true);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        } finally {
            setEnabling(false);
        }
    }

    return (
        <aside class="mz-pdf-ai-chat" style={props.style} classList={{ "is-dragging": dragging() }} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }} onDrop={handleDrop}>
            <header class="mz-pdf-ai-chat-header">
                <div><strong>论文 AI</strong><small>{aiStore.currentModelLabel() || "未配置模型"}</small></div>
                <button title="清空对话" onClick={() => void clearChat()}>清空</button>
                <button title="关闭" onClick={props.onClose}>×</button>
            </header>
            <Show when={sessionLoaded()} fallback={<div class="mz-pdf-ai-consent"><p>正在加载论文 AI 会话…</p></div>}>
                <Show when={contextInjected()} fallback={
                    <div class="mz-pdf-ai-consent">
                        <div class="mz-pdf-ai-consent-icon">AI</div>
                        <strong>是否启用「{aiStore.currentModelLabel() || "未配置模型"}」？</strong>
                        <p>启用后会像 Vibero 一样，在首次提问时把已识别的论文全文加入当前会话，后续对话沿用会话历史。</p>
                        <p class="mz-pdf-ai-consent-note">启用本身不会调用模型；发送问题时论文正文会发送给当前配置的模型服务商。</p>
                        <div><button onClick={props.onClose}>暂不启用</button><button disabled={enabling()} onClick={() => void enablePaperAi()}>{enabling() ? "正在启用…" : "启用"}</button></div>
                        <Show when={error()}><div class="mz-pdf-ai-error">{error()}</div></Show>
                    </div>
                }>
                    <div class="mz-pdf-ai-background-status"><span>{messages().length ? "论文全文会话已启用" : "首次提问时注入全文"}</span></div>
                    <div ref={messageListRef} class="mz-pdf-ai-messages">
                        <Show when={messages().some((message) => message.role !== "system")} fallback={<div class="mz-pdf-ai-empty"><strong>基于论文全文提问</strong><p>首次发送时会注入已识别的全文，共 {props.paragraphs.length} 个段落。</p><p>也可以把选中的原文拖到这里作为问题上下文。</p></div>}>
                            <For each={messages()}>{(message) => <Show when={message.role !== "system"}><article class={`mz-pdf-ai-message is-${message.role}`}><div class="mz-pdf-ai-message-role">{message.role === "user" ? "你" : "AI"}</div><MarkdownContent content={message.content || (loading() && message.role === "assistant" ? "正在思考…" : "")} class="mz-pdf-ai-message-content mz-pdf-ai-markdown" /><For each={message.references}>{(reference) => <blockquote title={reference.text}>{reference.label}</blockquote>}</For></article></Show>}</For>
                        </Show>
                    </div>
                    <Show when={error()}><div class="mz-pdf-ai-error">{error()}</div></Show>
                    <div class="mz-pdf-ai-composer">
                        <Show when={references().length}><div class="mz-pdf-ai-references"><For each={references()}>{(reference, index) => <button title={reference.text} onClick={() => setReferences((items) => items.filter((_, itemIndex) => itemIndex !== index()))}>@{reference.label} ×</button>}</For></div></Show>
                        <div class="mz-pdf-ai-composer-toolbar"><span>Markdown</span><div class="mz-pdf-ai-mode-switch" role="tablist" aria-label="Markdown 编辑模式"><button type="button" classList={{ "is-active": inputMode() === "edit" }} onClick={() => setInputMode("edit")}>编辑</button><button type="button" classList={{ "is-active": inputMode() === "preview" }} onClick={() => setInputMode("preview")}>预览</button></div></div>
                        <Show when={inputMode() === "edit"} fallback={<div class="mz-pdf-ai-input-preview"><Show when={input().trim()} fallback={<span class="mz-pdf-ai-input-placeholder">输入 Markdown 后在这里预览</span>}><MarkdownContent content={input()} class="mz-pdf-ai-markdown" /></Show></div>}>
                            <textarea ref={inputRef} value={input()} placeholder="询问这篇论文…" onInput={(event) => setInput(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} />
                        </Show>
                        <div class="mz-pdf-ai-composer-footer"><span>{contextInjected() ? "全文上下文已启用；回答将流式显示" : "首次对话将注入全文"}</span><button disabled={loading()} onClick={() => void send()}>发送</button></div>
                    </div>
                    <Show when={dragging()}><div class="mz-pdf-ai-drop-mask">松开以引用到对话</div></Show>
                </Show>
            </Show>
        </aside>
    );
};
