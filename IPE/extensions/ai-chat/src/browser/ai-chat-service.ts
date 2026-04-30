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
        options: { agentTools?: boolean } = {},
    ): Promise<AbortController> {
        const controller = new AbortController();

        const payload: GemmaProtocol.ChatRequest = {
            messages,
            mode,
            stream: true,
            agent_tools: options.agentTools,
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

    /**
     * Delegate a coding task through PSC's local agent wrapper.
     */
    async runAgentTask(request: GemmaProtocol.AgentTaskRequest): Promise<GemmaProtocol.AgentTaskResponse> {
        const resp = await fetch(`${this._serverUrl}/api/agent/task`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(request),
        });

        if (!resp.ok) {
            const detail = await resp.text();
            throw new Error(`Agent task error: ${resp.status} ${detail}`);
        }

        return await resp.json();
    }

    /**
     * Delegate a coding task and stream the agent's live stdout/stderr.
     */
    async streamAgentTask(
        request: GemmaProtocol.AgentTaskRequest,
        onEvent: (event: GemmaProtocol.AgentTaskEvent) => void,
        signal?: AbortSignal,
    ): Promise<GemmaProtocol.AgentTaskResponse> {
        const resp = await fetch(`${this._serverUrl}/api/agent/task/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(request),
            signal,
        });

        if (!resp.ok) {
            const detail = await resp.text();
            throw new Error(`Agent task error: ${resp.status} ${detail}`);
        }

        const reader = resp.body?.getReader();
        if (!reader) {
            throw new Error('No response body');
        }

        const decoder = new TextDecoder();
        let buffer = '';
        let finalResult: GemmaProtocol.AgentTaskResponse | undefined;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (!data || data === '[DONE]') continue;
                try {
                    const event = JSON.parse(data) as GemmaProtocol.AgentTaskEvent;
                    onEvent(event);
                    if (event.type === 'done' && event.result) {
                        finalResult = event.result;
                    }
                    if (event.type === 'error') {
                        throw new Error(event.error || 'Agent task failed');
                    }
                } catch (error: any) {
                    if (error instanceof SyntaxError) {
                        continue;
                    }
                    throw error;
                }
            }
        }

        if (!finalResult) {
            throw new Error('Agent task ended without a final result');
        }
        return finalResult;
    }

    async steerAgentTask(runId: string, message: string): Promise<{ accepted: boolean; run_id: string }> {
        const resp = await fetch(`${this._serverUrl}/api/agent/steer`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ run_id: runId, message }),
        });
        if (!resp.ok) {
            const detail = await resp.text();
            throw new Error(`Agent steer error: ${resp.status} ${detail}`);
        }
        return await resp.json();
    }

    // ---- Agent file tools ----------------------------------------------

    async readFile(path: string, maxBytes?: number): Promise<GemmaProtocol.ReadFileResult> {
        const resp = await fetch(`${this._serverUrl}/api/fs/read`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path, max_bytes: maxBytes }),
        });
        if (!resp.ok) {
            throw new Error(await this.errorBody(resp, 'read_file'));
        }
        return await resp.json();
    }

    async writeFile(path: string, content: string): Promise<GemmaProtocol.WriteFileResult> {
        const resp = await fetch(`${this._serverUrl}/api/fs/write`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path, content }),
        });
        if (!resp.ok) {
            throw new Error(await this.errorBody(resp, 'write_file'));
        }
        return await resp.json();
    }

    async listDir(path: string = ''): Promise<GemmaProtocol.ListDirResult> {
        const resp = await fetch(`${this._serverUrl}/api/fs/list`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path }),
        });
        if (!resp.ok) {
            throw new Error(await this.errorBody(resp, 'list_dir'));
        }
        return await resp.json();
    }

    private async errorBody(resp: Response, label: string): Promise<string> {
        try {
            const data = await resp.json();
            return `${label} failed (${resp.status}): ${data.detail || resp.statusText}`;
        } catch {
            return `${label} failed (${resp.status}): ${resp.statusText}`;
        }
    }

    /**
     * List Ollama tags already pulled locally.
     */
    async ollamaTags(): Promise<{ models: GemmaProtocol.OllamaTag[]; active: string }> {
        const resp = await fetch(`${this._serverUrl}/api/ollama/tags`);
        if (!resp.ok) {
            throw new Error(`Ollama tags error: ${resp.status}`);
        }
        return await resp.json();
    }

    /**
     * Curated quick-pick library of Ollama tags worth pulling.
     */
    async ollamaLibrary(): Promise<{ models: GemmaProtocol.OllamaLibraryEntry[] }> {
        const resp = await fetch(`${this._serverUrl}/api/ollama/library`);
        if (!resp.ok) {
            throw new Error(`Ollama library error: ${resp.status}`);
        }
        return await resp.json();
    }

    /**
     * Kick off a background `ollama pull <name>`. Poll ollamaPullStatus for progress.
     */
    async ollamaPull(name: string): Promise<{ accepted: boolean; model: string }> {
        const resp = await fetch(`${this._serverUrl}/api/ollama/pull`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
        });
        if (!resp.ok) {
            const text = await resp.text();
            throw new Error(`Pull error: ${resp.status} ${text}`);
        }
        return await resp.json();
    }

    async ollamaPullStatus(): Promise<GemmaProtocol.OllamaPullStatus> {
        const resp = await fetch(`${this._serverUrl}/api/ollama/pull/status`);
        if (!resp.ok) {
            throw new Error(`Pull status error: ${resp.status}`);
        }
        return await resp.json();
    }

    /**
     * Switch the active model. Takes effect on the next /api/chat call —
     * no server restart required.
     */
    async ollamaSelect(name: string): Promise<{ selected: string }> {
        const resp = await fetch(`${this._serverUrl}/api/ollama/select`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
        });
        if (!resp.ok) {
            const text = await resp.text();
            throw new Error(`Select error: ${resp.status} ${text}`);
        }
        return await resp.json();
    }

    dispose(): void {
        this.onStreamChunkEmitter.dispose();
        this.onConnectionChangeEmitter.dispose();
    }
}
