/**
 * Gemma Theia IDE — AI Chat Contribution
 * =========================================
 * Registers the AI chat widget, commands, and keybindings.
 */

import { injectable, unmanaged } from '@theia/core/shared/inversify';
import {
    AbstractViewContribution,
    FrontendApplication,
    FrontendApplicationContribution,
} from '@theia/core/lib/browser';
import { Command, CommandRegistry } from '@theia/core/lib/common/command';
import { KeybindingRegistry } from '@theia/core/lib/browser/keybinding';
import { MenuModelRegistry } from '@theia/core/lib/common/menu';
import { AiChatWidget, AI_CHAT_WIDGET_ID } from './ai-chat-widget';

export namespace GemmaCommands {
    export const TOGGLE_CHAT: Command = {
        id: 'gemma.toggleChat',
        label: 'Gemma AI: Toggle Chat Panel',
        category: 'AI',
    };
    export const EXPLAIN_CODE: Command = {
        id: 'gemma.explainCode',
        label: 'Gemma AI: Explain Selected Code',
        category: 'AI',
    };
    export const REFACTOR_CODE: Command = {
        id: 'gemma.refactorCode',
        label: 'Gemma AI: Refactor Selected Code',
        category: 'AI',
    };
    export const FIX_CODE: Command = {
        id: 'gemma.fixCode',
        label: 'Gemma AI: Fix Errors in Selected Code',
        category: 'AI',
    };
}

@injectable()
export class AiChatContribution extends AbstractViewContribution<AiChatWidget>
    implements FrontendApplicationContribution {

    // `@unmanaged()` is required here because AbstractViewContribution's constructor
    // takes plain widget options rather than an injectable service.
    // @ts-expect-error Inversify's constructor-parameter decorator types are too narrow here.
    constructor(@unmanaged() _viewOptions: unknown) {
        super({
            widgetId: AI_CHAT_WIDGET_ID,
            widgetName: 'Gemma AI',
            defaultWidgetOptions: {
                area: 'right',
                rank: 100,
            },
            toggleCommandId: GemmaCommands.TOGGLE_CHAT.id,
        });
    }

    async initializeLayout(app: FrontendApplication): Promise<void> {
        await this.openView({ activate: false, reveal: true });
    }

    registerCommands(commands: CommandRegistry): void {
        super.registerCommands(commands);

        commands.registerCommand(GemmaCommands.EXPLAIN_CODE, {
            execute: () => this.openViewAndSendCommand('Explain this code'),
        });
        commands.registerCommand(GemmaCommands.REFACTOR_CODE, {
            execute: () => this.openViewAndSendCommand('Refactor this code to be cleaner and more efficient'),
        });
        commands.registerCommand(GemmaCommands.FIX_CODE, {
            execute: () => this.openViewAndSendCommand('Find and fix any bugs or errors in this code'),
        });
    }

    registerKeybindings(keybindings: KeybindingRegistry): void {
        super.registerKeybindings(keybindings);

        keybindings.registerKeybinding({
            command: GemmaCommands.TOGGLE_CHAT.id,
            keybinding: 'ctrlcmd+shift+g',
        });
        keybindings.registerKeybinding({
            command: GemmaCommands.EXPLAIN_CODE.id,
            keybinding: 'ctrlcmd+shift+e',
        });
    }

    registerMenus(menus: MenuModelRegistry): void {
        super.registerMenus(menus);
    }

    private async openViewAndSendCommand(prompt: string): Promise<void> {
        const widget = await this.openView({ activate: true });
        if (widget) {
            // The widget will pick up the editor context automatically
            // We trigger the chat with the given prompt
            (widget as any).inputValue = prompt;
            (widget as any).handleSend();
        }
    }
}
