/**
 * Gemma Theia IDE — AI Chat Widget
 * ===================================
 * React-based sidebar widget for multi-turn AI conversations.
 * Features streaming responses, code blocks with copy, context awareness,
 * a markdown Preview tab, "Save as Markdown" action, and a footer terminal toggle.
 */

import * as React from 'react';
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { Message as TheiaMessage } from '@theia/core/shared/@phosphor/messaging';
import { CommandService } from '@theia/core/lib/common/command';
import { MessageService } from '@theia/core/lib/common/message-service';
import { EditorManager } from '@theia/editor/lib/browser';
import { OpenerService, open } from '@theia/core/lib/browser/opener-service';
import URI from '@theia/core/lib/common/uri';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { BinaryBuffer } from '@theia/core/lib/common/buffer';
import { TerminalCommands } from '@theia/terminal/lib/browser/terminal-frontend-contribution';
import { AiChatService } from './ai-chat-service';
import { GemmaProtocol } from '../common/ai-protocol';

export const AI_CHAT_WIDGET_ID = 'gemma-ai-chat';

interface ChatMessage extends GemmaProtocol.Message {
    id: string;
    isStreaming?: boolean;
    /** Ephemeral agent heartbeat, rendered in place so repeated status events do not spam chat. */
    agentWorkingText?: string;
    /** Synthetic tool-result messages — rendered as a card, not as user text. */
    toolResult?: GemmaProtocol.AgentToolResult;
    /** Tool call extracted from this assistant message — rendered as a card. */
    toolCall?: GemmaProtocol.AgentToolCall;
    /** Reason the tool was rejected (only set when toolResult.ok=false from user denial). */
    toolDenied?: boolean;
}

type ChatTab = 'chat' | 'preview';

type ChatMode = 'code' | 'debug';

type AgentRoute = 'hermes' | 'ra-aid' | 'aider';

/**
 * Footer mode → Ollama tag mapping. Clicking a mode in the footer swaps the
 * active model on the server. The active mode is inferred from the currently
 * selected model, so reloads stay consistent without extra persistence.
 */
const MODE_MODELS: Record<ChatMode, string> = {
    code: 'qwen2.5-coder:7b',
    debug: 'llama3.2:3b',
};

const MODE_LABELS: Record<ChatMode, { label: string; icon: string; title: string }> = {
    code: { label: 'Code', icon: 'codicon-code', title: `Coding mode — ${MODE_MODELS.code}` },
    debug: { label: 'Debug', icon: 'codicon-bug', title: `Debugging mode — ${MODE_MODELS.debug}` },
};

interface PendingConfirm {
    call: GemmaProtocol.AgentToolCall;
    /** For write_file: existing file content (if any) for diff display. */
    existing?: string;
    resolve: (approved: boolean) => void;
}

const MAX_TOOL_ITERATIONS = 12;

@injectable()
export class AiChatWidget extends ReactWidget {

    static readonly ID = AI_CHAT_WIDGET_ID;
    static readonly LABEL = 'PARK Systems Coder';

    @inject(AiChatService)
    protected readonly chatService!: AiChatService;

    @inject(EditorManager)
    protected readonly editorManager!: EditorManager;

    @inject(CommandService)
    protected readonly commandService!: CommandService;

    @inject(MessageService)
    protected readonly messageService!: MessageService;

    @inject(WorkspaceService)
    protected readonly workspaceService!: WorkspaceService;

    @inject(FileService)
    protected readonly fileService!: FileService;

    @inject(OpenerService)
    protected readonly openerService!: OpenerService;

    private messages: ChatMessage[] = [];
    private inputValue: string = '';
    private isGenerating: boolean = false;
    private abortController: AbortController | null = null;
    private serverStatus: string = 'checking...';
    private messagesEndRef: HTMLDivElement | null = null;
    private activeTab: ChatTab = 'chat';

    // Agent-mode state
    private agentMode: boolean = true;
    private agentRoute: AgentRoute = 'hermes';
    private pendingConfirm: PendingConfirm | null = null;

    // Model picker state
    private modelPickerOpen: boolean = false;
    private modelTags: GemmaProtocol.OllamaTag[] = [];
    private modelLibrary: GemmaProtocol.OllamaLibraryEntry[] = [];
    private modelActive: string = '';
    private modelTagsLoading: boolean = false;
    private modelTagsError: string | null = null;
    private pullStatus: GemmaProtocol.OllamaPullStatus | null = null;
    private pullPollHandle: number | null = null;
    private customPullInput: string = '';

    @postConstruct()
    protected init(): void {
        this.id = AiChatWidget.ID;
        this.title.label = AiChatWidget.LABEL;
        this.title.caption = 'Lila Agent local coding manager';
        this.title.iconClass = 'codicon codicon-circuit-board';
        this.title.closable = true;
        this.addClass('gemma-ai-chat-widget');

        this.checkConnection();
        setInterval(() => this.checkConnection(), 30000);

        this.update();
    }

    private async checkConnection(): Promise<void> {
        const health = await this.chatService.checkHealth();
        if (health) {
            this.serverStatus = `${health.model} (${health.backend})`;
            this.modelActive = health.model;
        } else {
            this.serverStatus = 'disconnected';
        }
        this.update();
    }

    /** Mode currently in effect, inferred from the active model. */
    private get currentMode(): ChatMode | null {
        for (const mode of Object.keys(MODE_MODELS) as ChatMode[]) {
            if (MODE_MODELS[mode] === this.modelActive) return mode;
        }
        return null;
    }

    /** Switch active model to the one mapped to `mode`. No-op if already active. */
    private async setMode(mode: ChatMode): Promise<void> {
        const target = MODE_MODELS[mode];
        if (target === this.modelActive) return;
        await this.selectModel(target);
    }

    private generateId(): string {
        return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }

    private stopRequested: boolean = false;

    private async handleSend(): Promise<void> {
        const text = this.inputValue.trim();
        if (!text || this.isGenerating) return;

        const userMsg: ChatMessage = {
            id: this.generateId(),
            role: 'user',
            content: text,
            timestamp: Date.now(),
        };
        this.messages.push(userMsg);
        this.inputValue = '';
        this.isGenerating = true;
        this.stopRequested = false;
        this.update();
        this.scrollToBottom();

        try {
            if (this.agentMode) {
                if (text.toLowerCase().startsWith('/local ')) {
                    userMsg.content = text.slice('/local '.length).trim();
                    await this.runAgentLoop(userMsg);
                } else {
                    const handled = await this.runDirectAgentAction(userMsg);
                    if (!handled) {
                        await this.runExternalAgentTask(userMsg);
                    }
                }
            } else {
                await this.runSingleShotChat(userMsg);
            }
        } finally {
            this.isGenerating = false;
            this.abortController = null;
            this.update();
        }
    }

    private async runShortcutCommand(label: string, command: string, timeout: number = 600): Promise<void> {
        if (this.isGenerating) return;

        const userMsg: ChatMessage = {
            id: this.generateId(),
            role: 'user',
            content: label,
            timestamp: Date.now(),
        };
        const call: GemmaProtocol.AgentToolCall = {
            name: 'run_command',
            args: { command, timeout },
        };
        const assistantMsg: ChatMessage = {
            id: this.generateId(),
            role: 'assistant',
            content: '',
            timestamp: Date.now(),
            toolCall: call,
        };

        this.messages.push(userMsg, assistantMsg);
        this.isGenerating = true;
        this.update();
        this.scrollToBottom();

        try {
            const result = await this.executeTool(call);
            this.messages.push({
                id: this.generateId(),
                role: 'user',
                content: `${GemmaProtocol.TOOL_RESULT_OPEN}\n${JSON.stringify({ name: call.name, ...result })}\n${GemmaProtocol.TOOL_CALL_CLOSE}`,
                timestamp: Date.now(),
                toolResult: { name: call.name, ...result },
                toolDenied: result.ok === false && result.error === 'user denied',
            });
            this.messages.push({
                id: this.generateId(),
                role: 'assistant',
                content: this.summarizeDirectToolResult(call, result),
                timestamp: Date.now(),
            });
        } finally {
            this.isGenerating = false;
            this.update();
            this.scrollToBottom();
        }
    }

    private handleStop(): void {
        this.stopRequested = true;
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
        // If a confirmation modal is up, treat Stop as "deny".
        if (this.pendingConfirm) {
            const { resolve } = this.pendingConfirm;
            this.pendingConfirm = null;
            resolve(false);
        }
        this.isGenerating = false;
        const lastMsg = this.messages[this.messages.length - 1];
        if (lastMsg?.isStreaming) {
            lastMsg.isStreaming = false;
            lastMsg.content += '\n\n*(generation stopped)*';
        }
        this.update();
    }

    // ---- Agent loop -------------------------------------------------------

    private async runDirectAgentAction(userMsg: ChatMessage): Promise<boolean> {
        const directCall = this.detectDirectToolCall(userMsg.content);
        if (!directCall) return false;

        const assistantMsg: ChatMessage = {
            id: this.generateId(),
            role: 'assistant',
            content: '',
            timestamp: Date.now(),
            toolCall: directCall,
        };
        this.messages.push(assistantMsg);
        this.update();
        this.scrollToBottom();

        const result = await this.executeTool(directCall);
        const resultMsg: ChatMessage = {
            id: this.generateId(),
            role: 'user',
            content: `${GemmaProtocol.TOOL_RESULT_OPEN}\n${JSON.stringify({ name: directCall.name, ...result })}\n${GemmaProtocol.TOOL_CALL_CLOSE}`,
            timestamp: Date.now(),
            toolResult: { name: directCall.name, ...result },
            toolDenied: result.ok === false && result.error === 'user denied',
        };
        this.messages.push(resultMsg);

        const summary = this.summarizeDirectToolResult(directCall, result);
        this.messages.push({
            id: this.generateId(),
            role: 'assistant',
            content: summary,
            timestamp: Date.now(),
        });
        this.update();
        this.scrollToBottom();
        return true;
    }

    private detectDirectToolCall(text: string): GemmaProtocol.AgentToolCall | null {
        const normalized = text.toLowerCase();
        const asksPull = /\b(pull|update|sync)\b/.test(normalized);
        const mentionsGit = /\b(git|github|repo|repository|remote|origin)\b/.test(normalized);
        if (asksPull && mentionsGit) {
            return { name: 'run_command', args: { command: 'git pull --ff-only' } };
        }
        return null;
    }

    private async runExternalAgentTask(userMsg: ChatMessage): Promise<void> {
        const content = userMsg.content;
        const engine =
            this.agentRoute === 'aider' || (/\baider\b/i.test(content) && !/\bra[\.\- ]?aid\b/i.test(content)) ? 'aider' :
            this.agentRoute === 'ra-aid' || /\bra[\.\- ]?aid\b/i.test(content) ? 'ra-aid' :
            'hermes';
        const call: GemmaProtocol.AgentToolCall = {
            name: engine === 'aider' ? 'aider_task' : (engine === 'ra-aid' ? 'ra_aid_task' : 'hermes_task'),
            args: {
                task: userMsg.content,
                engine,
                use_aider: engine === 'ra-aid',
                timeout: 1800,
            },
        };

        const assistantMsg: ChatMessage = {
            id: this.generateId(),
            role: 'assistant',
            content: '',
            timestamp: Date.now(),
            toolCall: call,
        };
        this.messages.push(assistantMsg);
        this.update();
        this.scrollToBottom();

        const result = await this.runAgentTask(call, assistantMsg);

        this.messages.push({
            id: this.generateId(),
            role: 'user',
            content: `${GemmaProtocol.TOOL_RESULT_OPEN}\n${JSON.stringify({ name: call.name, ...result })}\n${GemmaProtocol.TOOL_CALL_CLOSE}`,
            timestamp: Date.now(),
            toolResult: { name: call.name, ...result },
            toolDenied: result.ok === false && result.error === 'user denied',
        });

        this.messages.push({
            id: this.generateId(),
            role: 'assistant',
            content: this.summarizeAgentTaskResult(call, result),
            timestamp: Date.now(),
        });
        this.update();
        this.scrollToBottom();
    }

    private async runAgentTask(call: GemmaProtocol.AgentToolCall, liveMsg?: ChatMessage): Promise<{ ok: boolean; result?: any; error?: string }> {
        try {
            if (liveMsg) {
                liveMsg.content = 'Starting agent task...\n\n';
                this.update();
                this.scrollToBottom();
            }
            this.abortController = new AbortController();
            const data = await this.chatService.streamAgentTask({
                task: call.args.task,
                engine: call.args.engine,
                timeout: call.args.timeout,
                use_aider: call.args.use_aider,
            }, event => {
                if (!liveMsg) return;
                this.appendAgentActivity(liveMsg, event);
            }, this.abortController.signal);
            return { ok: true, result: data };
        } catch (err: any) {
            if (err?.name === 'AbortError') {
                if (liveMsg) {
                    liveMsg.agentWorkingText = undefined;
                    liveMsg.content += `${liveMsg.content.endsWith('\n') ? '' : '\n'}[stopped] Agent task stopped by user.\n`;
                    this.update();
                    this.scrollToBottom();
                }
                return { ok: false, error: 'stopped by user' };
            }
            return { ok: false, error: err?.message || String(err) };
        }
    }

    private appendAgentActivity(msg: ChatMessage, event: GemmaProtocol.AgentTaskEvent): void {
        let line = '';
        if (event.type === 'status' && event.message) {
            const workingMatch = event.message.match(/^(.+?)\s+is still working\.{3}$/i);
            if (workingMatch) {
                msg.agentWorkingText = `${workingMatch[1]} is working`;
                this.update();
                this.scrollToBottom();
                return;
            }
            line = `[status] ${event.message}`;
            if (event.command) {
                line += `\n[command] ${event.command}`;
            }
        } else if (event.type === 'log' && event.text) {
            msg.agentWorkingText = undefined;
            const prefix = event.stream === 'stderr' ? '[stderr]' : '[stdout]';
            line = `${prefix} ${event.text.replace(/\s+$/g, '')}`;
        } else if (event.type === 'done' && event.result) {
            msg.agentWorkingText = undefined;
            line = `[done] ${event.result.engine} exited with code ${event.result.exit_code}${event.result.timed_out ? ' (timed out)' : ''}`;
        } else if (event.type === 'error') {
            msg.agentWorkingText = undefined;
            line = `[error] ${event.error || 'Agent task failed'}`;
        }
        if (!line) return;

        const next = `${msg.content}${msg.content.endsWith('\n') ? '' : '\n'}${line}\n`;
        msg.content = next.length > 12000
            ? `... earlier agent activity trimmed ...\n${next.slice(-11000)}`
            : next;
        this.update();
        this.scrollToBottom();
    }

    private summarizeAgentTaskResult(call: GemmaProtocol.AgentToolCall, result: { ok: boolean; result?: any; error?: string }): string {
        if (!result.ok) {
            return `Agent task was not run: ${result.error || 'unknown error'}.`;
        }
        const data = result.result as GemmaProtocol.AgentTaskResponse;
        const output = [data.stdout, data.stderr].filter(Boolean).join('\n').trim();
        const details = output ? `\n\n\`\`\`text\n${output.slice(0, 5000)}\n\`\`\`` : '';
        const label =
            data.engine === 'hermes' ? 'Lila Agent' :
            call.name === 'aider_task' ? 'aider' :
            call.name === 'hermes_task' ? `Lila Agent -> ${data.engine}` :
            'RA.Aid + aider';
        return `${label} finished with exit code ${data.exit_code}.${details}`;
    }

    private summarizeDirectToolResult(call: GemmaProtocol.AgentToolCall, result: { ok: boolean; result?: any; error?: string }): string {
        if (!result.ok) {
            return `Command was not run: ${result.error || 'unknown error'}.`;
        }
        if (call.name === 'run_command') {
            const data = result.result as GemmaProtocol.ExecuteResponse;
            const output = [data.stdout, data.stderr].filter(Boolean).join('\n').trim();
            const details = output ? `\n\n\`\`\`text\n${output.slice(0, 4000)}\n\`\`\`` : '';
            return `Command finished with exit code ${data.exit_code}.${details}`;
        }
        return 'Done.';
    }

    private async runSingleShotChat(userMsg: ChatMessage): Promise<void> {
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

        const apiMessages: GemmaProtocol.Message[] = this.messages
            .filter(m => !m.isStreaming && m.id !== userMsg.id)
            .map(m => ({ role: m.role, content: m.content }));

        apiMessages.push({
            role: 'user',
            content: this.buildIdeAwarePrompt(userMsg.content),
        });

        await new Promise<void>((resolve) => {
            this.chatService.streamChat(
                apiMessages,
                'chat',
                (content: string) => {
                    assistantMsg.content += content;
                    this.update();
                    this.scrollToBottom();
                },
                () => { assistantMsg.isStreaming = false; this.update(); resolve(); },
                (err: Error) => {
                    if (err.name !== 'AbortError') {
                        assistantMsg.content += `\n\n⚠️ Error: ${err.message}`;
                    }
                    assistantMsg.isStreaming = false;
                    this.update();
                    resolve();
                },
            ).then(controller => { this.abortController = controller; })
              .catch(err => { assistantMsg.content = `⚠️ Failed to connect: ${err.message}`; assistantMsg.isStreaming = false; this.update(); resolve(); });
        });
    }

    private async runAgentLoop(userMsg: ChatMessage): Promise<void> {
        for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
            if (this.stopRequested) return;

            const call = await this.runStreamingExchange(userMsg, iter === 0);
            if (this.stopRequested) return;
            if (!call) return; // Model finished without a tool call.

            const result = await this.executeTool(call);
            if (this.stopRequested) return;

            const resultMsg: ChatMessage = {
                id: this.generateId(),
                role: 'user',
                content: `${GemmaProtocol.TOOL_RESULT_OPEN}\n${JSON.stringify({ name: call.name, ...result })}\n${GemmaProtocol.TOOL_CALL_CLOSE}`,
                timestamp: Date.now(),
                toolResult: { name: call.name, ...result },
                toolDenied: result.ok === false && result.error === 'user denied',
            };
            this.messages.push(resultMsg);
            this.update();
            this.scrollToBottom();
        }

        this.messages.push({
            id: this.generateId(),
            role: 'assistant',
            content: `⚠️ Stopped after ${MAX_TOOL_ITERATIONS} tool calls. Reply to continue.`,
            timestamp: Date.now(),
        });
        this.update();
    }

    /**
     * Run one streaming request. If the assistant produces a complete <<TOOL>>...<<END>>
     * block we abort the stream early, store the parsed call on the assistant message,
     * and return it. If the stream ends without a tool block, return null.
     */
    private async runStreamingExchange(userMsg: ChatMessage, isFirstIteration: boolean): Promise<GemmaProtocol.AgentToolCall | null> {
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

        const apiMessages = this.buildAgentApiMessages(userMsg, isFirstIteration, assistantMsg.id);

        let detectedCall: GemmaProtocol.AgentToolCall | null = null;
        let aborted = false;

        await new Promise<void>((resolve) => {
            const finalize = () => {
                assistantMsg.isStreaming = false;
                this.update();
                resolve();
            };

            this.chatService.streamChat(
                apiMessages,
                'chat',
                (chunk: string) => {
                    if (detectedCall) return; // Ignore late chunks after we've stopped.
                    assistantMsg.content += chunk;

                    const detected = this.detectToolBlock(assistantMsg.content);
                    if (detected) {
                        detectedCall = detected.call;
                        assistantMsg.toolCall = detected.call;
                        assistantMsg.content = detected.preText; // Hide the raw tool block from the rendered text.
                        aborted = true;
                        if (this.abortController) {
                            this.abortController.abort();
                            this.abortController = null;
                        }
                        finalize();
                        return;
                    }
                    this.update();
                    this.scrollToBottom();
                },
                finalize,
                (err: Error) => {
                    if (aborted || err.name === 'AbortError') {
                        // Expected when we abort to capture the tool block.
                        finalize();
                        return;
                    }
                    assistantMsg.content += `\n\n⚠️ Error: ${err.message}`;
                    finalize();
                },
                { agentTools: true },
            ).then(controller => {
                if (aborted) {
                    // Tool block already detected and the stream aborted between scheduling and resolution.
                    controller.abort();
                } else {
                    this.abortController = controller;
                }
            }).catch(err => {
                assistantMsg.content = `⚠️ Failed to connect: ${err.message}`;
                finalize();
            });
        });

        return detectedCall;
    }

    private detectToolBlock(content: string): { call: GemmaProtocol.AgentToolCall; preText: string } | null {
        const open = GemmaProtocol.TOOL_CALL_OPEN;
        const close = GemmaProtocol.TOOL_CALL_CLOSE;
        const openIdx = content.indexOf(open);
        if (openIdx < 0) return null;
        const closeIdx = content.indexOf(close, openIdx + open.length);
        if (closeIdx < 0) return null;

        const block = content.slice(openIdx + open.length, closeIdx).trim();
        // Strip optional ```json fences the model sometimes adds inside the markers.
        const cleaned = block.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
        try {
            const parsed = JSON.parse(cleaned);
            if (parsed && typeof parsed.name === 'string') {
                return {
                    call: { name: parsed.name, args: parsed.args || {} },
                    preText: content.slice(0, openIdx).trimEnd(),
                };
            }
        } catch {
            // Incomplete or malformed JSON — wait for more chunks.
        }
        return null;
    }

    /**
     * Reconstruct what the model "actually said" for one assistant turn — i.e. the
     * visible preText plus the tool block (if any). The model needs to see its own
     * tool call in context on subsequent turns or it will keep re-calling.
     */
    private serializeAssistantForApi(msg: ChatMessage): string {
        if (!msg.toolCall) return msg.content;
        const block = `${GemmaProtocol.TOOL_CALL_OPEN}\n${JSON.stringify({ name: msg.toolCall.name, args: msg.toolCall.args })}\n${GemmaProtocol.TOOL_CALL_CLOSE}`;
        return msg.content ? `${msg.content}\n${block}` : block;
    }

    private buildAgentApiMessages(userMsg: ChatMessage, isFirstIteration: boolean, currentAssistantId: string): GemmaProtocol.Message[] {
        const result: GemmaProtocol.Message[] = [];
        for (const m of this.messages) {
            if (m.id === currentAssistantId) continue; // The placeholder we're about to fill.
            if (m.isStreaming) continue;
            if (m.role === 'user' && m.id === userMsg.id && isFirstIteration) {
                result.push({ role: 'user', content: this.buildIdeAwarePrompt(m.content) });
                continue;
            }
            if (m.role === 'assistant') {
                result.push({ role: 'assistant', content: this.serializeAssistantForApi(m) });
                continue;
            }
            result.push({ role: m.role, content: m.content });
        }
        return result;
    }

    private async executeTool(call: GemmaProtocol.AgentToolCall): Promise<{ ok: boolean; result?: any; error?: string }> {
        try {
            switch (call.name) {
                case 'read_file': {
                    const data = await this.chatService.readFile(call.args.path);
                    return { ok: true, result: data };
                }
                case 'list_dir': {
                    const data = await this.chatService.listDir(call.args.path || '');
                    return { ok: true, result: data };
                }
                case 'write_file': {
                    const path = call.args.path;
                    let existing: string | undefined;
                    try {
                        const current = await this.chatService.readFile(path);
                        existing = current.content;
                    } catch {
                        existing = undefined; // New file.
                    }
                    const approved = await this.confirmTool(call, existing);
                    if (!approved) return { ok: false, error: 'user denied' };
                    const data = await this.chatService.writeFile(path, call.args.content);
                    return { ok: true, result: data };
                }
                case 'run_command': {
                    const approved = await this.confirmTool(call);
                    if (!approved) return { ok: false, error: 'user denied' };
                    const data = await this.chatService.execute({ command: call.args.command, cwd: call.args.cwd, timeout: call.args.timeout });
                    return { ok: true, result: data };
                }
                default:
                    return { ok: false, error: `unknown tool: ${call.name}` };
            }
        } catch (err: any) {
            return { ok: false, error: err?.message || String(err) };
        }
    }

    private confirmTool(call: GemmaProtocol.AgentToolCall, existing?: string): Promise<boolean> {
        return new Promise<boolean>(resolve => {
            this.pendingConfirm = { call, existing, resolve };
            this.update();
        });
    }

    private resolveConfirm(approved: boolean): void {
        if (!this.pendingConfirm) return;
        const { resolve } = this.pendingConfirm;
        this.pendingConfirm = null;
        this.update();
        resolve(approved);
    }

    private handleClear(): void {
        this.messages = [];
        this.update();
    }

    private buildIdeAwarePrompt(userRequest: string): string {
        const editorContext = this.getEditorContext();
        const contextLines = [
            '[PARK Systems Coder request]',
            'You are running inside PARK Systems Coder, a VS Code-style local autonomous coding workspace with Lila Agent in the chat sidebar, editor integration, inline completion, refactoring, and a terminal agent panel.',
            this.agentMode
                ? 'Agent mode is ON: you have workspace tools for reading files, listing directories, writing files after approval, and running commands after approval. For coding work, use those tools instead of claiming you can only generate text.'
                : 'Agent mode is OFF: answer conversationally without workspace tool calls.',
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

        const fullText = model.getText();
        const lines = fullText.split('\n');
        const code = lines.slice(0, 160).join('\n');
        return { code, language, uri, hasSelection: false, selectionRange: 'none' };
    }

    private scrollToBottom(): void {
        if (this.messagesEndRef && this.activeTab === 'chat') {
            this.messagesEndRef.scrollIntoView({ behavior: 'smooth' });
        }
    }

    private copyToClipboard(text: string): void {
        navigator.clipboard.writeText(text).catch(() => {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
        });
    }

    private async toggleTerminal(): Promise<void> {
        try {
            await this.commandService.executeCommand(TerminalCommands.TOGGLE_TERMINAL.id);
        } catch (err: any) {
            this.messageService.error(`Failed to toggle terminal: ${err.message}`);
        }
    }

    // ---- Model picker -----------------------------------------------------

    private async openModelPicker(): Promise<void> {
        this.modelPickerOpen = true;
        this.update();
        await this.refreshModelPicker();
    }

    private closeModelPicker(): void {
        this.modelPickerOpen = false;
        this.update();
    }

    private async refreshModelPicker(): Promise<void> {
        this.modelTagsLoading = true;
        this.modelTagsError = null;
        this.update();
        try {
            const [tags, library, status] = await Promise.all([
                this.chatService.ollamaTags(),
                this.chatService.ollamaLibrary().catch(() => ({ models: [] as GemmaProtocol.OllamaLibraryEntry[] })),
                this.chatService.ollamaPullStatus().catch(() => null),
            ]);
            this.modelTags = tags.models;
            this.modelActive = tags.active || '';
            this.modelLibrary = library.models;
            this.pullStatus = status;
            // If a pull was already running when we opened the picker, resume polling.
            if (status?.status === 'running') {
                this.startPullPolling();
            }
        } catch (err: any) {
            this.modelTagsError = err.message || 'Failed to reach Ollama.';
        } finally {
            this.modelTagsLoading = false;
            this.update();
        }
    }

    private startPullPolling(): void {
        if (this.pullPollHandle !== null) return;
        this.pullPollHandle = window.setInterval(async () => {
            try {
                const status = await this.chatService.ollamaPullStatus();
                this.pullStatus = status;
                if (status.status === 'success') {
                    this.stopPullPolling();
                    await this.refreshModelPicker();
                    if (status.model) {
                        await this.selectModel(status.model);
                    }
                } else if (status.status === 'error') {
                    this.stopPullPolling();
                    this.messageService.error(`Pull failed: ${status.error || 'unknown error'}`);
                    this.update();
                } else {
                    this.update();
                }
            } catch {
                // ignore transient polling errors
            }
        }, 1000);
    }

    private stopPullPolling(): void {
        if (this.pullPollHandle !== null) {
            window.clearInterval(this.pullPollHandle);
            this.pullPollHandle = null;
        }
    }

    private async pullModel(name: string): Promise<void> {
        const tag = name.trim();
        if (!tag) return;
        try {
            await this.chatService.ollamaPull(tag);
            this.pullStatus = {
                status: 'running',
                model: tag,
                phase: 'starting',
                total: 0,
                completed: 0,
                percent: 0,
                error: null,
                started_at: Date.now() / 1000,
                finished_at: null,
            };
            this.update();
            this.startPullPolling();
        } catch (err: any) {
            this.messageService.error(`Failed to start pull: ${err.message}`);
        }
    }

    private async selectModel(name: string): Promise<void> {
        try {
            await this.chatService.ollamaSelect(name);
            this.modelActive = name;
            this.messageService.info(`Now using ${name}`);
            await this.checkConnection();
            await this.refreshModelPicker();
        } catch (err: any) {
            this.messageService.error(`Failed to switch model: ${err.message}`);
        }
    }

    /**
     * Build a markdown transcript of the current conversation. If `assistantOnly`
     * is true, only the most recent assistant response is included (handy for
     * saving a single answer as a review doc).
     */
    private buildMarkdownTranscript(assistantOnly: boolean): string {
        const stamp = new Date().toISOString();
        const header = [
            `# PARK Systems Coder Conversation`,
            ``,
            `_Saved ${stamp}_`,
            ``,
        ].join('\n');

        if (assistantOnly) {
            const lastAssistant = [...this.messages].reverse().find(m => m.role === 'assistant');
            if (!lastAssistant) return `${header}\n_(no assistant response yet)_\n`;
            return `${header}\n${lastAssistant.content.trim()}\n`;
        }

        const body = this.messages
            .map(m => {
                const heading = m.role === 'user' ? '## You' : '## Lila Agent';
                return `${heading}\n\n${m.content.trim()}\n`;
            })
            .join('\n');
        return `${header}\n${body}`;
    }

    private async saveAsMarkdown(assistantOnly: boolean): Promise<void> {
        const content = this.buildMarkdownTranscript(assistantOnly);
        const roots = this.workspaceService.tryGetRoots();
        const root = roots[0]?.resource;
        if (!root) {
            this.messageService.warn('Open a workspace folder before saving Lila Agent notes.');
            return;
        }

        const ts = new Date()
            .toISOString()
            .replace(/[:.]/g, '-')
            .replace('T', '_')
            .slice(0, 19);
        const suffix = assistantOnly ? 'response' : 'transcript';
        const fileUri: URI = root.resolve(`gemma-notes`).resolve(`${ts}-${suffix}.md`);

        try {
            const buffer = BinaryBuffer.fromString(content);
            await this.fileService.createFile(fileUri, buffer, { overwrite: true });
            this.messageService.info(`Saved ${fileUri.path.toString()}`);
            await open(this.openerService, fileUri);
        } catch (err: any) {
            this.messageService.error(`Failed to save markdown: ${err.message}`);
        }
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
                <pre className="gemma-code-content monaco-editor"><code>{code}</code></pre>
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

        if (lastIndex < content.length) {
            parts.push(
                <span key={`text-end`} className="gemma-text">
                    {content.slice(lastIndex)}
                </span>
            );
        }

        return parts;
    }

    /**
     * Lightweight markdown -> React renderer for the Preview tab. Handles
     * headings, fenced code, inline code, bold, italic, links, and paragraphs.
     * Deliberately small: full CommonMark would pull in a dependency.
     */
    private renderMarkdownPreview(md: string): React.ReactNode {
        if (!md.trim()) {
            return <div className="gemma-preview-empty">No assistant response yet — send a message in the Chat tab.</div>;
        }

        const blocks: React.ReactNode[] = [];
        const lines = md.split('\n');
        let i = 0;
        let key = 0;

        while (i < lines.length) {
            const line = lines[i];

            // Fenced code block
            if (/^```/.test(line)) {
                const lang = line.replace(/^```/, '').trim();
                const codeLines: string[] = [];
                i++;
                while (i < lines.length && !/^```/.test(lines[i])) {
                    codeLines.push(lines[i]);
                    i++;
                }
                i++;
                blocks.push(this.renderCodeBlock(codeLines.join('\n'), lang, `pv-code-${key++}`));
                continue;
            }

            // Heading
            const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
            if (headingMatch) {
                const level = headingMatch[1].length;
                const text = headingMatch[2];
                const Tag = (`h${level}` as unknown) as keyof JSX.IntrinsicElements;
                blocks.push(<Tag key={`pv-h-${key++}`} className={`gemma-md-h gemma-md-h${level}`}>{this.renderInlineMarkdown(text)}</Tag>);
                i++;
                continue;
            }

            // Unordered list
            if (/^\s*[-*]\s+/.test(line)) {
                const items: string[] = [];
                while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
                    items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
                    i++;
                }
                blocks.push(
                    <ul key={`pv-ul-${key++}`} className="gemma-md-ul">
                        {items.map((it, idx) => <li key={idx}>{this.renderInlineMarkdown(it)}</li>)}
                    </ul>
                );
                continue;
            }

            // Blank line — paragraph break
            if (line.trim() === '') {
                i++;
                continue;
            }

            // Paragraph: gather until blank line / code fence / heading / list
            const paraLines: string[] = [];
            while (
                i < lines.length &&
                lines[i].trim() !== '' &&
                !/^```/.test(lines[i]) &&
                !/^#{1,6}\s+/.test(lines[i]) &&
                !/^\s*[-*]\s+/.test(lines[i])
            ) {
                paraLines.push(lines[i]);
                i++;
            }
            blocks.push(
                <p key={`pv-p-${key++}`} className="gemma-md-p">
                    {this.renderInlineMarkdown(paraLines.join(' '))}
                </p>
            );
        }

        return <>{blocks}</>;
    }

    private renderInlineMarkdown(text: string): React.ReactNode[] {
        // Order matters: inline code first so its contents are not further parsed.
        const tokens: { type: 'code' | 'bold' | 'italic' | 'link' | 'text'; content: string; href?: string }[] = [];
        const regex = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g;
        let last = 0;
        let m: RegExpExecArray | null;
        while ((m = regex.exec(text)) !== null) {
            if (m.index > last) {
                tokens.push({ type: 'text', content: text.slice(last, m.index) });
            }
            const tok = m[0];
            if (tok.startsWith('`')) {
                tokens.push({ type: 'code', content: tok.slice(1, -1) });
            } else if (tok.startsWith('**')) {
                tokens.push({ type: 'bold', content: tok.slice(2, -2) });
            } else if (tok.startsWith('*')) {
                tokens.push({ type: 'italic', content: tok.slice(1, -1) });
            } else if (tok.startsWith('[')) {
                const linkMatch = /\[([^\]]+)\]\(([^)]+)\)/.exec(tok);
                if (linkMatch) {
                    tokens.push({ type: 'link', content: linkMatch[1], href: linkMatch[2] });
                }
            }
            last = m.index + tok.length;
        }
        if (last < text.length) {
            tokens.push({ type: 'text', content: text.slice(last) });
        }

        return tokens.map((t, idx) => {
            switch (t.type) {
                case 'code': return <code key={idx} className="gemma-md-inline-code">{t.content}</code>;
                case 'bold': return <strong key={idx}>{t.content}</strong>;
                case 'italic': return <em key={idx}>{t.content}</em>;
                case 'link': return <a key={idx} href={t.href} target="_blank" rel="noopener noreferrer">{t.content}</a>;
                default: return <React.Fragment key={idx}>{t.content}</React.Fragment>;
            }
        });
    }

    private renderConversationMessage(msg: ChatMessage): React.ReactNode {
        // Synthetic tool-result messages render as a card, not as a user bubble.
        if (msg.toolResult) {
            return (
                <div key={msg.id} className="gemma-tool-row">
                    {this.renderToolResultCard(msg.toolResult, !!msg.toolDenied)}
                </div>
            );
        }

        return (
            <div key={msg.id} className={`gemma-message gemma-message-${msg.role}`}>
                <div className="gemma-message-avatar">
                    <span className={`codicon ${msg.role === 'user' ? 'codicon-person' : 'codicon-hubot'}`} />
                </div>
                <div className="gemma-message-content">
                    {msg.content && this.renderMessageContent(msg.content)}
                    {msg.agentWorkingText && (
                        <div className="gemma-agent-working" aria-live="polite">
                            <span className="codicon codicon-loading gemma-agent-working-icon" />
                            <span className="gemma-agent-working-text">{msg.agentWorkingText}</span>
                            <span className="gemma-agent-working-dots" aria-hidden="true" />
                        </div>
                    )}
                    {msg.toolCall && this.renderToolCallCard(msg.toolCall)}
                    {msg.isStreaming && <span className="gemma-cursor-blink">▊</span>}
                </div>
            </div>
        );
    }

    private toolIcon(name: string): string {
        switch (name) {
            case 'read_file': return 'codicon-file-code';
            case 'write_file': return 'codicon-edit';
            case 'list_dir': return 'codicon-folder-opened';
            case 'run_command': return 'codicon-terminal';
            case 'hermes_task': return 'codicon-circuit-board';
            case 'ra_aid_task': return 'codicon-rocket';
            case 'aider_task': return 'codicon-tools';
            default: return 'codicon-symbol-method';
        }
    }

    private toolSummary(call: GemmaProtocol.AgentToolCall): string {
        switch (call.name) {
            case 'read_file': return call.args?.path || '(no path)';
            case 'list_dir': return call.args?.path || '.';
            case 'write_file': return `${call.args?.path || '(no path)'} (${(call.args?.content?.length ?? 0).toLocaleString()} chars)`;
            case 'run_command': return call.args?.command || '(no command)';
            case 'hermes_task': return call.args?.task || '(no task)';
            case 'ra_aid_task': return call.args?.task || '(no task)';
            case 'aider_task': return call.args?.task || '(no task)';
            default: return JSON.stringify(call.args);
        }
    }

    private renderToolCallCard(call: GemmaProtocol.AgentToolCall): React.ReactNode {
        return (
            <div className="gemma-tool-card">
                <div className="gemma-tool-card-header">
                    <span className={`codicon ${this.toolIcon(call.name)}`} />
                    <span className="gemma-tool-name">{call.name}</span>
                    <span className="gemma-tool-summary">{this.toolSummary(call)}</span>
                </div>
            </div>
        );
    }

    private renderToolResultCard(result: GemmaProtocol.AgentToolResult, denied: boolean): React.ReactNode {
        const ok = result.ok && !denied;
        const status = denied ? 'denied' : (ok ? 'ok' : 'error');
        const headline =
            denied ? `${result.name} — denied by user` :
            ok ? `${result.name} — ok` :
                 `${result.name} — error`;

        let body: React.ReactNode = null;
        if (denied) {
            body = <em>You declined to run this tool.</em>;
        } else if (!ok) {
            body = <code className="gemma-tool-error">{result.error || 'unknown error'}</code>;
        } else {
            const r = result.result;
            if (result.name === 'read_file' && r) {
                body = (
                    <div className="gemma-tool-meta">
                        Read <code>{r.path}</code> — {r.size.toLocaleString()} bytes{r.truncated ? ' (truncated)' : ''}
                    </div>
                );
            } else if (result.name === 'write_file' && r) {
                body = (
                    <div className="gemma-tool-meta">
                        {r.created ? 'Created' : 'Updated'} <code>{r.path}</code> — {r.bytes_written.toLocaleString()} bytes
                    </div>
                );
            } else if (result.name === 'list_dir' && r) {
                body = (
                    <div className="gemma-tool-meta">
                        <code>{r.path}</code> — {r.entries.length} entries
                    </div>
                );
            } else if (result.name === 'run_command' && r) {
                body = (
                    <div className="gemma-tool-meta">
                        Exit {r.exit_code}{r.timed_out ? ' (timed out)' : ''}
                    </div>
                );
            } else if ((result.name === 'hermes_task' || result.name === 'ra_aid_task' || result.name === 'aider_task') && r) {
                body = (
                    <div className="gemma-tool-meta">
                        {r.engine} exit {r.exit_code}{r.timed_out ? ' (timed out)' : ''}
                    </div>
                );
            } else {
                body = <pre className="gemma-tool-pre">{JSON.stringify(r, null, 2).slice(0, 500)}</pre>;
            }
        }

        return (
            <div className={`gemma-tool-result-card status-${status}`}>
                <div className="gemma-tool-result-header">
                    <span className={`codicon ${ok ? 'codicon-pass-filled' : (denied ? 'codicon-circle-slash' : 'codicon-error')}`} />
                    <span>{headline}</span>
                </div>
                {body && <div className="gemma-tool-result-body">{body}</div>}
            </div>
        );
    }

    /**
     * Tiny line-level diff renderer. Not a real LCS — just shows old vs new
     * with simple +/- markers. Fine for review purposes; the file gets fully
     * overwritten regardless.
     */
    private renderSimpleDiff(oldText: string, newText: string): React.ReactNode {
        const oldLines = oldText.split('\n');
        const newLines = newText.split('\n');
        const max = Math.max(oldLines.length, newLines.length);
        const rows: React.ReactNode[] = [];
        for (let i = 0; i < max; i++) {
            const o = oldLines[i];
            const n = newLines[i];
            if (o === n) {
                rows.push(<div key={i} className="gemma-diff-row equal"> {o ?? ''}</div>);
            } else {
                if (o !== undefined) rows.push(<div key={`${i}-o`} className="gemma-diff-row remove">- {o}</div>);
                if (n !== undefined) rows.push(<div key={`${i}-n`} className="gemma-diff-row add">+ {n}</div>);
            }
        }
        return <div className="gemma-diff">{rows}</div>;
    }

    private renderConfirmModal(): React.ReactNode {
        if (!this.pendingConfirm) return null;
        const { call, existing } = this.pendingConfirm;

        let body: React.ReactNode;
        let actionLabel: string;
        let title: string;

        if (call.name === 'write_file') {
            title = existing === undefined ? 'Create file' : 'Overwrite file';
            actionLabel = existing === undefined ? 'Create' : 'Overwrite';
            const newContent = String(call.args?.content ?? '');
            body = (
                <>
                    <div className="gemma-confirm-meta">
                        <span className="codicon codicon-file-code" />
                        <code>{call.args?.path}</code>
                        <span className="gemma-confirm-meta-size">{newContent.length.toLocaleString()} chars</span>
                    </div>
                    {existing === undefined ? (
                        <div className="gemma-confirm-section">
                            <div className="gemma-confirm-section-title">New file</div>
                            <pre className="gemma-confirm-code monaco-editor">{newContent}</pre>
                        </div>
                    ) : (
                        <div className="gemma-confirm-section">
                            <div className="gemma-confirm-section-title">Diff</div>
                            {this.renderSimpleDiff(existing, newContent)}
                        </div>
                    )}
                </>
            );
        } else if (call.name === 'run_command') {
            title = 'Run shell command';
            actionLabel = 'Run';
            body = (
                <>
                    <div className="gemma-confirm-meta">
                        <span className="codicon codicon-terminal" />
                        <span>in workspace</span>
                    </div>
                    <pre className="gemma-confirm-code monaco-editor">{String(call.args?.command ?? '')}</pre>
                </>
            );
        } else {
            title = `Run ${call.name}`;
            actionLabel = 'Run';
            body = <pre className="gemma-confirm-code monaco-editor">{JSON.stringify(call.args, null, 2)}</pre>;
        }

        return (
            <div className="gemma-confirm-overlay" onClick={() => this.resolveConfirm(false)}>
                <div className="gemma-confirm-card" onClick={e => e.stopPropagation()}>
                    <div className="gemma-confirm-header">
                        <span className={`codicon ${this.toolIcon(call.name)}`} />
                        <span className="gemma-confirm-title">{title}</span>
                        <button className="gemma-confirm-close" onClick={() => this.resolveConfirm(false)} title="Deny">
                            <span className="codicon codicon-close" />
                        </button>
                    </div>
                    <div className="gemma-confirm-body">{body}</div>
                    <div className="gemma-confirm-actions">
                        <button className="gemma-confirm-deny" onClick={() => this.resolveConfirm(false)}>
                            Deny
                        </button>
                        <button className="gemma-confirm-approve" onClick={() => this.resolveConfirm(true)}>
                            <span className="codicon codicon-check" /> {actionLabel}
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    private renderModelPicker(): React.ReactNode {
        if (!this.modelPickerOpen) return null;

        const pull = this.pullStatus;
        const pulling = pull?.status === 'running';
        const installedNames = new Set(this.modelTags.map(t => t.name));

        return (
            <div className="gemma-model-overlay" onClick={() => this.closeModelPicker()}>
                <div className="gemma-model-card" onClick={e => e.stopPropagation()}>
                    <div className="gemma-model-header">
                        <span className="codicon codicon-symbol-namespace" />
                        <span className="gemma-model-title">Choose Ollama Model</span>
                        <button
                            className="gemma-model-refresh"
                            title="Refresh from Ollama"
                            onClick={() => this.refreshModelPicker()}
                            disabled={this.modelTagsLoading}
                        >
                            <span className="codicon codicon-refresh" />
                        </button>
                        <button
                            className="gemma-model-close"
                            title="Close"
                            onClick={() => this.closeModelPicker()}
                        >
                            <span className="codicon codicon-close" />
                        </button>
                    </div>

                    {this.modelTagsError && (
                        <div className="gemma-model-error">
                            <span className="codicon codicon-error" /> {this.modelTagsError}
                        </div>
                    )}

                    {pulling && pull && (
                        <div className="gemma-pull-progress">
                            <div className="gemma-pull-progress-row">
                                <span><strong>Pulling {pull.model}</strong> — {pull.phase || '...'}</span>
                                <span>{pull.percent.toFixed(1)}%</span>
                            </div>
                            <div className="gemma-pull-bar">
                                <div className="gemma-pull-bar-fill" style={{ width: `${pull.percent}%` }} />
                            </div>
                            {pull.total > 0 && (
                                <div className="gemma-pull-bytes">
                                    {(pull.completed / (1024 ** 3)).toFixed(2)} / {(pull.total / (1024 ** 3)).toFixed(2)} GB
                                </div>
                            )}
                        </div>
                    )}

                    <div className="gemma-model-section-title">Installed</div>
                    {this.modelTagsLoading && this.modelTags.length === 0 ? (
                        <div className="gemma-model-empty">Loading...</div>
                    ) : this.modelTags.length === 0 ? (
                        <div className="gemma-model-empty">
                            No models pulled yet. Pick one from the library below.
                        </div>
                    ) : (
                        <div className="gemma-model-list">
                            {this.modelTags.map(t => (
                                <button
                                    key={t.name}
                                    className={`gemma-model-item ${t.active ? 'active' : ''}`}
                                    onClick={() => this.selectModel(t.name)}
                                    disabled={t.active}
                                >
                                    <div className="gemma-model-item-main">
                                        <span className={`codicon ${t.active ? 'codicon-pass-filled' : 'codicon-circle-large-outline'}`} />
                                        <span className="gemma-model-name">{t.name}</span>
                                    </div>
                                    <span className="gemma-model-size">{t.size_gb.toFixed(1)} GB</span>
                                </button>
                            ))}
                        </div>
                    )}

                    <div className="gemma-model-section-title">Library — one-click pull</div>
                    <div className="gemma-model-list">
                        {this.modelLibrary.map(entry => {
                            const installed = installedNames.has(entry.tag);
                            return (
                                <div key={entry.tag} className="gemma-model-lib-item">
                                    <div className="gemma-model-lib-info">
                                        <div className="gemma-model-lib-row">
                                            <span className="gemma-model-name">{entry.label}</span>
                                            <span className="gemma-model-tag">{entry.tag}</span>
                                            <span className="gemma-model-size">{entry.size_gb} GB</span>
                                        </div>
                                        <div className="gemma-model-lib-desc">{entry.description}</div>
                                    </div>
                                    {installed ? (
                                        <button
                                            className="gemma-model-action use"
                                            disabled={entry.tag === this.modelActive}
                                            onClick={() => this.selectModel(entry.tag)}
                                        >
                                            {entry.tag === this.modelActive ? 'Active' : 'Use'}
                                        </button>
                                    ) : (
                                        <button
                                            className="gemma-model-action pull"
                                            disabled={pulling}
                                            onClick={() => this.pullModel(entry.tag)}
                                        >
                                            <span className="codicon codicon-cloud-download" /> Pull
                                        </button>
                                    )}
                                </div>
                            );
                        })}
                    </div>

                    <div className="gemma-model-section-title">Custom tag</div>
                    <div className="gemma-model-custom">
                        <input
                            type="text"
                            className="gemma-model-input"
                            placeholder="e.g. mistral:7b-instruct or llama3.3:70b"
                            value={this.customPullInput}
                            onChange={e => { this.customPullInput = (e.target as HTMLInputElement).value; this.update(); }}
                            disabled={pulling}
                        />
                        <button
                            className="gemma-model-action pull"
                            disabled={pulling || !this.customPullInput.trim()}
                            onClick={() => this.pullModel(this.customPullInput)}
                        >
                            <span className="codicon codicon-cloud-download" /> Pull
                        </button>
                    </div>
                    <div className="gemma-model-foot">
                        Pulled tags become available immediately — no server restart.
                    </div>
                </div>
            </div>
        );
    }

    private renderTabs(): React.ReactNode {
        const tabs: { id: ChatTab; label: string; icon: string }[] = [
            { id: 'chat', label: 'Chat', icon: 'codicon-comment-discussion' },
            { id: 'preview', label: 'Preview', icon: 'codicon-preview' },
        ];
        return (
            <div className="gemma-tabs" role="tablist">
                {tabs.map(t => (
                    <button
                        key={t.id}
                        role="tab"
                        aria-selected={this.activeTab === t.id}
                        className={`gemma-tab ${this.activeTab === t.id ? 'active' : ''}`}
                        onClick={() => { this.activeTab = t.id; this.update(); }}
                    >
                        <span className={`codicon ${t.icon}`} />
                        <span>{t.label}</span>
                    </button>
                ))}
            </div>
        );
    }

    private renderAgentControlPanel(): React.ReactNode {
        const routes: Array<{ id: AgentRoute; label: string; icon: string; title: string }> = [
            { id: 'hermes', label: 'Lila Agent', icon: 'codicon-circuit-board', title: 'Always-on manager that delegates to RA.Aid or aider' },
            { id: 'ra-aid', label: 'RA.Aid', icon: 'codicon-rocket', title: 'Force the senior engineer motor function for this task' },
            { id: 'aider', label: 'aider', icon: 'codicon-tools', title: 'Force the focused editor motor function for this task' },
        ];
        const routeCopy: Record<AgentRoute, string> = {
            hermes: 'Manager -> motor functions',
            'ra-aid': 'Forced senior engineer',
            aider: 'Forced editor',
        };

        return (
            <div className="gemma-agent-panel">
                <div className="gemma-agent-panel-row">
                    <div className="gemma-agent-route" role="group" aria-label="Command hierarchy">
                        {routes.map(route => (
                            <button
                                key={route.id}
                                className={`gemma-route-btn ${this.agentRoute === route.id ? 'active' : ''}`}
                                title={route.title}
                                onClick={() => { this.agentRoute = route.id; this.update(); }}
                                disabled={this.isGenerating || !this.agentMode}
                            >
                                <span className={`codicon ${route.icon}`} />
                                <span>{route.label}</span>
                            </button>
                        ))}
                    </div>
                    <div className="gemma-agent-current" title="Current routing">
                        <span className="codicon codicon-git-compare" />
                        <span>{this.agentMode ? routeCopy[this.agentRoute] : 'Chat only'}</span>
                    </div>
                </div>
                <div className="gemma-agent-panel-row compact">
                    <button
                        className="gemma-agent-action"
                        title="Check offline Canopy prerequisites"
                        disabled={this.isGenerating}
                        onClick={() => this.runShortcutCommand('Check Canopy prerequisites', 'npm.cmd run canopy:check', 120)}
                    >
                        <span className="codicon codicon-checklist" />
                        <span>Check Canopy</span>
                    </button>
                    <button
                        className="gemma-agent-action"
                        title="Launch Canopy dashboards for the managed project set"
                        disabled={this.isGenerating}
                        onClick={() => this.runShortcutCommand('Launch Canopy dashboards', 'npm.cmd run canopy', 120)}
                    >
                        <span className="codicon codicon-dashboard" />
                        <span>Canopy Board</span>
                    </button>
                    <button
                        className="gemma-agent-action"
                        title="Launch two Lila Agent-managed local agents for separate project folders"
                        disabled={this.isGenerating}
                        onClick={() => this.runShortcutCommand('Launch dual native agents', 'npm.cmd run agents:dual', 120)}
                    >
                        <span className="codicon codicon-run-all" />
                        <span>Dual Lila</span>
                    </button>
                    <button
                        className="gemma-agent-action"
                        title="Prepare isolated git worktrees and open Canopy dashboards"
                        disabled={this.isGenerating}
                        onClick={() => this.runShortcutCommand('Prepare Canopy worktrees', 'npm.cmd run canopy:setup', 300)}
                    >
                        <span className="codicon codicon-git-branch" />
                        <span>Smart Worktrees</span>
                    </button>
                    <button
                        className="gemma-agent-action"
                        title="Fast-forward pull the active workspace"
                        disabled={this.isGenerating}
                        onClick={() => this.runShortcutCommand('Pull active workspace', 'git pull --ff-only', 300)}
                    >
                        <span className="codicon codicon-cloud-download" />
                        <span>Pull</span>
                    </button>
                </div>
            </div>
        );
    }

    protected render(): React.ReactNode {
        const lastAssistant = [...this.messages].reverse().find(m => m.role === 'assistant');
        const previewSource = lastAssistant?.content ?? '';

        return (
            <div className="gemma-chat-container">
                {/* Header */}
                <div className="gemma-chat-header">
                    <div className="gemma-chat-title">
                        <span className="codicon codicon-circuit-board" />
                        <span>PARK Systems Coder</span>
                    </div>
                    <button
                        className={`gemma-agent-toggle ${this.agentMode ? 'on' : 'off'}`}
                        title={this.agentMode ? 'Agent mode ON - Lila Agent can delegate to RA.Aid/aider and run approved workspace tools' : 'Agent mode OFF - chat-only'}
                        onClick={() => { this.agentMode = !this.agentMode; this.update(); }}
                        disabled={this.isGenerating}
                    >
                        <span className={`codicon ${this.agentMode ? 'codicon-debug-start' : 'codicon-comment'}`} />
                        <span>Agent {this.agentMode ? 'ON' : 'OFF'}</span>
                    </button>
                    <button
                        className="gemma-chat-status gemma-chat-status-btn"
                        title="Click to choose / pull a model"
                        onClick={() => this.openModelPicker()}
                    >
                        <span className={`gemma-status-dot ${this.chatService.isConnected ? 'connected' : 'disconnected'}`} />
                        <span className="gemma-status-text">{this.serverStatus}</span>
                        <span className="codicon codicon-chevron-down gemma-status-chevron" />
                    </button>
                    <button className="gemma-chat-clear" onClick={() => this.handleClear()} title="Clear chat">
                        <span className="codicon codicon-clear-all" />
                    </button>
                </div>

                {this.renderTabs()}
                {this.renderAgentControlPanel()}

                {/* Tab body */}
                {this.activeTab === 'chat' ? (
                    <>
                        <div className="gemma-chat-messages">
                            {this.messages.length === 0 && (
                                <div className="gemma-chat-welcome">
                                    <h3>Lila Agent Console</h3>
                                    <p>Lila Agent manages coding work. It delegates to RA.Aid or aider when useful, and Canopy handles multi-worktree supervision.</p>
                                    <div className="gemma-welcome-grid">
                                        <button onClick={() => { this.agentRoute = 'hermes'; this.inputValue = 'Build this end to end:'; this.update(); }}>
                                            <span className="codicon codicon-circuit-board" /> Ask Lila
                                        </button>
                                        <button onClick={() => this.runShortcutCommand('Launch dual Lila Agent sessions', 'npm.cmd run agents:dual', 120)}>
                                            <span className="codicon codicon-run-all" /> Dual Lila
                                        </button>
                                        <button onClick={() => this.runShortcutCommand('Prepare smart worktrees', 'npm.cmd run canopy:setup', 300)}>
                                            <span className="codicon codicon-git-branch" /> Smart Worktrees
                                        </button>
                                        <button onClick={() => this.runShortcutCommand('Pull active workspace', 'git pull --ff-only', 300)}>
                                            <span className="codicon codicon-cloud-download" /> Git Pull
                                        </button>
                                    </div>
                                </div>
                            )}
                            {this.messages.map(msg => this.renderConversationMessage(msg))}
                            <div ref={el => { this.messagesEndRef = el; }} />
                        </div>

                        <div className="gemma-chat-input-area">
                            <textarea
                                className="gemma-chat-input"
                                value={this.inputValue}
                                placeholder="Ask Lila Agent to build..."
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
                    </>
                ) : (
                    <div className="gemma-preview-pane monaco-editor">
                        {this.renderMarkdownPreview(previewSource)}
                    </div>
                )}

                {/* Footer toolbar — terminal toggle + mode switcher + save actions */}
                <div className="gemma-chat-footer">
                    <button
                        className="gemma-foot-btn"
                        title="Toggle Terminal Panel"
                        onClick={() => this.toggleTerminal()}
                    >
                        <span className="codicon codicon-terminal" />
                        <span>Terminal</span>
                    </button>
                    <div className="gemma-mode-switch" role="group" aria-label="Agent mode">
                        {(Object.keys(MODE_MODELS) as ChatMode[]).map(mode => {
                            const meta = MODE_LABELS[mode];
                            const active = this.currentMode === mode;
                            return (
                                <button
                                    key={mode}
                                    className={`gemma-mode-btn ${active ? 'active' : ''}`}
                                    title={meta.title}
                                    onClick={() => this.setMode(mode)}
                                    disabled={this.isGenerating}
                                >
                                    <span className={`codicon ${meta.icon}`} />
                                    <span>{meta.label}</span>
                                </button>
                            );
                        })}
                    </div>
                    <div className="gemma-foot-spacer" />
                    <button
                        className="gemma-foot-btn"
                        title="Save last assistant response as a Markdown file"
                        onClick={() => this.saveAsMarkdown(true)}
                        disabled={!lastAssistant}
                    >
                        <span className="codicon codicon-save" />
                        <span>Save Response</span>
                    </button>
                    <button
                        className="gemma-foot-btn"
                        title="Save full conversation as a Markdown file"
                        onClick={() => this.saveAsMarkdown(false)}
                        disabled={this.messages.length === 0}
                    >
                        <span className="codicon codicon-save-all" />
                        <span>Save Transcript</span>
                    </button>
                </div>

                {this.renderModelPicker()}
                {this.renderConfirmModal()}

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

                    /* Tab strip */
                    .gemma-tabs {
                        display: flex;
                        border-bottom: 1px solid var(--theia-panel-border);
                        background: var(--theia-tab-inactiveBackground, var(--theia-editor-background));
                    }
                    .gemma-tab {
                        display: flex;
                        align-items: center;
                        gap: 6px;
                        padding: 6px 14px;
                        background: transparent;
                        color: var(--theia-tab-inactiveForeground, var(--theia-foreground));
                        border: none;
                        border-right: 1px solid var(--theia-panel-border);
                        cursor: pointer;
                        font-size: 12px;
                        opacity: 0.75;
                    }
                    .gemma-tab:hover { opacity: 1; }
                    .gemma-tab.active {
                        background: var(--theia-tab-activeBackground, var(--theia-editor-background));
                        color: var(--theia-tab-activeForeground, var(--theia-foreground));
                        opacity: 1;
                        border-bottom: 2px solid var(--theia-focusBorder, #0078d4);
                        margin-bottom: -1px;
                    }

                    .gemma-agent-panel {
                        padding: 8px 10px;
                        border-bottom: 1px solid var(--theia-panel-border);
                        background: var(--theia-editorGroupHeader-tabsBackground, var(--theia-editor-background));
                        display: flex;
                        flex-direction: column;
                        gap: 7px;
                    }
                    .gemma-agent-panel-row {
                        display: flex;
                        align-items: center;
                        gap: 8px;
                        min-width: 0;
                    }
                    .gemma-agent-panel-row.compact {
                        gap: 6px;
                        flex-wrap: wrap;
                    }
                    .gemma-agent-route {
                        display: inline-flex;
                        align-items: center;
                        border: 1px solid var(--theia-panel-border);
                        border-radius: 4px;
                        overflow: hidden;
                        flex-shrink: 0;
                    }
                    .gemma-route-btn {
                        display: inline-flex;
                        align-items: center;
                        gap: 5px;
                        min-height: 28px;
                        padding: 4px 8px;
                        border: none;
                        border-right: 1px solid var(--theia-panel-border);
                        background: transparent;
                        color: var(--theia-foreground);
                        cursor: pointer;
                        font-size: 11px;
                    }
                    .gemma-route-btn:last-child { border-right: none; }
                    .gemma-route-btn:hover:not(:disabled):not(.active) {
                        background: var(--theia-list-hoverBackground);
                    }
                    .gemma-route-btn.active {
                        background: var(--theia-button-background);
                        color: var(--theia-button-foreground);
                    }
                    .gemma-route-btn:disabled {
                        opacity: 0.45;
                        cursor: default;
                    }
                    .gemma-agent-current {
                        display: inline-flex;
                        align-items: center;
                        gap: 5px;
                        min-width: 0;
                        opacity: 0.72;
                        font-size: 11px;
                        white-space: nowrap;
                        overflow: hidden;
                        text-overflow: ellipsis;
                    }
                    .gemma-agent-action {
                        display: inline-flex;
                        align-items: center;
                        gap: 5px;
                        min-height: 28px;
                        padding: 4px 8px;
                        border: 1px solid var(--theia-panel-border);
                        border-radius: 4px;
                        background: var(--theia-button-secondaryBackground, transparent);
                        color: var(--theia-foreground);
                        cursor: pointer;
                        font-size: 11px;
                    }
                    .gemma-agent-action:hover:not(:disabled) {
                        background: var(--theia-list-hoverBackground);
                    }
                    .gemma-agent-action:disabled {
                        opacity: 0.45;
                        cursor: default;
                    }

                    .gemma-chat-messages {
                        flex: 1;
                        overflow-y: auto;
                        padding: 12px;
                    }
                    .gemma-chat-welcome {
                        padding: 18px 12px;
                        text-align: left;
                        opacity: 0.92;
                        border: 1px solid var(--theia-panel-border);
                        border-radius: 6px;
                        background: var(--theia-editorWidget-background, var(--theia-editor-background));
                    }
                    .gemma-chat-welcome h3 {
                        margin: 0 0 8px;
                        font-size: 14px;
                    }
                    .gemma-chat-welcome p {
                        margin: 0 0 12px;
                        line-height: 1.45;
                        opacity: 0.78;
                    }
                    .gemma-welcome-grid {
                        display: grid;
                        grid-template-columns: repeat(2, minmax(0, 1fr));
                        gap: 8px;
                    }
                    .gemma-welcome-grid button {
                        display: inline-flex;
                        align-items: center;
                        justify-content: center;
                        gap: 6px;
                        min-height: 34px;
                        padding: 7px 8px;
                        border-radius: 4px;
                        border: 1px solid var(--theia-panel-border);
                        background: var(--theia-button-secondaryBackground, transparent);
                        color: var(--theia-foreground);
                        cursor: pointer;
                        font-size: 12px;
                    }
                    .gemma-welcome-grid button:hover {
                        background: var(--theia-list-hoverBackground);
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

                    /* Code block — Monaco-styled */
                    .gemma-code-block {
                        margin: 8px 0;
                        border-radius: 4px;
                        overflow: hidden;
                        border: 1px solid var(--theia-editorWidget-border, var(--theia-panel-border));
                        background: var(--theia-editor-background);
                    }
                    .gemma-code-header {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        padding: 4px 10px;
                        background: var(--theia-editorGroupHeader-tabsBackground, var(--theia-titleBar-activeBackground));
                        border-bottom: 1px solid var(--theia-editorWidget-border, var(--theia-panel-border));
                        font-size: 11px;
                        font-family: var(--theia-ui-font-family);
                        color: var(--theia-editorLineNumber-foreground, var(--theia-foreground));
                    }
                    .gemma-code-lang {
                        text-transform: uppercase;
                        letter-spacing: 0.5px;
                        opacity: 0.8;
                    }
                    .gemma-code-copy {
                        background: transparent;
                        border: 1px solid var(--theia-editorWidget-border, var(--theia-panel-border));
                        color: var(--theia-foreground);
                        cursor: pointer;
                        padding: 2px 8px;
                        border-radius: 3px;
                        font-size: 11px;
                        font-family: var(--theia-ui-font-family);
                    }
                    .gemma-code-copy:hover {
                        background: var(--theia-list-hoverBackground);
                    }
                    .gemma-code-content {
                        padding: 8px 12px;
                        margin: 0;
                        overflow-x: auto;
                        font-family: var(--theia-editor-font-family, var(--theia-code-font-family), 'Consolas', 'Courier New', monospace);
                        font-size: var(--theia-editor-font-size, 13px);
                        font-weight: var(--theia-editor-font-weight, normal);
                        line-height: 1.45;
                        background: var(--theia-editor-background);
                        color: var(--theia-editor-foreground, var(--theia-foreground));
                        tab-size: 4;
                    }
                    .gemma-cursor-blink {
                        animation: blink 0.8s infinite;
                    }
                    .gemma-agent-working {
                        display: inline-flex;
                        align-items: center;
                        gap: 6px;
                        margin-top: 6px;
                        color: var(--theia-descriptionForeground);
                        font-family: var(--theia-editor-font-family, var(--theia-code-font-family), 'Consolas', 'Courier New', monospace);
                        font-size: 12px;
                        white-space: nowrap;
                    }
                    .gemma-agent-working-icon {
                        font-size: 13px;
                        animation: gemma-agent-spin 1.1s linear infinite;
                    }
                    .gemma-agent-working-text {
                        display: inline-block;
                    }
                    .gemma-agent-working-dots::after {
                        content: '';
                        display: inline-block;
                        width: 18px;
                        text-align: left;
                        animation: gemma-agent-dots 1.2s steps(4, end) infinite;
                    }
                    @keyframes blink {
                        0%, 50% { opacity: 1; }
                        51%, 100% { opacity: 0; }
                    }
                    @keyframes gemma-agent-spin {
                        from { transform: rotate(0deg); }
                        to { transform: rotate(360deg); }
                    }
                    @keyframes gemma-agent-dots {
                        0% { content: ''; }
                        25% { content: '.'; }
                        50% { content: '..'; }
                        75%, 100% { content: '...'; }
                    }

                    /* Preview tab */
                    .gemma-preview-pane {
                        flex: 1;
                        overflow-y: auto;
                        padding: 16px 20px;
                        background: var(--theia-editor-background);
                        color: var(--theia-editor-foreground, var(--theia-foreground));
                        font-family: var(--theia-ui-font-family);
                        font-size: 13px;
                        line-height: 1.6;
                    }
                    .gemma-preview-empty {
                        opacity: 0.6;
                        text-align: center;
                        padding: 30px 10px;
                    }
                    .gemma-md-h { margin: 14px 0 6px; font-weight: 600; }
                    .gemma-md-h1 { font-size: 1.5em; border-bottom: 1px solid var(--theia-panel-border); padding-bottom: 4px; }
                    .gemma-md-h2 { font-size: 1.3em; border-bottom: 1px solid var(--theia-panel-border); padding-bottom: 3px; }
                    .gemma-md-h3 { font-size: 1.15em; }
                    .gemma-md-h4 { font-size: 1.05em; }
                    .gemma-md-p { margin: 8px 0; }
                    .gemma-md-ul { margin: 8px 0 8px 20px; padding: 0; }
                    .gemma-md-ul li { margin: 3px 0; }
                    .gemma-md-inline-code {
                        font-family: var(--theia-editor-font-family, var(--theia-code-font-family), monospace);
                        font-size: 0.9em;
                        background: var(--theia-textCodeBlock-background, rgba(127,127,127,0.15));
                        padding: 1px 5px;
                        border-radius: 3px;
                    }
                    .gemma-preview-pane a {
                        color: var(--theia-textLink-foreground);
                        text-decoration: none;
                    }
                    .gemma-preview-pane a:hover { text-decoration: underline; }

                    /* Input area */
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

                    /* Footer toolbar */
                    .gemma-chat-footer {
                        display: flex;
                        align-items: center;
                        gap: 6px;
                        padding: 4px 8px;
                        border-top: 1px solid var(--theia-panel-border);
                        background: var(--theia-statusBar-background, var(--theia-titleBar-activeBackground));
                        color: var(--theia-statusBar-foreground, var(--theia-foreground));
                        font-size: 11px;
                    }
                    .gemma-foot-spacer { flex: 1; }
                    .gemma-foot-btn {
                        display: inline-flex;
                        align-items: center;
                        gap: 4px;
                        background: transparent;
                        color: inherit;
                        border: 1px solid transparent;
                        border-radius: 3px;
                        padding: 3px 8px;
                        cursor: pointer;
                        font-size: 11px;
                    }
                    .gemma-foot-btn:hover:not(:disabled) {
                        background: var(--theia-statusBarItem-hoverBackground, rgba(255,255,255,0.12));
                    }
                    .gemma-foot-btn:disabled {
                        opacity: 0.4;
                        cursor: default;
                    }
                    .gemma-mode-switch {
                        display: inline-flex;
                        align-items: center;
                        gap: 0;
                        margin-left: 4px;
                        border: 1px solid var(--theia-panel-border);
                        border-radius: 4px;
                        overflow: hidden;
                    }
                    .gemma-mode-btn {
                        display: inline-flex;
                        align-items: center;
                        gap: 4px;
                        background: transparent;
                        color: inherit;
                        border: none;
                        border-right: 1px solid var(--theia-panel-border);
                        padding: 3px 9px;
                        cursor: pointer;
                        font-size: 11px;
                    }
                    .gemma-mode-btn:last-child { border-right: none; }
                    .gemma-mode-btn:hover:not(:disabled):not(.active) {
                        background: var(--theia-statusBarItem-hoverBackground, rgba(255,255,255,0.12));
                    }
                    .gemma-mode-btn.active {
                        background: var(--theia-button-background, #0e639c);
                        color: var(--theia-button-foreground, #fff);
                    }
                    .gemma-mode-btn:disabled { opacity: 0.4; cursor: default; }

                    /* Status pill becomes a button */
                    .gemma-chat-status-btn {
                        background: transparent;
                        border: 1px solid transparent;
                        border-radius: 12px;
                        padding: 2px 8px;
                        cursor: pointer;
                        color: var(--theia-foreground);
                    }
                    .gemma-chat-status-btn:hover {
                        background: var(--theia-list-hoverBackground);
                        border-color: var(--theia-panel-border);
                    }
                    .gemma-status-chevron { font-size: 10px; opacity: 0.6; }

                    /* Model picker overlay */
                    .gemma-model-overlay {
                        position: absolute;
                        inset: 0;
                        background: rgba(0, 0, 0, 0.45);
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        z-index: 1000;
                        padding: 16px;
                    }
                    .gemma-model-card {
                        width: 100%;
                        max-width: 460px;
                        max-height: 90%;
                        overflow-y: auto;
                        background: var(--theia-editorWidget-background, var(--theia-editor-background));
                        color: var(--theia-foreground);
                        border: 1px solid var(--theia-editorWidget-border, var(--theia-panel-border));
                        border-radius: 6px;
                        box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
                        display: flex;
                        flex-direction: column;
                    }
                    .gemma-model-header {
                        display: flex;
                        align-items: center;
                        gap: 8px;
                        padding: 10px 14px;
                        border-bottom: 1px solid var(--theia-panel-border);
                        background: var(--theia-titleBar-activeBackground, var(--theia-editor-background));
                    }
                    .gemma-model-title {
                        font-weight: 600;
                        font-size: 13px;
                        flex: 1;
                    }
                    .gemma-model-refresh,
                    .gemma-model-close {
                        background: transparent;
                        border: none;
                        color: var(--theia-foreground);
                        cursor: pointer;
                        padding: 2px 4px;
                        opacity: 0.7;
                    }
                    .gemma-model-refresh:hover,
                    .gemma-model-close:hover { opacity: 1; }
                    .gemma-model-refresh:disabled { opacity: 0.3; cursor: default; }

                    .gemma-model-error {
                        margin: 10px 14px 0;
                        padding: 6px 10px;
                        border-radius: 4px;
                        background: var(--theia-inputValidation-errorBackground, rgba(229, 57, 53, 0.18));
                        border: 1px solid var(--theia-inputValidation-errorBorder, rgba(229, 57, 53, 0.45));
                        color: var(--theia-errorForeground, var(--theia-foreground));
                        font-size: 12px;
                        display: flex;
                        align-items: center;
                        gap: 6px;
                    }

                    .gemma-pull-progress {
                        margin: 10px 14px 0;
                        padding: 8px 10px;
                        background: var(--theia-editor-background);
                        border: 1px solid var(--theia-panel-border);
                        border-radius: 4px;
                        font-size: 12px;
                    }
                    .gemma-pull-progress-row {
                        display: flex;
                        justify-content: space-between;
                        margin-bottom: 6px;
                    }
                    .gemma-pull-bar {
                        height: 6px;
                        background: var(--theia-panel-border);
                        border-radius: 3px;
                        overflow: hidden;
                    }
                    .gemma-pull-bar-fill {
                        height: 100%;
                        background: var(--theia-progressBar-background, var(--theia-focusBorder, #0078d4));
                        transition: width 0.3s ease;
                    }
                    .gemma-pull-bytes {
                        margin-top: 4px;
                        opacity: 0.7;
                        font-size: 11px;
                    }

                    .gemma-model-section-title {
                        margin: 14px 14px 6px;
                        font-size: 11px;
                        text-transform: uppercase;
                        letter-spacing: 0.6px;
                        opacity: 0.65;
                    }
                    .gemma-model-empty {
                        margin: 0 14px;
                        padding: 14px;
                        text-align: center;
                        font-size: 12px;
                        opacity: 0.7;
                        border: 1px dashed var(--theia-panel-border);
                        border-radius: 4px;
                    }
                    .gemma-model-list {
                        margin: 0 14px;
                        display: flex;
                        flex-direction: column;
                        gap: 4px;
                    }

                    .gemma-model-item {
                        display: flex;
                        align-items: center;
                        justify-content: space-between;
                        gap: 8px;
                        padding: 8px 10px;
                        background: var(--theia-list-inactiveSelectionBackground, transparent);
                        border: 1px solid var(--theia-panel-border);
                        border-radius: 4px;
                        color: var(--theia-foreground);
                        cursor: pointer;
                        font-size: 12px;
                        text-align: left;
                    }
                    .gemma-model-item:hover:not(:disabled) {
                        background: var(--theia-list-hoverBackground);
                    }
                    .gemma-model-item.active {
                        border-color: var(--theia-focusBorder);
                        background: var(--theia-list-activeSelectionBackground, var(--theia-list-inactiveSelectionBackground));
                        cursor: default;
                    }
                    .gemma-model-item-main {
                        display: flex;
                        align-items: center;
                        gap: 6px;
                        min-width: 0;
                    }
                    .gemma-model-name { font-weight: 500; }
                    .gemma-model-tag {
                        font-family: var(--theia-editor-font-family, monospace);
                        font-size: 11px;
                        opacity: 0.75;
                    }
                    .gemma-model-size {
                        opacity: 0.65;
                        font-size: 11px;
                        white-space: nowrap;
                    }

                    .gemma-model-lib-item {
                        display: flex;
                        align-items: center;
                        gap: 8px;
                        padding: 8px 10px;
                        border: 1px solid var(--theia-panel-border);
                        border-radius: 4px;
                    }
                    .gemma-model-lib-info { flex: 1; min-width: 0; }
                    .gemma-model-lib-row {
                        display: flex;
                        align-items: center;
                        gap: 8px;
                        flex-wrap: wrap;
                    }
                    .gemma-model-lib-desc {
                        font-size: 11px;
                        opacity: 0.7;
                        margin-top: 2px;
                    }
                    .gemma-model-action {
                        display: inline-flex;
                        align-items: center;
                        gap: 4px;
                        padding: 5px 10px;
                        border-radius: 3px;
                        border: 1px solid transparent;
                        cursor: pointer;
                        font-size: 11px;
                        white-space: nowrap;
                    }
                    .gemma-model-action.pull {
                        background: var(--theia-button-background);
                        color: var(--theia-button-foreground);
                    }
                    .gemma-model-action.use {
                        background: transparent;
                        color: var(--theia-foreground);
                        border-color: var(--theia-panel-border);
                    }
                    .gemma-model-action.use:hover:not(:disabled) {
                        background: var(--theia-list-hoverBackground);
                    }
                    .gemma-model-action:disabled { opacity: 0.5; cursor: default; }

                    .gemma-model-custom {
                        display: flex;
                        gap: 6px;
                        margin: 0 14px;
                    }
                    .gemma-model-input {
                        flex: 1;
                        background: var(--theia-input-background);
                        color: var(--theia-input-foreground);
                        border: 1px solid var(--theia-input-border);
                        border-radius: 3px;
                        padding: 5px 8px;
                        font-family: var(--theia-editor-font-family, monospace);
                        font-size: 12px;
                    }
                    .gemma-model-input:focus {
                        outline: none;
                        border-color: var(--theia-focusBorder);
                    }
                    .gemma-model-foot {
                        margin: 12px 14px 14px;
                        font-size: 11px;
                        opacity: 0.6;
                        text-align: center;
                    }

                    /* Agent toggle */
                    .gemma-agent-toggle {
                        display: inline-flex;
                        align-items: center;
                        gap: 4px;
                        padding: 3px 8px;
                        background: transparent;
                        color: var(--theia-foreground);
                        border: 1px solid var(--theia-panel-border);
                        border-radius: 12px;
                        cursor: pointer;
                        font-size: 11px;
                    }
                    .gemma-agent-toggle.on {
                        background: var(--theia-button-background);
                        color: var(--theia-button-foreground);
                        border-color: var(--theia-button-background);
                    }
                    .gemma-agent-toggle:disabled { opacity: 0.55; cursor: default; }

                    /* Tool call card (inline, after assistant text) */
                    .gemma-tool-card {
                        margin-top: 6px;
                        padding: 6px 10px;
                        background: var(--theia-editor-background);
                        border: 1px solid var(--theia-editorWidget-border, var(--theia-panel-border));
                        border-radius: 4px;
                        font-size: 12px;
                        font-family: var(--theia-ui-font-family);
                    }
                    .gemma-tool-card-header {
                        display: flex;
                        align-items: center;
                        gap: 6px;
                        flex-wrap: wrap;
                    }
                    .gemma-tool-name {
                        font-weight: 600;
                        color: var(--theia-textLink-foreground, var(--theia-foreground));
                    }
                    .gemma-tool-summary {
                        font-family: var(--theia-editor-font-family, monospace);
                        font-size: 11px;
                        opacity: 0.85;
                        word-break: break-all;
                    }

                    /* Tool result row (synthetic message) */
                    .gemma-tool-row {
                        display: flex;
                        margin: 4px 0 12px;
                        padding-left: 36px; /* align under assistant content */
                    }
                    .gemma-tool-result-card {
                        flex: 1;
                        padding: 6px 10px;
                        border-radius: 4px;
                        border: 1px solid var(--theia-panel-border);
                        background: var(--theia-editor-background);
                        font-size: 12px;
                    }
                    .gemma-tool-result-card.status-ok      { border-color: rgba(76, 175, 80, 0.55); }
                    .gemma-tool-result-card.status-error   { border-color: rgba(244, 67, 54, 0.55); }
                    .gemma-tool-result-card.status-denied  { border-color: rgba(255, 152, 0, 0.55); }
                    .gemma-tool-result-header {
                        display: flex;
                        align-items: center;
                        gap: 6px;
                        font-weight: 500;
                    }
                    .gemma-tool-result-body {
                        margin-top: 4px;
                        opacity: 0.85;
                    }
                    .gemma-tool-meta code {
                        font-family: var(--theia-editor-font-family, monospace);
                        font-size: 11px;
                        background: var(--theia-textCodeBlock-background, rgba(127,127,127,0.15));
                        padding: 1px 4px;
                        border-radius: 2px;
                    }
                    .gemma-tool-error {
                        font-family: var(--theia-editor-font-family, monospace);
                        color: var(--theia-errorForeground, #f44336);
                    }
                    .gemma-tool-pre {
                        margin: 0;
                        padding: 4px 6px;
                        font-family: var(--theia-editor-font-family, monospace);
                        font-size: 11px;
                        background: var(--theia-textCodeBlock-background, rgba(127,127,127,0.1));
                        border-radius: 3px;
                        overflow-x: auto;
                    }

                    /* Confirm modal */
                    .gemma-confirm-overlay {
                        position: absolute;
                        inset: 0;
                        background: rgba(0, 0, 0, 0.5);
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        z-index: 1100;
                        padding: 16px;
                    }
                    .gemma-confirm-card {
                        width: 100%;
                        max-width: 540px;
                        max-height: 90%;
                        display: flex;
                        flex-direction: column;
                        background: var(--theia-editorWidget-background, var(--theia-editor-background));
                        color: var(--theia-foreground);
                        border: 1px solid var(--theia-editorWidget-border, var(--theia-panel-border));
                        border-radius: 6px;
                        box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5);
                    }
                    .gemma-confirm-header {
                        display: flex;
                        align-items: center;
                        gap: 8px;
                        padding: 10px 14px;
                        border-bottom: 1px solid var(--theia-panel-border);
                        background: var(--theia-titleBar-activeBackground, var(--theia-editor-background));
                    }
                    .gemma-confirm-title { flex: 1; font-weight: 600; font-size: 13px; }
                    .gemma-confirm-close {
                        background: transparent;
                        border: none;
                        color: var(--theia-foreground);
                        cursor: pointer;
                        padding: 2px 4px;
                        opacity: 0.7;
                    }
                    .gemma-confirm-close:hover { opacity: 1; }

                    .gemma-confirm-body {
                        flex: 1;
                        overflow-y: auto;
                        padding: 12px 14px;
                    }
                    .gemma-confirm-meta {
                        display: flex;
                        align-items: center;
                        gap: 6px;
                        margin-bottom: 8px;
                        font-size: 12px;
                    }
                    .gemma-confirm-meta code {
                        font-family: var(--theia-editor-font-family, monospace);
                        background: var(--theia-textCodeBlock-background, rgba(127,127,127,0.15));
                        padding: 1px 5px;
                        border-radius: 2px;
                    }
                    .gemma-confirm-meta-size { opacity: 0.65; font-size: 11px; }

                    .gemma-confirm-section { margin-top: 8px; }
                    .gemma-confirm-section-title {
                        text-transform: uppercase;
                        font-size: 10px;
                        letter-spacing: 0.6px;
                        opacity: 0.65;
                        margin-bottom: 4px;
                    }
                    .gemma-confirm-code {
                        margin: 0;
                        padding: 8px 10px;
                        background: var(--theia-editor-background);
                        border: 1px solid var(--theia-panel-border);
                        border-radius: 3px;
                        font-family: var(--theia-editor-font-family, monospace);
                        font-size: 12px;
                        color: var(--theia-editor-foreground, var(--theia-foreground));
                        white-space: pre-wrap;
                        word-break: break-word;
                        max-height: 360px;
                        overflow: auto;
                    }

                    .gemma-diff {
                        font-family: var(--theia-editor-font-family, monospace);
                        font-size: 12px;
                        background: var(--theia-editor-background);
                        border: 1px solid var(--theia-panel-border);
                        border-radius: 3px;
                        max-height: 360px;
                        overflow: auto;
                    }
                    .gemma-diff-row {
                        padding: 0 8px;
                        white-space: pre-wrap;
                        word-break: break-word;
                        line-height: 1.45;
                    }
                    .gemma-diff-row.add    { background: rgba(76, 175, 80, 0.16); }
                    .gemma-diff-row.remove { background: rgba(244, 67, 54, 0.18); }
                    .gemma-diff-row.equal  { opacity: 0.7; }

                    .gemma-confirm-actions {
                        display: flex;
                        justify-content: flex-end;
                        gap: 8px;
                        padding: 8px 14px;
                        border-top: 1px solid var(--theia-panel-border);
                    }
                    .gemma-confirm-deny,
                    .gemma-confirm-approve {
                        display: inline-flex;
                        align-items: center;
                        gap: 4px;
                        padding: 5px 14px;
                        border-radius: 3px;
                        cursor: pointer;
                        font-size: 12px;
                        border: 1px solid transparent;
                    }
                    .gemma-confirm-deny {
                        background: transparent;
                        color: var(--theia-foreground);
                        border-color: var(--theia-panel-border);
                    }
                    .gemma-confirm-deny:hover { background: var(--theia-list-hoverBackground); }
                    .gemma-confirm-approve {
                        background: var(--theia-button-background);
                        color: var(--theia-button-foreground);
                    }
                `}</style>
            </div>
        );
    }

    protected onAfterAttach(msg: TheiaMessage): void {
        super.onAfterAttach(msg);
        this.update();
    }

    dispose(): void {
        this.stopPullPolling();
        super.dispose();
    }
}
