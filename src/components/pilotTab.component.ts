import { Component, Input, HostBinding, OnInit, OnDestroy, Injector } from '@angular/core'
import { BaseTabComponent, SplitTabComponent } from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import { PilotAIService } from '../services/ai.service'
import { SessionService } from '../services/session.service'
import { ChatMessage, ToolExecution } from '../api/interfaces'
import { Subject } from 'rxjs'

@Component({
    selector: 'pilot-tab',
    template: require('./pilotTab.component.pug'),
    styles: [require('./pilotTab.component.scss')],
})
export class PilotTabComponent extends BaseTabComponent implements OnInit, OnDestroy {
    @Input() sessionId?: string

    @HostBinding('class.pilot-tab') true

    messages: ChatMessage[] = []
    currentSessionId: string = ''
    inputText: string = ''
    isLoading: boolean = false
    currentAssistantMessage: string = ''
    pendingToolExecutions: ToolExecution[] = []
    error: string | null = null

    private destroy$ = new Subject<void>()
    private currentMessageId: string = ''

    constructor(
        injector: Injector,
        private ai: PilotAIService,
        private session: SessionService,
    ) {
        super(injector)
    }

    ngOnInit(): void {
        if (this.sessionId) {
            const session = this.session.getSession(this.sessionId)
            if (session) {
                this.currentSessionId = this.sessionId
                this.messages = session.messages
            }
        }

        if (!this.currentSessionId) {
            const newSession = this.session.createSession()
            this.currentSessionId = newSession.id
            this.sessionId = newSession.id
        }

        this.session.setCurrentSession(this.currentSessionId)
        this.setTitle('Pilot Chat')
    }

    ngOnDestroy(): void {
        this.destroy$.next()
        this.destroy$.complete()
    }

    /**
     * 获取分屏中的终端窗格
     */
    private getTerminalTab(): BaseTerminalTabComponent<any> | null {
        // 如果当前 tab 在 SplitTab 中
        if (this.parent instanceof SplitTabComponent) {
            const allTabs = this.parent.getAllTabs()
            // 查找第一个终端 tab（通常是左侧的）
            const terminalTab = allTabs.find(tab => 
                tab instanceof BaseTerminalTabComponent
            ) as BaseTerminalTabComponent<any> | undefined
            
            return terminalTab || null
        }
        return null
    }

    async sendMessage(): Promise<void> {
        if (!this.inputText.trim() || this.isLoading) {
            return
        }

        this.error = null
        const userMessage: ChatMessage = {
            id: this.generateId(),
            role: 'user',
            content: this.inputText.trim(),
            timestamp: Date.now(),
        }

        this.messages.push(userMessage)
        this.session.addMessage(this.currentSessionId, userMessage)
        
        this.inputText = ''
        this.isLoading = true

        this.currentMessageId = this.generateId()
        this.currentAssistantMessage = ''

        try {
            const aiMessages = this.messages.map(msg => ({
                role: msg.role,
                content: msg.content,
            }))

            // 获取终端引用
            const terminalTab = this.getTerminalTab()

            const stream = this.ai.chat(aiMessages, async (toolCall) => {
                return await this.handleToolCall(toolCall)
            }, terminalTab)

            for await (const chunk of stream) {
                if (chunk.type === 'text-delta') {
                    this.currentAssistantMessage += chunk.textDelta
                } else if (chunk.type === 'tool-call') {
                    console.log('Tool call:', chunk)
                } else if (chunk.type === 'tool-result') {
                    console.log('Tool result:', chunk)
                } else if (chunk.type === 'finish') {
                    break
                }
            }

            if (this.currentAssistantMessage.trim()) {
                const assistantMessage: ChatMessage = {
                    id: this.currentMessageId,
                    role: 'assistant',
                    content: this.currentAssistantMessage.trim(),
                    timestamp: Date.now(),
                }
                this.messages.push(assistantMessage)
                this.session.addMessage(this.currentSessionId, assistantMessage)
            }

        } catch (error: any) {
            console.error('Error in chat:', error)
            this.error = error.message || 'An error occurred'
        } finally {
            this.isLoading = false
            this.currentAssistantMessage = ''
            this.currentMessageId = ''
        }
    }

    async handleToolCall(toolCall: any): Promise<boolean> {
        return new Promise((resolve) => {
            const execution: ToolExecution = {
                id: this.generateId(),
                toolName: toolCall.toolName,
                parameters: toolCall.args,
                status: 'pending',
                resolveCallback: resolve,
            }

            this.pendingToolExecutions.push(execution)
        })
    }

    approveExecution(execution: ToolExecution): void {
        execution.status = 'approved'
        if (execution.resolveCallback) {
            execution.resolveCallback(true)
        }
    }

    rejectExecution(execution: ToolExecution): void {
        execution.status = 'rejected'
        if (execution.resolveCallback) {
            execution.resolveCallback(false)
        }
        this.pendingToolExecutions = this.pendingToolExecutions.filter(e => e.id !== execution.id)
    }

    newChat(): void {
        const newSession = this.session.createSession()
        this.currentSessionId = newSession.id
        this.sessionId = newSession.id
        this.messages = []
        this.error = null
    }

    clearChat(): void {
        this.session.clearSession(this.currentSessionId)
        this.messages = []
        this.error = null
    }

    private generateId(): string {
        return `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    }
}
