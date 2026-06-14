import { Injectable } from '@angular/core'
import { TabRecoveryProvider, RecoveryToken, NewTabParameters } from 'tabby-core'
import { PilotTabComponent } from './components/pilotTab.component'

/**
 * Tab Recovery Provider: 使 Pilot Chat 标签在 Tabby 重启后能够恢复
 */
@Injectable()
export class PilotTabRecoveryProvider extends TabRecoveryProvider<PilotTabComponent> {
    async applicableTo(recoveryToken: RecoveryToken): Promise<boolean> {
        return recoveryToken.type === 'app:pilot-chat'
    }

    async recover(recoveryToken: RecoveryToken): Promise<NewTabParameters<PilotTabComponent>> {
        return {
            type: PilotTabComponent,
            inputs: {
                sessionId: recoveryToken.sessionId,
            },
        }
    }
}
