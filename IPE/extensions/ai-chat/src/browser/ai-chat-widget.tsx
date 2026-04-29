/**
 * Gemma Theia IDE — AI Chat Widget
 * ===================================
 * React-based sidebar widget for multi-turn AI conversations.
 * Features streaming responses, code blocks with copy, and context awareness.
 */

import * as React from 'react';
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { Message as TheiaMessage } from '@theia/core/shared/@phosphor/messaging';
import { EditorManager } from '@theia/editor/lib/browser';
import { AiChatService } from './ai-chat-service';
import { GemmaProtocol } from '../common/ai-protocol';

export const AI_CHAT_WIDGET_ID = 'gemma-ai-chat';

interface ChatMessage extends GemmaProtocol.Message {
    id: string;
    isStreaming?: boolean;
}

@injectable()
export class AiChatWidget extends ReactWidget {

    static readonly ID = AI_CHAT_WIDGET_ID;
    static readonly LABEL = 'Gemma AI';

    @inject(AiChatService)
    protected readonly chatService!: AiChatService;

    @inject(EditorManager)
    protected readonly editorManager!: EditorManager;

    private messages: ChatMessage[] = [];
    private inputValue: string = '';
    private isGenerating: boolean = false;
    private abortController: AbortController | null = null;
    private serverStatus: string = 'checking...';
    private messagesEndRef: HTMLDivElement | null = null;

    @postConstruct()
    protected init(): void {
        this.id = AiChatWidget.ID;
        this.title.label = AiChatWidget.LABEL;
        this.title.caption = 'Gemma AI Assistant';
        this.title.iconClass = 'codicon codicon-hubot';
        this.title.closable = true;
        this.addClass('gemma-ai-chat-widget');

        // Check connection on init
        this.checkConnection();
        // Periodic health check
        setInterval(() => this.checkConnection(), 30000);

        this.update();
    }

    private async checkConnection(): Promise<void> {
        const health = await this.chatService.checkHealth();
        this.serverStatus = health ? `${health.model} (${health.backend})` : 'disconnected';
        this.update();
    }

    private generateId(): string {
        return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }

    private async handleSend(): Promise<void> {
        const text = this.inputValue.trim();
        if (!text || this.isGenerating) return;

        // Add user message
        const userMsg: ChatMessage = {
            id: this.generateId(),
            role: 'user',
            content: text,
            timestamp: Date.now(),
        };
        this.messages.push(userMsg);
        this.inputValue = '';
        this.isGenerating = true;

        // Add placeholder for assistant response
        const assistantMsg: ChatMessage = {
            id: this.generateId(),
            role: 'assistant',
            content: '',
            timestamp: Date.now(),
            isStreaming: true,
        };
        this.messages.push(assistantMsg);
        this.update();
        this.scrollToBottom();

        // Build message history for the API. The current user message is
        // wrapped below with IDE context, so keep only earlier conversation.
        const apiMessages: GemmaProtocol.Message[] = this.messages
            .filter(m => !m.isStreaming && m.id !== userMsg.id)
            .map(m => ({ role: m.role, content: m.content }));

        apiMessages.push({
            role: 'user',
            content: this.buildIdeAwarePrompt(text),
        });

        try {
            this.abortController = await this.chatService.streamChat(
                apiMessages,
                'chat',
                (content: string) => {
                    assistantMsg.content += content;
                    this.update();
                    this.scrollToBottom();
                },
                () => {
                    assistantMsg.isStreaming = false;
                    this.isGenerating = false;
                    this.abortController = null;
                    this.update();
                },
                (error: Error) => {
                    assistantMsg.content += `\n\n⚠️ Error: ${error.message}`;
                    assistantMsg.isStreaming = false;
                    this.isGenerating = false;
                    this.abortController = null;
                    this.update();
                },
            );
        } catch (err: any) {
            assistantMsg.content = `⚠️ Failed to connect: ${err.message}`;
            assistantMsg.isStreaming = false;
            this.isGenerating = false;
            this.update();
        }
    }

    private handleStop(): void {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
        this.isGenerating = false;
        const lastMsg = this.messages[this.messages.length - 1];
        if (lastMsg?.isStreaming) {
            lastMsg.isStreaming = false;
            lastMsg.content += '\n\n*(generation stopped)*';
        }
        this.update();
    }

    private handleClear(): void {
        this.messages = [];
        this.update();
    }

    private buildIdeAwarePrompt(userRequest: string): string {
        const editorContext = this.getEditorContext();
        const contextLines = [
            '[Gemma IDE request]',
            'You are running inside Gemma Theia IDE, a VS Code-style coding workspace with an AI chat sidebar, editor integration, inline completion, refactoring, and a terminal agent panel.',
            'Treat the active editor context below as live IDE context, not as a user-authored prompt.',
            `Browser location: ${window.location.href}`,
        ];

        if (!editorContext) {
            return `${contextLines.join('\n')}\n\nUser request:\n${userRequest}`;
        }

        const selectionSummary = editorContext.hasSelection
            ? `Selected range: ${editorContext.selectionRange}`
            : 'Selected range: none; showing the start of the active file';

        return [
            ...contextLines,
            `Active file: ${editorContext.uri}`,
            `Language: ${editorContext.language}`,
            selectionSummary,
            '',
            `Active editor context:\n\`\`\`${editorContext.language}\n${editorContext.code}\n\`\`\``,
            '',
            `User request:\n${userRequest}`,
        ].join('\n');
    }

    private getEditorContext(): { code: string; language: string; uri: string; hasSelection: boolean; selectionRange: string } | null {
        const editor = this.editorManager.currentEditor;
        if (!editor) return null;

        const model = editor.editor.document;
        const selection = editor.editor.selection;
        const language = model.languageId || 'text';
        const uri = model.uri.toString();

        if (selection) {
            const startOffset = model.offsetAt(selection.start);
            const endOffset = model.offsetAt(selection.end);
            if (startOffset !== endOffset) {
                const selectedText = model.getText().substring(startOffset, endOffset);
                const selectionRange = `${selection.start.line + 1}:${selection.start.character + 1}-${selection.end.line + 1}:${selection.end.character + 1}`;
                return { code: selectedText, language, uri, hasSelection: true, selectionRange };
            }
        }

        // If no selection, use the first 160 lines as ambient file context.
        const fullText = model.getText();
        const lines = fullText.split('\n');
        const code = lines.slice(0, 160).join('\n');
        return { code, language, uri, hasSelection: false, selectionRange: 'none' };
    }

    private scrollToBottom(): void {
        if (this.messagesEndRef) {
            this.messagesEndRef.scrollIntoView({ behavior: 'smooth' });
        }
    }

    private copyToClipboard(text: string): void {
        navigator.clipboard.writeText(text).catch(() => {
            // Fallback
            const textarea = document.createElement('textarea');
            textarea.value = text;
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
        });
    }

    private renderCodeBlock(code: string, lang: string, key: string): React.ReactNode {
        return (
            <div key={key} className="gemma-code-block">
                <div className="gemma-code-header">
                    <span className="gemma-code-lang">{lang || 'code'}</span>
                    <button
                        className="gemma-code-copy"
                        onClick={() => this.copyToClipboard(code)}
                        title="Copy code"
                    >
                        Copy
                    </button>
                </div>
                <pre className="gemma-code-content"><code>{code}</code></pre>
            </div>
        );
    }

    private renderMessageContent(content: string): React.ReactNode[] {
        const parts: React.ReactNode[] = [];
        const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
        let lastIndex = 0;
        let match;
        let blockIdx = 0;

        while ((match = codeBlockRegex.exec(content)) !== null) {
            // Text before code block
            if (match.index > lastIndex) {
                parts.push(
                    <span key={`text-${blockIdx}`} className="gemma-text">
                        {content.slice(lastIndex, match.index)}
                    </span>
                );
            }
            parts.push(this.renderCodeBlock(match[2], match[1], `code-${blockIdx}`));
            lastIndex = match.index + match[0].length;
            blockIdx++;
        }

        // Remaining text
        if (lastIndex < content.length) {
            parts.push(
                <span key={`text-end`} className="gemma-text">
                    {content.slice(lastIndex)}
                </span>
            );
        }

        return parts;
    }

    protected render(): React.ReactNode {
        return (
            <div className="gemma-chat-container">
                {/* Header */}
                <div className="gemma-chat-header">
                    <div className="gemma-chat-title">
                        <span className="codicon codicon-hubot" />
                        <span>Gemma AI</span>
                    </div>
                    <div className="gemma-chat-status">
                        <span className={`gemma-status-dot ${this.chatService.isConnected ? 'connected' : 'disconnected'}`} />
                        <span className="gemma-status-text">{this.serverStatus}</span>
                    </div>
                    <button className="gemma-chat-clear" onClick={() => this.handleClear()} title="Clear chat">
                        <span className="codicon codicon-clear-all" />
                    </button>
                </div>

                {/* Messages */}
                <div className="gemma-chat-messages">
                    {this.messages.length === 0 && (
                        <div className="gemma-chat-welcome">
                            <h3>Welcome to Gemma AI</h3>
                            <p>Ask me anything about your code. I can:</p>
                            <ul>
                                <li>Generate and explain code</li>
                                <li>Debug errors and suggest fixes</li>
                                <li>Refactor and optimize code</li>
                                <li>Answer programming questions</li>
                            </ul>
                            <p><em>Tip: Select code in the editor before asking for context-aware help.</em></p>
                        </div>
                    )}
                    {this.messages.map(msg => (
                        <div key={msg.id} className={`gemma-message gemma-message-${msg.role}`}>
                            <div className="gemma-message-avatar">
                                <span className={`codicon ${msg.role === 'user' ? 'codicon-person' : 'codicon-hubot'}`} />
                            </div>
                            <div className="gemma-message-content">
                                {this.renderMessageContent(msg.content)}
                                {msg.isStreaming && <span className="gemma-cursor-blink">▊</span>}
                            </div>
                        </div>
                    ))}
                    <div ref={el => { this.messagesEndRef = el; }} />
                </div>

                {/* Input */}
                <div className="gemma-chat-input-area">
                    <textarea
                        className="gemma-chat-input"
                        value={this.inputValue}
                        placeholder="Ask Gemma..."
                        rows={2}
                        onChange={e => { this.inputValue = (e.target as HTMLTextAreaElement).value; this.update(); }}
                        onKeyDown={e => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                this.handleSend();
                            }
                        }}
                        disabled={this.isGenerating}
                    />
                    <div className="gemma-chat-actions">
                        {this.isGenerating ? (
                            <button className="gemma-btn gemma-btn-stop" onClick={() => this.handleStop()}>
                                <span className="codicon codicon-debug-stop" /> Stop
                            </button>
                        ) : (
                            <button
                                className="gemma-btn gemma-btn-send"
                                onClick={() => this.handleSend()}
                                disabled={!this.inputValue.trim()}
                            >
                                <span className="codicon codicon-send" /> Send
                            </button>
                        )}
                    </div>
                </div>

                {/* Styles (injected) */}
                <style>{`
                    .gemma-chat-container {
                        display: flex;
                        flex-direction: column;
                        height: 100%;
                        background: var(--theia-editor-background);
                        color: var(--theia-foreground);
                        font-family: var(--theia-ui-font-family);
                    }
                    .gemma-chat-header {
                        display: flex;
                        align-items: center;
                        padding: 8px 12px;
                        border-bottom: 1px solid var(--theia-panel-border);
                        gap: 8px;
                    }
                    .gemma-chat-title {
                        display: flex;
                        align-items: center;
                        gap: 6px;
                        font-weight: 600;
                        font-size: 13px;
                    }
                    .gemma-chat-status {
                        display: flex;
                        align-items: center;
                        gap: 4px;
                        margin-left: auto;
                        font-size: 11px;
                        opacity: 0.7;
                    }
                    .gemma-status-dot {
                        width: 6px;
                        height: 6px;
                        border-radius: 50%;
                        background: #888;
                    }
                    .gemma-status-dot.connected { background: #4caf50; }
                    .gemma-status-dot.disconnected { background: #f44336; }
                    .gemma-chat-clear {
                        background: none;
                        border: none;
                        color: var(--theia-foreground);
                        cursor: pointer;
                        padding: 4px;
                        opacity: 0.6;
                    }
                    .gemma-chat-clear:hover { opacity: 1; }
                    .gemma-chat-messages {
                        flex: 1;
                        overflow-y: auto;
                        padding: 12px;
                    }
                    .gemma-chat-welcome {
                        padding: 20px;
                        text-align: center;
                        opacity: 0.7;
                    }
                    .gemma-chat-welcome h3 { margin-bottom: 12px; }
                    .gemma-chat-welcome ul {
                        text-align: left;
                        max-width: 300px;
                        margin: 8px auto;
                    }
                    .gemma-message {
                        display: flex;
                        gap: 8px;
                        margin-bottom: 16px;
                    }
                    .gemma-message-avatar {
                        width: 28px;
                        height: 28px;
                        border-radius: 50%;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        flex-shrink: 0;
                        background: var(--theia-badge-background);
                    }
                    .gemma-message-user .gemma-message-avatar {
                        background: var(--theia-button-background);
                    }
                    .gemma-message-content {
                        flex: 1;
                        font-size: 13px;
                        line-height: 1.5;
                        white-space: pre-wrap;
                        word-break: break-word;
                    }
                    .gemma-code-block {
                        margin: 8px 0;
                        border-radius: 6px;
                        overflow: hidden;
                        border: 1px solid var(--theia-panel-border);
                    }
                    .gemma-code-header {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        padding: 4px 10px;
                        background: var(--theia-titleBar-activeBackground);
                        font-size: 11px;
                    }
                    .gemma-code-copy {
                        background: none;
                        border: 1px solid var(--theia-panel-border);
                        color: var(--theia-foreground);
                        cursor: pointer;
                        padding: 2px 8px;
                        border-radius: 3px;
                        font-size: 11px;
                    }
                    .gemma-code-copy:hover {
                        background: var(--theia-button-background);
                    }
                    .gemma-code-content {
                        padding: 10px;
                        margin: 0;
                        overflow-x: auto;
                        font-family: var(--theia-code-font-family);
                        font-size: 12px;
                        background: var(--theia-editor-background);
                    }
                    .gemma-cursor-blink {
                        animation: blink 0.8s infinite;
                    }
                    @keyframes blink {
                        0%, 50% { opacity: 1; }
                        51%, 100% { opacity: 0; }
                    }
                    .gemma-chat-input-area {
                        padding: 8px 12px;
                        border-top: 1px solid var(--theia-panel-border);
                    }
                    .gemma-chat-input {
                        width: 100%;
                        background: var(--theia-input-background);
                        color: var(--theia-input-foreground);
                        border: 1px solid var(--theia-input-border);
                        border-radius: 4px;
                        padding: 8px;
                        font-family: var(--theia-ui-font-family);
                        font-size: 13px;
                        resize: none;
                        box-sizing: border-box;
                    }
                    .gemma-chat-input:focus {
                        outline: none;
                        border-color: var(--theia-focusBorder);
                    }
                    .gemma-chat-actions {
                        display: flex;
                        justify-content: flex-end;
                        margin-top: 6px;
                    }
                    .gemma-btn {
                        display: flex;
                        align-items: center;
                        gap: 4px;
                        padding: 4px 12px;
                        border: none;
                        border-radius: 4px;
                        cursor: pointer;
                        font-size: 12px;
                    }
                    .gemma-btn-send {
                        background: var(--theia-button-background);
                        color: var(--theia-button-foreground);
                    }
                    .gemma-btn-send:disabled {
                        opacity: 0.5;
                        cursor: default;
                    }
                    .gemma-btn-stop {
                        background: var(--theia-errorBackground);
                        color: var(--theia-errorForeground);
                    }
                `}</style>
            </div>
        );
    }

    protected onAfterAttach(msg: TheiaMessage): void {
        super.onAfterAttach(msg);
        this.update();
    }
}
