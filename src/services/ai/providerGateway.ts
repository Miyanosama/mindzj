import { Channel, invoke } from "@tauri-apps/api/core";

/**
 * Transport boundary for AI providers.
 *
 * Provider-specific request shaping remains in the AI domain for now, while
 * every network call crosses this interface. PDF chat can therefore add
 * provider capabilities and document-upload strategies without coupling UI
 * components to Tauri command names.
 */
export interface AiProviderGateway {
    postJson<T>(
        url: string,
        headers: Record<string, string>,
        body: unknown,
    ): Promise<T>;
    getJson<T>(url: string, headers: Record<string, string>): Promise<T>;
    transcribe<T>(request: {
        url: string;
        headers: Record<string, string>;
        fileName: string;
        mimeType: string;
        base64Data: string;
    }): Promise<T>;
    textToSpeech<T>(request: {
        url: string;
        headers: Record<string, string>;
        body: unknown;
        outputDir: string | null;
        fileName: string;
    }): Promise<T>;
    streamJson<T>(
        url: string,
        headers: Record<string, string>,
        body: unknown,
        onChunk: (chunk: T) => void,
    ): Promise<void>;
}

class TauriAiProviderGateway implements AiProviderGateway {
    postJson<T>(url: string, headers: Record<string, string>, body: unknown) {
        return invoke<T>("ai_chat_completion", {
            request: { url, headers, body },
        });
    }

    getJson<T>(url: string, headers: Record<string, string>) {
        return invoke<T>("ai_get_json", { request: { url, headers } });
    }

    transcribe<T>(request: {
        url: string;
        headers: Record<string, string>;
        fileName: string;
        mimeType: string;
        base64Data: string;
    }) {
        return invoke<T>("ai_transcribe_audio", { request });
    }

    textToSpeech<T>(request: {
        url: string;
        headers: Record<string, string>;
        body: unknown;
        outputDir: string | null;
        fileName: string;
    }) {
        return invoke<T>("ai_text_to_speech", { request });
    }

    streamJson<T>(
        url: string,
        headers: Record<string, string>,
        body: unknown,
        onChunk: (chunk: T) => void,
    ) {
        const channel = new Channel<T>(onChunk);
        return invoke<void>("ai_chat_completion_stream", {
            request: { url, headers, body },
            onEvent: channel,
        });
    }
}

export const aiProviderGateway: AiProviderGateway = new TauriAiProviderGateway();
