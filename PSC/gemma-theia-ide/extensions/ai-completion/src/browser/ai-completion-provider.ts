/**
 * Gemma Theia IDE — AI Code Completion Provider
 * =================================================
 * Provides inline "ghost text" completions by querying the Gemma 4 model.
 * Debounces keystrokes, fetches completions, and displays them as inline suggestions.
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import { Emitter, Event, Disposable, DisposableCollection } from '@theia/core';
import { EditorManager, TextEditor } from '@theia/editor/lib/browser';
import { AiChatService } from 'gemma-ai-chat/lib/browser/ai-chat-service';

export interface InlineCompletion {
    text: string;
    range: {
        startLine: number;
        startColumn: number;
        endLine: number;
        endColumn: number;
    };
}

@injectable()
export class AiCompletionProvider implements Disposable {

    @inject(AiChatService)
    protected readonly chatService: AiChatService;

    @inject(EditorManager)
    protected readonly editorManager: EditorManager;

    private readonly disposables = new DisposableCollection();
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;
    private currentCompletion: InlineCompletion | null = null;
    private enabled: boolean = true;

    /** Debounce delay in ms */
    private debounceMs: number = 500;

    private readonly onCompletionEmitter = new Emitter<InlineCompletion | null>();
    readonly onCompletion: Event<InlineCompletion | null> = this.onCompletionEmitter.event;

    private readonly onLoadingEmitter = new Emitter<boolean>();
    readonly onLoading: Event<boolean> = this.onLoadingEmitter.event;

    get isEnabled(): boolean {
        return this.enabled;
    }

    toggle(): void {
        this.enabled = !this.enabled;
        if (!this.enabled) {
            this.clearCompletion();
        }
    }

    /**
     * Trigger a completion request for the current cursor position.
     */
    async triggerCompletion(editor?: TextEditor): Promise<void> {
        if (!this.enabled || !this.chatService.isConnected) {
            return;
        }

        const currentEditor = editor || this.editorManager.currentEditor?.editor;
        if (!currentEditor) {
            return;
        }

        const document = currentEditor.document;
        const cursor = currentEditor.cursor;
        const fullText = document.getText();
        const offset = document.offsetAt(cursor);

        // Get prefix (text before cursor) and suffix (text after cursor)
        const prefix = fullText.substring(Math.max(0, offset - 2000), offset);
        const suffix = fullText.substring(offset, Math.min(fullText.length, offset + 500));
        const language = document.languageId || '';

        // Don't trigger if prefix is too short
        if (prefix.trim().length < 3) {
            return;
        }

        this.onLoadingEmitter.fire(true);

        try {
            const completion = await this.chatService.complete({
                prefix,
                suffix,
                language,
                max_tokens: 256,
                temperature: 0.2,
            });

            if (completion && completion.trim()) {
                this.currentCompletion = {
                    text: completion,
                    range: {
                        startLine: cursor.line,
                        startColumn: cursor.character,
                        endLine: cursor.line,
                        endColumn: cursor.character,
                    },
                };
                this.onCompletionEmitter.fire(this.currentCompletion);
            } else {
                this.clearCompletion();
            }
        } catch (err) {
            console.warn('[Gemma Completion] Request failed:', err);
            this.clearCompletion();
        } finally {
            this.onLoadingEmitter.fire(false);
        }
    }

    /**
     * Schedule a debounced completion trigger.
     */
    scheduleCompletion(editor?: TextEditor): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => {
            this.triggerCompletion(editor);
        }, this.debounceMs);
    }

    /**
     * Accept the current inline completion.
     */
    acceptCompletion(): InlineCompletion | null {
        const completion = this.currentCompletion;
        this.currentCompletion = null;
        this.onCompletionEmitter.fire(null);
        return completion;
    }

    /**
     * Dismiss the current inline completion.
     */
    clearCompletion(): void {
        this.currentCompletion = null;
        this.onCompletionEmitter.fire(null);
    }

    dispose(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.disposables.dispose();
        this.onCompletionEmitter.dispose();
        this.onLoadingEmitter.dispose();
    }
}
