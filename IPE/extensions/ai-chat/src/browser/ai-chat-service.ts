/**
 * Gemma Theia IDE — AI Chat Service
 * ====================================
 * Handles communication with the LLM agent server.
 * Supports streaming SSE responses and non-streaming requests.
 */

import { injectable } from '@theia/core/shared/inversify';
import { Emitter, Event } from '@theia/core';
import { GemmaProtocol } from '../common/ai-protocol';

export interface StreamChunk {
    content: string;
    done: boolean;
}

@injectable()
export class AiChatService {

    private _serverUrl: string = GemmaProtocol.LLM_SERVER_URL;
    private _isConnected: boolean = false;

    private readonly onStreamChunkEmitter = new Emitter<StreamChunk>();
    readonly onStreamChunk: Event<StreamChunk> = this.onStreamChunkEmitter.event;

    private readonly onConnectionChangeEmitter = new Emitter<boolean>();
    readonly onConnectionChange: Event<boolean> = this.onConnectionChangeEmitter.event;

    get serverUrl(): string {
        return this._serverUrl;
    }

    set serverUrl(url: string) {
        this._serverUrl = url.replace(/\/$/, '');
    }

    get isConnected(): boolean {
        return this._isConnected;
    }

    /**
     * Check server health and update connection status.
     */
    async checkHealth(): Promise<GemmaProtocol.HealthResponse | null> {
        try {
            const resp = await fetch(`${this._serverUrl}/health`);
            if (resp.ok) {
                const data = await resp.json();
                this._isConnected = true;
                this.onConnectionChangeEmitter.fire(true);
                return data as GemmaProtocol.HealthResponse;
            }
        } catch {
            // Server not available
        }
        this._isConnected = false;
        this.onConnectionChangeEmitter.fire(false);
        return null;
    }

    /**
     * Send a streaming chat request. Returns an AbortController for cancellation.
     */
    async streamChat(
        messages: GemmaProtocol.Message[],
        mode: GemmaProtocol.AgentMode = 'chat',
        onChunk: (content: string) => void,
        onDone: () => void,
        onError: (error: Error) => void,
    ): Promise<AbortController> {
        const controller = new AbortController();

        const payload: GemmaProtocol.ChatRequest = {
            messages,
            mode,
            stream: true,
        };

        try {
            const resp = await fetch(`${this._serverUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal,
            });

            if (!resp.ok) {
                throw new Error(`Server error: ${resp.status} ${resp.statusText}`);
            }

            const reader = resp.body?.getReader();
            if (!reader) {
                throw new Error('No response body');
            }

            const decoder = new TextDecoder();
            let buffer = '';

            const processStream = async () => {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) {
                        onDone();
                        this.onStreamChunkEmitter.fire({ content: '', done: true });
                        break;
                    }

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';

                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            const data = line.slice(6).trim();
                            if (data === '[DONE]') {
                                onDone();
                                this.onStreamChunkEmitter.fire({ content: '', done: true });
                                return;
                            }
                            try {
                                const parsed = JSON.parse(data);
                                if (parsed.content) {
                                    onChunk(parsed.content);
                                    this.onStreamChunkEmitter.fire({ content: parsed.content, done: false });
                                }
                            } catch {
                                // Skip malformed chunks
                            }
                        }
                    }
                }
            };

            processStream().catch(err => {
                if (err.name !== 'AbortError') {
                    onError(err);
                }
            });

        } catch (err: any) {
            if (err.name !== 'AbortError') {
                onError(err);
            }
        }

        return controller;
    }

    /**
     * Request code completion (non-streaming).
     */
    async complete(request: GemmaProtocol.CompletionRequest): Promise<string> {
        const resp = await fetch(`${this._serverUrl}/api/complete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(request),
        });

        if (!resp.ok) {
            throw new Error(`Completion error: ${resp.status}`);
        }

        const data: GemmaProtocol.CompletionResponse = await resp.json();
        return data.completion;
    }

    /**
     * Request code refactoring (non-streaming).
     */
    async refactor(request: GemmaProtocol.RefactorRequest): Promise<string> {
        const resp = await fetch(`${this._serverUrl}/api/refactor`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(request),
        });

        if (!resp.ok) {
            throw new Error(`Refactor error: ${resp.status}`);
        }

        const data = await resp.json();
        return data.code;
    }

    /**
     * Request code explanation (non-streaming).
     */
    async explain(code: string, language: string): Promise<string> {
        const resp = await fetch(`${this._serverUrl}/api/explain`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code, language }),
        });

        if (!resp.ok) {
            throw new Error(`Explain error: ${resp.status}`);
        }

        const data = await resp.json();
        return data.explanation;
    }

    /**
     * Get the currently configured PSC target workspace.
     */
    async workspaceStatus(): Promise<GemmaProtocol.WorkspaceStatus> {
        const resp = await fetch(`${this._serverUrl}/api/workspace`);
        if (!resp.ok) {
            throw new Error(`Workspace status error: ${resp.status}`);
        }
        return await resp.json();
    }

    /**
     * Execute a local command in the PSC target workspace.
     */
    async execute(request: GemmaProtocol.ExecuteRequest): Promise<GemmaProtocol.ExecuteResponse> {
        const resp = await fetch(`${this._serverUrl}/api/execute`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(request),
        });

        if (!resp.ok) {
            const detail = await resp.text();
            throw new Error(`Execution error: ${resp.status} ${detail}`);
        }

        return await resp.json();
    }

    dispose(): void {
        this.onStreamChunkEmitter.dispose();
        this.onConnectionChangeEmitter.dispose();
    }
}
