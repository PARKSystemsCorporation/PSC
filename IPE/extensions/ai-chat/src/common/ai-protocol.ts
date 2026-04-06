/**
 * Gemma Theia IDE — Shared AI Protocol Types
 * ============================================
 * Common types and interfaces used across all AI extensions.
 */

export namespace GemmaProtocol {

    /**
     * Base URL for the LLM agent server.
     * In Docker Compose, nginx proxies /api/* to the LLM server, so we use
     * a relative URL by default. Override via window.__GEMMA_LLM_URL__ for
     * custom deployments.
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
