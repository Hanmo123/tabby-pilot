export type PilotProviderType = 'anthropic' | 'openai-responses' | 'openai-chat'

export interface ProviderConfig {
    apiKey: string
    baseURL?: string
    model: string
}

export interface PilotConfig {
    provider: PilotProviderType
    providers: {
        anthropic: ProviderConfig
        openaiResponses: ProviderConfig
        openaiChat: ProviderConfig
    }
    maxTokens: number
    sessions: ChatSession[]
}

export interface ChatSession {
    id: string
    title: string
    createdAt: number
    updatedAt: number
    messages: ChatMessage[]
    provider?: PilotProviderType
    workingDirectory?: string
}

export interface ChatMessage {
    id: string
    role: 'user' | 'assistant'
    content: string
    parts?: MessagePart[] // 消息的各个部分，按时间顺序排列
    timestamp: number
}

export interface MessagePart {
    type: 'text' | 'tool-call'
    text?: string // 当 type === 'text'
    toolCall?: ToolCall // 当 type === 'tool-call'
}

export interface ToolCall {
    id: string
    type: 'tool-call'
    toolName: string
    args: any
    status: 'pending' | 'approved' | 'rejected' | 'executing' | 'completed' | 'error'
    result?: any
    error?: string
}

export interface ToolExecution {
    id: string
    toolName: string
    parameters: any
    status: 'pending' | 'approved' | 'rejected' | 'executing' | 'completed' | 'error'
    result?: any
    error?: string
    resolveCallback?: (approved: boolean) => void
}

export interface StreamChunk {
    type: 'text-delta' | 'tool-call' | 'tool-result' | 'error' | 'finish'
    textDelta?: string
    toolCall?: ToolCall
    toolResult?: any
    error?: string
}
