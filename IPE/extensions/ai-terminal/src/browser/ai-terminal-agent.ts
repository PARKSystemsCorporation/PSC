/**
 * Gemma Theia IDE — Terminal Agent Service
 * ============================================
 * Autonomous agent that plans and executes multi-step shell tasks.
 * Parses AI responses for executable commands, manages confirmation flow,
 * and tracks execution state.
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import { Emitter, Event } from '@theia/core';
import { AiChatService } from 'gemma-ai-chat/lib/browser/ai-chat-service';
import { GemmaProtocol } from 'gemma-ai-chat/lib/common/ai-protocol';

export interface AgentStep {
    id: string;
    description: string;
    command: string;
    status: 'pending' | 'running' | 'success' | 'failed' | 'skipped';
    output?: string;
    error?: string;
}

export interface AgentPlan {
    task: string;
    steps: AgentStep[];
    status: 'planning' | 'awaiting_confirmation' | 'executing' | 'completed' | 'failed';
    currentStep: number;
}

@injectable()
export class AiTerminalAgent {

    @inject(AiChatService)
    protected readonly chatService: AiChatService;

    private plan: AgentPlan | null = null;
    private history: GemmaProtocol.Message[] = [];
    private autoExecute: boolean = false;

    private readonly onPlanUpdateEmitter = new Emitter<AgentPlan | null>();
    readonly onPlanUpdate: Event<AgentPlan | null> = this.onPlanUpdateEmitter.event;

    private readonly onCommandRequestEmitter = new Emitter<{ step: AgentStep; callback: (output: string) => void }>();
    readonly onCommandRequest: Event<{ step: AgentStep; callback: (output: string) => void }> = this.onCommandRequestEmitter.event;

    private readonly onLogEmitter = new Emitter<string>();
    readonly onLog: Event<string> = this.onLogEmitter.event;

    get currentPlan(): AgentPlan | null {
        return this.plan;
    }

    get isAutoExecute(): boolean {
        return this.autoExecute;
    }

    set isAutoExecute(value: boolean) {
        this.autoExecute = value;
    }

    /**
     * Create a new agent plan from a task description.
     */
    async planTask(task: string, context: string = ''): Promise<AgentPlan> {
        this.log(`Planning task: ${task}`);

        this.plan = {
            task,
            steps: [],
            status: 'planning',
            currentStep: 0,
        };
        this.onPlanUpdateEmitter.fire(this.plan);

        // Ask the AI to generate a step-by-step plan
        const planPrompt = `Task: ${task}

${context ? `Context: ${context}\n` : ''}
Please create a step-by-step plan to accomplish this task.
For each step, provide:
1. A short description
2. The exact shell command to execute

Format each step as:
STEP: <description>
CMD: <command>

Only include necessary steps. Be concise.`;

        let response = '';
        await new Promise<void>((resolve, reject) => {
            this.chatService.streamChat(
                [
                    ...this.history,
                    { role: 'user', content: planPrompt },
                ],
                'terminal',
                (chunk) => { response += chunk; },
                () => resolve(),
                (err) => reject(err),
            );
        });

        // Parse steps from the response
        const steps = this.parseSteps(response);
        this.plan.steps = steps;
        this.plan.status = 'awaiting_confirmation';

        // Store in history for context
        this.history.push({ role: 'user', content: planPrompt });
        this.history.push({ role: 'assistant', content: response });

        this.onPlanUpdateEmitter.fire(this.plan);
        this.log(`Plan created with ${steps.length} steps`);

        return this.plan;
    }

    /**
     * Execute the current plan step by step.
     */
    async executePlan(): Promise<void> {
        if (!this.plan || this.plan.steps.length === 0) {
            this.log('No plan to execute');
            return;
        }

        this.plan.status = 'executing';
        this.onPlanUpdateEmitter.fire(this.plan);

        for (let i = this.plan.currentStep; i < this.plan.steps.length; i++) {
            const step = this.plan.steps[i];
            this.plan.currentStep = i;

            this.log(`Step ${i + 1}/${this.plan.steps.length}: ${step.description}`);
            step.status = 'running';
            this.onPlanUpdateEmitter.fire(this.plan);

            try {
                // Request command execution (the widget will handle running in terminal)
                const output = await new Promise<string>((resolve, reject) => {
                    const timeout = setTimeout(() => reject(new Error('Execution timeout')), 120000);
                    this.onCommandRequestEmitter.fire({
                        step,
                        callback: (result: string) => {
                            clearTimeout(timeout);
                            resolve(result);
                        },
                    });
                });

                step.output = output;
                step.status = 'success';
                this.log(`Step ${i + 1} completed`);

                // Feed result back to AI for next step context
                this.history.push({
                    role: 'user',
                    content: `Command executed: ${step.command}\nOutput: ${output}`,
                });

            } catch (err: any) {
                step.status = 'failed';
                step.error = err.message;
                this.log(`Step ${i + 1} failed: ${err.message}`);

                // Ask AI to suggest a fix
                const fixResponse = await this.suggestFix(step, err.message);
                this.log(`AI suggestion: ${fixResponse}`);

                // Mark remaining steps as skipped
                for (let j = i + 1; j < this.plan.steps.length; j++) {
                    this.plan.steps[j].status = 'skipped';
                }

                this.plan.status = 'failed';
                this.onPlanUpdateEmitter.fire(this.plan);
                return;
            }

            this.onPlanUpdateEmitter.fire(this.plan);
        }

        this.plan.status = 'completed';
        this.onPlanUpdateEmitter.fire(this.plan);
        this.log('All steps completed successfully');
    }

    /**
     * Execute a single step.
     */
    async executeStep(index: number): Promise<void> {
        if (!this.plan || index >= this.plan.steps.length) return;

        this.plan.currentStep = index;
        const step = this.plan.steps[index];
        step.status = 'running';
        this.onPlanUpdateEmitter.fire(this.plan);

        try {
            const output = await new Promise<string>((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('Execution timeout')), 120000);
                this.onCommandRequestEmitter.fire({
                    step,
                    callback: (result: string) => {
                        clearTimeout(timeout);
                        resolve(result);
                    },
                });
            });

            step.output = output;
            step.status = 'success';
        } catch (err: any) {
            step.status = 'failed';
            step.error = err.message;
        }

        this.onPlanUpdateEmitter.fire(this.plan);
    }

    /**
     * Ask the AI to suggest a fix for a failed step.
     */
    private async suggestFix(step: AgentStep, error: string): Promise<string> {
        let response = '';
        await new Promise<void>((resolve, reject) => {
            this.chatService.streamChat(
                [
                    ...this.history,
                    {
                        role: 'user',
                        content: `The command "${step.command}" failed with error:\n${error}\n\nSuggest a fix or alternative command.`,
                    },
                ],
                'terminal',
                (chunk) => { response += chunk; },
                () => resolve(),
                (err) => reject(err),
            );
        });
        return response;
    }

    /**
     * Parse AI response into executable steps.
     */
    private parseSteps(response: string): AgentStep[] {
        const steps: AgentStep[] = [];
        const lines = response.split('\n');
        let currentDesc = '';

        for (const line of lines) {
            const trimmed = line.trim();

            if (trimmed.startsWith('STEP:') || trimmed.match(/^\d+\.\s/)) {
                currentDesc = trimmed.replace(/^(STEP:|^\d+\.\s)/, '').trim();
            } else if (trimmed.startsWith('CMD:') || (trimmed.startsWith('```') && currentDesc)) {
                let cmd = trimmed.replace(/^CMD:\s*/, '').replace(/^```\w*\s*/, '').replace(/```$/, '').trim();
                if (cmd && currentDesc) {
                    steps.push({
                        id: `step-${steps.length}`,
                        description: currentDesc,
                        command: cmd,
                        status: 'pending',
                    });
                    currentDesc = '';
                }
            } else if (trimmed.startsWith('$') || trimmed.startsWith('> ')) {
                // Also catch shell-style commands
                const cmd = trimmed.replace(/^[$>]\s*/, '').trim();
                if (cmd) {
                    steps.push({
                        id: `step-${steps.length}`,
                        description: currentDesc || cmd,
                        command: cmd,
                        status: 'pending',
                    });
                    currentDesc = '';
                }
            }
        }

        return steps;
    }

    /**
     * Reset the agent state.
     */
    reset(): void {
        this.plan = null;
        this.history = [];
        this.onPlanUpdateEmitter.fire(null);
    }

    private log(message: string): void {
        this.onLogEmitter.fire(`[Agent] ${message}`);
    }

    dispose(): void {
        this.onPlanUpdateEmitter.dispose();
        this.onCommandRequestEmitter.dispose();
        this.onLogEmitter.dispose();
    }
}
