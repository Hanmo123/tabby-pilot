import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import { NgbModule } from '@ng-bootstrap/ng-bootstrap'
import TabbyCoreModule, { ConfigProvider, HotkeyProvider, HostAppService, AppService, HotkeysService, SplitTabComponent, TabsService, TabRecoveryProvider, TabRecoveryService } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'

import { PilotTabComponent } from './components/pilotTab.component'
import { PilotSettingsTabComponent } from './components/pilotSettingsTab.component'

import { PilotConfigProvider } from './config'
import { PilotSettingsTabProvider } from './settings'
import { PilotHotkeyProvider } from './hotkeys'
import { PilotTabRecoveryProvider } from './recovery'

import { PilotAIService } from './services/ai.service'
import { SessionService } from './services/session.service'

@NgModule({
    imports: [
        NgbModule,
        CommonModule,
        FormsModule,
        TabbyCoreModule,
    ],
    providers: [
        { provide: ConfigProvider, useClass: PilotConfigProvider, multi: true },
        { provide: SettingsTabProvider, useClass: PilotSettingsTabProvider, multi: true },
        { provide: HotkeyProvider, useClass: PilotHotkeyProvider, multi: true },
        { provide: TabRecoveryProvider, useClass: PilotTabRecoveryProvider, multi: true },
        PilotAIService,
        SessionService,
    ],
    declarations: [
        PilotTabComponent,
        PilotSettingsTabComponent,
    ],
})
export default class PilotModule {
    constructor(
        private app: AppService,
        private hotkeys: HotkeysService,
        private tabsService: TabsService,
        private tabRecovery: TabRecoveryService,
        private sessionService: SessionService,
    ) {
        hotkeys.hotkey$.subscribe(hotkey => {
            if (hotkey === 'pilot-open-chat') {
                this.openChatTab()
            }
        })
    }

    private async openChatTab(): Promise<void> {
        // 场景1：没有打开的标签页，直接创建新标签
        if (this.app.tabs.length === 0) {
            const newSession = this.sessionService.createSession()
            this.app.openNewTab({
                type: PilotTabComponent,
                inputs: {
                    sessionId: newSession.id,
                },
            })
            return
        }

        // 获取当前激活的标签页
        const activeTab = this.app.activeTab
        if (!activeTab) {
            const newSession = this.sessionService.createSession()
            this.app.openNewTab({
                type: PilotTabComponent,
                inputs: {
                    sessionId: newSession.id,
                },
            })
            return
        }

        let splitTab: SplitTabComponent

        // 场景2：当前标签已经是 SplitTab
        if (activeTab instanceof SplitTabComponent) {
            splitTab = activeTab
            
            // 检查是否已经有 Pilot 窗格
            const existingPilotTab = splitTab.getAllTabs().find(
                tab => tab instanceof PilotTabComponent
            ) as PilotTabComponent | undefined
            
            if (existingPilotTab) {
                // 如果 Pilot 窗格已经获得焦点，则关闭侧边栏
                if (splitTab.getFocusedTab() === existingPilotTab) {
                    existingPilotTab.closeSidebar()
                    return
                }
                
                // 否则，聚焦 Pilot 窗格并聚焦输入框
                splitTab.focus(existingPilotTab)
                existingPilotTab.focusInput()
                return
            }
        } else {
            // 场景3：将普通标签转换为 SplitTab
            const index = Math.max(this.app.tabs.indexOf(activeTab), 0)
            
            // 创建新的 SplitTabComponent
            splitTab = this.tabsService.create({ 
                type: SplitTabComponent, 
                inputs: {} 
            })
            
            this.app.removeTab(activeTab)
            this.app.addTabRaw(splitTab, index)

            // 等待 SplitTab 初始化完成，再将原标签添加到左侧
            await splitTab.initialized$.toPromise()
            await splitTab.addTab(activeTab, null, 'l')
        }

        // 创建新的 PilotTab（每次创建新会话）
        const newSession = this.sessionService.createSession()
        const pilotTab = this.tabsService.create({
            type: PilotTabComponent,
            inputs: {
                sessionId: newSession.id,
            },
        }) as PilotTabComponent
        
        // 添加到右侧
        const focusedTab = splitTab.getFocusedTab()
        await splitTab.addTab(pilotTab, focusedTab, 'r')
        this.app.emitTabsChanged()
        await this.tabRecovery.saveTabs(this.app.tabs)
        
        // 聚焦输入框
        pilotTab.focusInput()
    }
}

export * from './api'
export { PilotTabComponent }
