import { Component, Input, HostBinding, OnInit, OnDestroy, Injector, ViewChild, ElementRef } from '@angular/core'
import { BaseTabComponent, SplitTabComponent, RecoveryToken } from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import { PilotAIService } from '../services/ai.service'
import { SessionService } from '../services/session.service'
import { ChatMessage, ToolExecution, ToolCall, MessagePart, PilotProviderType } from '../api/interfaces'
import { Subject } from 'rxjs'

@Component({
    selector: 'pilot-tab',
    template: require('./pilotTab.component.pug'),
    styles: [require('./pilotTab.component.scss')],
})
export class PilotTabComponent extends BaseTabComponent implements OnInit, OnDestroy {
    @Input() sessionId?: string
    @ViewChild('inputTextarea') inputTextarea?: ElementRef<HTMLTextAreaElement>

    @HostBinding('class.pilot-tab') true

    messages: ChatMessage[] = []
    currentSessionId: string = ''
    inputText: string = ''
    isLoading: boolean = false
    currentMessageParts: MessagePart[] = [] // 当前正在构建的消息片段
    pendingToolExecutions: ToolExecution[] = []
    error: string | null = null
    currentProvider: PilotProviderType = 'anthropic'

    private destroy$ = new Subject<void>()
    private currentMessageId: string = ''
    private abortController: AbortController | null = null

    constructor(
        injector: Injector,
        private ai: PilotAIService,
        private session: SessionService,
    ) {
        super(injector)
    }

    ngOnInit(): void {
        // 优先使用传入的 sessionId
        if (this.sessionId) {
            const session = this.session.getSession(this.sessionId)
            if (session) {
                this.currentSessionId = this.sessionId
                this.currentProvider = session.provider || 'anthropic'
                // 深拷贝消息数组，并去重（基于消息 id）
                const messageMap = new Map<string, ChatMessage>()
                session.messages.forEach(msg => {
                    if (!messageMap.has(msg.id)) {
                        messageMap.set(msg.id, { 
                            ...msg,
                            parts: msg.parts ? [...msg.parts] : undefined 
                        })
                    }
                })
                this.messages = Array.from(messageMap.values())
            } else {
                // Session 不存在，创建新的
                const newSession = this.session.createSession()
                this.currentSessionId = newSession.id
                this.sessionId = newSession.id
                this.currentProvider = newSession.provider || 'anthropic'
            }
        }

        // 如果还没有 session，创建新的
        if (!this.currentSessionId) {
            const newSession = this.session.createSession()
            this.currentSessionId = newSession.id
            this.sessionId = newSession.id
            this.currentProvider = newSession.provider || 'anthropic'
        }

        this.setTitle('Pilot Chat')
    }

    ngOnDestroy(): void {
        this.destroy$.next()
        this.destroy$.complete()
    }

    focusInput(): void {
        setTimeout(() => {
            this.inputTextarea?.nativeElement.focus()
        }, 100)
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

    handleEnterKey(event: KeyboardEvent): void {
        // Shift+Enter: 允许换行，不做处理
        if (event.shiftKey) {
            return
        }
        
        // Enter: 发送消息
        event.preventDefault()
        this.sendMessage()
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
        this.abortController = new AbortController()

        this.currentMessageId = this.generateId()
        this.currentMessageParts = []

        try {
            const aiMessages = this.messages.map(msg => ({
                role: msg.role,
                content: msg.content,
            }))

            // 获取终端引用
            const terminalTab = this.getTerminalTab()

            const stream = this.ai.chat(aiMessages, async (toolCall) => {
                return await this.handleToolCall(toolCall)
            }, terminalTab, this.currentProvider)

            let currentTextBuffer = '' // 累积当前文本片段

            for await (const chunk of stream) {
                // 检查是否被中断
                if (this.abortController?.signal.aborted) {
                    break
                }
                
                if (chunk.type === 'text-delta') {
                    currentTextBuffer += chunk.textDelta
                } else if (chunk.type === 'tool-call') {
                    console.log('Tool call:', chunk)
                    
                    // 工具调用前，先保存当前累积的文本
                    if (currentTextBuffer.trim()) {
                        this.currentMessageParts.push({
                            type: 'text',
                            text: currentTextBuffer,
                        })
                        currentTextBuffer = ''
                    }
                    
                    // 添加工具调用片段
                    const toolCall: ToolCall = {
                        id: chunk.toolCallId || this.generateId(),
                        type: 'tool-call',
                        toolName: chunk.toolName || '',
                        args: chunk.args || {},
                        status: 'pending',
                    }
                    this.currentMessageParts.push({
                        type: 'tool-call',
                        toolCall,
                    })
                } else if (chunk.type === 'tool-result') {
                    console.log('Tool result:', chunk)
                } else if (chunk.type === 'finish') {
                    break
                }
            }

            // 保存最后的文本片段
            if (currentTextBuffer.trim()) {
                this.currentMessageParts.push({
                    type: 'text',
                    text: currentTextBuffer,
                })
            }

            if (this.currentMessageParts.length > 0) {
                // 生成 content 字符串（所有文本片段的拼接）
                const contentText = this.currentMessageParts
                    .filter(p => p.type === 'text')
                    .map(p => p.text)
                    .join('')

                const assistantMessage: ChatMessage = {
                    id: this.currentMessageId,
                    role: 'assistant',
                    content: contentText.trim(),
                    parts: this.currentMessageParts,
                    timestamp: Date.now(),
                }
                this.messages.push(assistantMessage)
                this.session.addMessage(this.currentSessionId, assistantMessage)
            }

        } catch (error: any) {
            console.error('Error in chat:', error)
            if (error.name !== 'AbortError') {
                this.error = error.message || 'An error occurred'
            }
        } finally {
            this.isLoading = false
            this.abortController = null
            this.currentMessageParts = []
            this.currentMessageId = ''
        }
    }

    async handleToolCall(toolCall: any): Promise<boolean> {
        return new Promise((resolve) => {
            // 使用 AI SDK 提供的 toolCallId 作为唯一标识
            const execution: ToolExecution = {
                id: toolCall.toolCallId,
                toolName: toolCall.toolName,
                parameters: toolCall.args,
                status: 'pending',
                resolveCallback: resolve,
            }

            this.pendingToolExecutions.push(execution)
        })
    }

    approveToolCall(toolCall: ToolCall): void {
        toolCall.status = 'approved'
        
        // 查找对应的 execution 并调用回调
        const execution = this.pendingToolExecutions.find(e => e.id === toolCall.id)
        if (execution && execution.resolveCallback) {
            execution.resolveCallback(true)
            this.pendingToolExecutions = this.pendingToolExecutions.filter(e => e.id !== execution.id)
        }
        
        // 更新会话存储
        this.updateToolCallInParts(toolCall)
    }

    rejectToolCall(toolCall: ToolCall): void {
        toolCall.status = 'rejected'
        
        // 查找对应的 execution 并调用回调
        const execution = this.pendingToolExecutions.find(e => e.id === toolCall.id)
        if (execution && execution.resolveCallback) {
            execution.resolveCallback(false)
            this.pendingToolExecutions = this.pendingToolExecutions.filter(e => e.id !== execution.id)
        }
        
        // 更新会话存储
        this.updateToolCallInParts(toolCall)
    }

    private updateToolCallInParts(toolCall: ToolCall): void {
        // 更新当前正在构建的消息片段
        for (const part of this.currentMessageParts) {
            if (part.type === 'tool-call' && part.toolCall?.id === toolCall.id) {
                part.toolCall = toolCall
                return
            }
        }
        
        // 更新已保存消息中的 toolCall
        for (const message of this.messages) {
            if (message.parts) {
                for (const part of message.parts) {
                    if (part.type === 'tool-call' && part.toolCall?.id === toolCall.id) {
                        part.toolCall = toolCall
                        this.session.updateMessage(this.currentSessionId, message)
                        return
                    }
                }
            }
        }
    }

    newChat(): void {
        const newSession = this.session.createSession()
        this.currentSessionId = newSession.id
        this.sessionId = newSession.id
        this.currentProvider = newSession.provider || 'anthropic'
        this.messages = []
        this.error = null
        this.recoveryStateChangedHint.next()
    }

    clearChat(): void {
        this.session.clearSession(this.currentSessionId)
        this.messages = []
        this.error = null
    }

    closeSidebar(): void {
        // 在关闭前，将 sessionId 保存到 parent SplitTab 上，以便下次打开时恢复
        if (this.parent && this.currentSessionId) {
            (this.parent as any).__pilotSessionId = this.currentSessionId;
        }
        this.destroy()
    }

    stopResponse(): void {
        if (this.abortController) {
            this.abortController.abort()
        }
    }

    private generateId(): string {
        return `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    }

    get providerLabel(): string {
        if (this.currentProvider === 'openai-responses') {
            return 'OpenAI Responses'
        }
        if (this.currentProvider === 'openai-chat') {
            return 'OpenAI Chat'
        }
        return 'Anthropic'
    }

    /**
     * 实现 Tab Recovery: 序列化标签状态以便 Tabby 重启后恢复
     */
    async getRecoveryToken(): Promise<RecoveryToken> {
        return {
            type: 'app:pilot-chat',
            sessionId: this.currentSessionId || this.sessionId,
        }
    }
}
