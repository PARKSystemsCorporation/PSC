/**
 * Gemma Theia IDE — AI Chat Frontend Module
 * ============================================
 * DI container module wiring up the chat widget, service, and contributions.
 */

import { ContainerModule } from '@theia/core/shared/inversify';
import {
    bindViewContribution,
    FrontendApplicationContribution,
    WidgetFactory,
} from '@theia/core/lib/browser';
import { AiChatService } from './ai-chat-service';
import { AiChatWidget } from './ai-chat-widget';
import { AiChatContribution } from './ai-chat-contribution';

export default new ContainerModule(bind => {
    // Service (singleton)
    bind(AiChatService).toSelf().inSingletonScope();

    // Widget
    bind(AiChatWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(ctx => ({
        id: AiChatWidget.ID,
        createWidget: () => ctx.container.get<AiChatWidget>(AiChatWidget),
    })).inSingletonScope();

    // Contribution (commands, keybindings, view)
    bindViewContribution(bind, AiChatContribution);
    bind(FrontendApplicationContribution).toService(AiChatContribution);
});
