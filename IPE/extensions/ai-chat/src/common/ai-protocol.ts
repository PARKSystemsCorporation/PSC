/**
 * Gemma Theia IDE — Shared AI Protocol Types
 * ============================================
 * Common types and interfaces used across all AI extensions.
 */

export namespace GemmaProtocol {

    /**
     * Base URL for the LLM agent server. Native local Windows runs a CORS
     * proxy on the public IDE port that fans /api/* and /health out to the
     * Python LLM server, so the default is a relative URL. Override via
     * window.__GEMMA_LLM_URL__ for custom deployments (e.g. a remote tunnel).
     */
    export const LLM_SERVER_URL: string =
        (typeof window !== 'undefined' && (window as any).__GEMMA_LLM_URL__) || '';

    /** Agent operation modes */
    export type AgentMode = 'chat' | 'completion' | 'terminal' | 'refactor';

    /** Chat message */
    export interface Message {
        role: 'system' | 'user' | 'assistant';
        content: string;
        timestamp?: number;
    }

    /** Chat request payload */
    export interface ChatRequest {
        messages: Message[];
        mode: AgentMode;
        stream: boolean;
        max_tokens?: number;
        temperature?: number;
        stop?: string[];
        /** Inject the tool-call protocol into the system prompt. */
        agent_tools?: boolean;
    }

    /** Names of the tools the agent can invoke. */
    export type AgentToolName = 'read_file' | 'list_dir' | 'write_file' | 'run_command';

    /** Parsed tool call extracted from a streamed assistant message. */
    export interface AgentToolCall {
        name: AgentToolName | string;
        args: Record<string, any>;
    }

    /** Result of executing a tool, fed back to the model as a synthetic message. */
    export interface AgentToolResult {
        name: string;
        ok: boolean;
        result?: any;
        error?: string;
    }

    /** Markers wrapping a tool call in the streamed assistant text. */
    export const TOOL_CALL_OPEN = '<<TOOL>>';
    export const TOOL_CALL_CLOSE = '<<END>>';
    export const TOOL_RESULT_OPEN = '<<TOOL_RESULT>>';

    export interface ReadFileResult {
        path: string;
        content: string;
        size: number;
        truncated: boolean;
    }

    export interface WriteFileResult {
        path: string;
        bytes_written: number;
        created: boolean;
    }

    export interface ListDirEntry {
        name: string;
        type: 'file' | 'dir';
        size: number | null;
    }

    export interface ListDirResult {
        path: string;
        entries: ListDirEntry[];
    }

    /** Code completion request */
    export interface CompletionRequest {
        prefix: string;
        suffix: string;
        language: string;
        max_tokens?: number;
        temperature?: number;
    }

    /** Code completion response */
    export interface CompletionResponse {
        completion: string;
    }

    /** Terminal agent request */
    export interface TerminalRequest {
        task: string;
        context: string;
        history: Message[];
        stream: boolean;
    }

    /** Terminal command execution request */
    export interface ExecuteRequest {
        command: string;
        cwd?: string;
        timeout?: number;
    }

    /** Terminal command execution response */
    export interface ExecuteResponse {
        command: string;
        cwd: string;
        exit_code: number;
        stdout: string;
        stderr: string;
        timed_out: boolean;
    }

    /** Lila Agent/RA.Aid/aider task request */
    export interface AgentTaskRequest {
        task: string;
        engine?: 'hermes' | 'ra-aid' | 'aider';
        cwd?: string;
        timeout?: number;
        use_aider?: boolean;
    }

    /** RA.Aid/aider task response */
    export interface AgentTaskResponse {
        engine: string;
        command: string;
        cwd: string;
        exit_code: number;
        stdout: string;
        stderr: string;
        timed_out: boolean;
    }

    /** Live event emitted while RA.Aid/aider is running. */
    export interface AgentTaskEvent {
        type: 'status' | 'log' | 'done' | 'error' | string;
        message?: string;
        command?: string;
        stream?: 'stdout' | 'stderr' | string;
        text?: string;
        result?: AgentTaskResponse;
        error?: string;
    }

    /** PSC target workspace status */
    export interface WorkspaceStatus {
        target_workspace: string;
        exists: boolean;
        is_directory: boolean;
    }

    /** Refactor request */
    export interface RefactorRequest {
        code: string;
        operation: string;
        language: string;
        selection?: string;
        instructions?: string;
    }

    /** Health check response */
    export interface HealthResponse {
        status: string;
        backend: string;
        model: string;
        uptime: number;
    }

    /** A model already pulled and available locally via Ollama. */
    export interface OllamaTag {
        name: string;
        size_gb: number;
        modified_at?: string;
        digest?: string;
        active: boolean;
    }

    /** A curated quick-pick entry from /api/ollama/library. */
    export interface OllamaLibraryEntry {
        tag: string;
        label: string;
        description: string;
        size_gb: number;
    }

    /** Background pull progress state from /api/ollama/pull/status. */
    export interface OllamaPullStatus {
        status: 'idle' | 'running' | 'success' | 'error';
        model: string | null;
        phase: string | null;
        total: number;
        completed: number;
        percent: number;
        error: string | null;
        started_at: number | null;
        finished_at: number | null;
    }

    /** Supported refactoring operations */
    export const REFACTOR_OPERATIONS = [
        { id: 'rename_symbol', label: 'Rename Symbol' },
        { id: 'extract_function', label: 'Extract Function' },
        { id: 'extract_variable', label: 'Extract Variable' },
        { id: 'inline_variable', label: 'Inline Variable' },
        { id: 'move_to_file', label: 'Move to File' },
        { id: 'convert_to_async', label: 'Convert to Async' },
        { id: 'add_types', label: 'Add Type Annotations' },
        { id: 'optimize_imports', label: 'Optimize Imports' },
    ] as const;
}
