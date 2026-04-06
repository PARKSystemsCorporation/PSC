/**
 * Gemma Theia IDE — AI Completion Frontend Module
 */

import { ContainerModule } from '@theia/core/shared/inversify';
import { CommandContribution } from '@theia/core/lib/common/command';
import { KeybindingContribution } from '@theia/core/lib/browser/keybinding';
import { AiCompletionProvider } from './ai-completion-provider';
import { AiCompletionContribution } from './ai-completion-contribution';

export default new ContainerModule(bind => {
    bind(AiCompletionProvider).toSelf().inSingletonScope();
    bind(AiCompletionContribution).toSelf().inSingletonScope();
    bind(CommandContribution).toService(AiCompletionContribution);
    bind(KeybindingContribution).toService(AiCompletionContribution);
});
