/**
 * Gemma Theia IDE — AI Completion Contribution
 * ================================================
 * Registers commands and keybindings for inline AI code completion.
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import { CommandContribution, CommandRegistry, Command } from '@theia/core/lib/common/command';
import { KeybindingContribution, KeybindingRegistry } from '@theia/core/lib/browser/keybinding';
import { EditorManager } from '@theia/editor/lib/browser';
import { AiCompletionProvider } from './ai-completion-provider';

export namespace CompletionCommands {
    export const TRIGGER: Command = {
        id: 'gemma.triggerCompletion',
        label: 'Gemma AI: Trigger Inline Completion',
        category: 'AI',
    };
    export const ACCEPT: Command = {
        id: 'gemma.acceptCompletion',
        label: 'Gemma AI: Accept Inline Completion',
        category: 'AI',
    };
    export const DISMISS: Command = {
        id: 'gemma.dismissCompletion',
        label: 'Gemma AI: Dismiss Inline Completion',
        category: 'AI',
    };
    export const TOGGLE: Command = {
        id: 'gemma.toggleCompletion',
        label: 'Gemma AI: Toggle Inline Completions',
        category: 'AI',
    };
}

@injectable()
export class AiCompletionContribution implements CommandContribution, KeybindingContribution {

    @inject(AiCompletionProvider)
    protected readonly completionProvider: AiCompletionProvider;

    @inject(EditorManager)
    protected readonly editorManager: EditorManager;

    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(CompletionCommands.TRIGGER, {
            execute: () => {
                const editor = this.editorManager.currentEditor?.editor;
                if (editor) {
                    this.completionProvider.triggerCompletion(editor);
                }
            },
        });

        commands.registerCommand(CompletionCommands.ACCEPT, {
            execute: () => {
                const completion = this.completionProvider.acceptCompletion();
                if (completion) {
                    const editor = this.editorManager.currentEditor?.editor;
                    if (editor) {
                        // Insert the completion text at the cursor
                        const cursor = editor.cursor;
                        const edit = {
                            range: {
                                start: cursor,
                                end: cursor,
                            },
                            newText: completion.text,
                        };
                        editor.document.applyEdits([edit as any]);
                    }
                }
            },
        });

        commands.registerCommand(CompletionCommands.DISMISS, {
            execute: () => this.completionProvider.clearCompletion(),
        });

        commands.registerCommand(CompletionCommands.TOGGLE, {
            execute: () => this.completionProvider.toggle(),
        });
    }

    registerKeybindings(keybindings: KeybindingRegistry): void {
        keybindings.registerKeybinding({
            command: CompletionCommands.TRIGGER.id,
            keybinding: 'ctrlcmd+shift+space',
        });
        keybindings.registerKeybinding({
            command: CompletionCommands.ACCEPT.id,
            keybinding: 'tab',
            when: 'gemmaCompletionVisible',
        });
        keybindings.registerKeybinding({
            command: CompletionCommands.DISMISS.id,
            keybinding: 'escape',
            when: 'gemmaCompletionVisible',
        });
    }
}
