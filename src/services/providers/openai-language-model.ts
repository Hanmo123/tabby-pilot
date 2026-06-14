import {
    LanguageModelV1,
    LanguageModelV1CallOptions,
    LanguageModelV1StreamPart,
} from 'ai'
import { LanguageModelV1FinishReason, LanguageModelV1FunctionTool, LanguageModelV1Prompt } from '@ai-sdk/provider'

interface OpenAIModelSettings {
    apiKey: string
    baseURL?: string
    model: string
}

interface OpenAIToolCall {
    id: string
    name: string
    args: string
}

interface SSEEvent {
    event?: string
    data: string
}

export function createOpenAIChatModel(settings: OpenAIModelSettings): LanguageModelV1 {
    return new OpenAIChatLanguageModel(settings)
}

export function createOpenAIResponsesModel(settings: OpenAIModelSettings): LanguageModelV1 {
    return new OpenAIResponsesLanguageModel(settings)
}

abstract class OpenAIBaseLanguageModel implements LanguageModelV1 {
    readonly specificationVersion = 'v1' as const
    readonly defaultObjectGenerationMode = undefined
    readonly supportsStructuredOutputs = true

    constructor(protected settings: OpenAIModelSettings) {}

    get modelId(): string {
        return this.settings.model
    }

    abstract readonly provider: string
    abstract doStream(options: LanguageModelV1CallOptions): Promise<{
        stream: ReadableStream<LanguageModelV1StreamPart>
        rawCall: { rawPrompt: unknown; rawSettings: Record<string, unknown> }
        request?: { body?: string }
        warnings?: any[]
    }>

    async doGenerate(options: LanguageModelV1CallOptions): Promise<any> {
        const result = await this.doStream(options)
        const reader = result.stream.getReader()
        let text = ''
        let finishReason: LanguageModelV1FinishReason = 'unknown'
        let promptTokens = 0
        let completionTokens = 0
        const toolCalls: any[] = []

        while (true) {
            const { done, value } = await reader.read()
            if (done) {
                break
            }
            if (value.type === 'text-delta') {
                text += value.textDelta
            } else if (value.type === 'tool-call') {
                toolCalls.push(value)
            } else if (value.type === 'finish') {
                finishReason = value.finishReason
                promptTokens = value.usage.promptTokens
                completionTokens = value.usage.completionTokens
            }
        }

        return {
            text,
            toolCalls: toolCalls.length ? toolCalls : undefined,
            finishReason,
            usage: { promptTokens, completionTokens },
            rawCall: result.rawCall,
            request: result.request,
            warnings: result.warnings,
        }
    }

    protected getHeaders(): Record<string, string> {
        return {
            'authorization': `Bearer ${this.settings.apiKey}`,
            'content-type': 'application/json',
        }
    }

    protected getBaseURL(defaultBaseURL: string): string {
        return (this.settings.baseURL || defaultBaseURL).replace(/\/$/, '')
    }

    protected getTools(options: LanguageModelV1CallOptions): LanguageModelV1FunctionTool[] {
        if (options.mode.type !== 'regular' || !options.mode.tools) {
            return []
        }
        return options.mode.tools.filter(tool => tool.type === 'function') as LanguageModelV1FunctionTool[]
    }

    protected getFinishReason(reason?: string): LanguageModelV1FinishReason {
        switch (reason) {
            case 'stop':
            case 'completed':
                return 'stop'
            case 'length':
            case 'max_output_tokens':
                return 'length'
            case 'content_filter':
                return 'content-filter'
            case 'tool_calls':
            case 'function_call':
                return 'tool-calls'
            default:
                return 'unknown'
        }
    }

    protected normalizeError(error: any): Error {
        return new Error(error?.error?.message || error?.message || 'OpenAI API request failed')
    }
}

class OpenAIChatLanguageModel extends OpenAIBaseLanguageModel {
    readonly provider = 'openai.chat'

    async doStream(options: LanguageModelV1CallOptions): Promise<any> {
        const body = this.buildRequestBody(options)
        const bodyText = JSON.stringify(body)
        const response = await fetch(`${this.getBaseURL('https://api.openai.com')}/v1/chat/completions`, {
            method: 'POST',
            headers: this.getHeaders(),
            body: bodyText,
            signal: options.abortSignal,
        })

        if (!response.ok || !response.body) {
            throw this.normalizeError(await response.json().catch(() => ({ message: response.statusText })))
        }

        return {
            stream: this.parseChatStream(response.body),
            rawCall: { rawPrompt: body.messages, rawSettings: body },
            request: { body: bodyText },
            warnings: [],
        }
    }

    private buildRequestBody(options: LanguageModelV1CallOptions): any {
        const tools = this.getTools(options)
        const body: any = {
            model: this.settings.model,
            messages: this.toChatMessages(options.prompt),
            stream: true,
            stream_options: { include_usage: true },
        }

        if (options.maxTokens !== undefined) {
            body.max_tokens = options.maxTokens
        }
        if (tools.length) {
            body.tools = tools.map(tool => ({
                type: 'function',
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters,
                },
            }))
            body.tool_choice = this.toToolChoice(options)
        }

        return body
    }

    private toChatMessages(prompt: LanguageModelV1Prompt): any[] {
        const messages = prompt.map(message => {
            if (message.role === 'system') {
                return { role: 'system', content: message.content }
            }
            if (message.role === 'user') {
                return { role: 'user', content: this.textFromParts(message.content) }
            }
            if (message.role === 'tool') {
                return message.content.map(part => ({
                    role: 'tool',
                    tool_call_id: part.toolCallId,
                    content: this.stringify(part.result),
                }))
            }

            const toolCalls = message.content
                .filter((part): part is any => part.type === 'tool-call')
                .map(part => ({
                    id: part.toolCallId,
                    type: 'function',
                    function: {
                        name: part.toolName,
                        arguments: this.stringify(part.args),
                    },
                }))

            return {
                role: 'assistant',
                content: this.textFromParts(message.content as any) || null,
                ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
            }
        })

        return messages.reduce((result: any[], message) => result.concat(message), [])
    }

    private parseChatStream(body: ReadableStream<Uint8Array>): ReadableStream<LanguageModelV1StreamPart> {
        const toolCalls: Record<string, OpenAIToolCall> = {}

        return parseSSEStream(body, sseEvent => {
            if (sseEvent.data === '[DONE]') {
                return []
            }

            const chunk = JSON.parse(sseEvent.data)
            const parts: LanguageModelV1StreamPart[] = []
            const choice = chunk.choices?.[0]

            if (chunk.id) {
                parts.push({ type: 'response-metadata', id: chunk.id, modelId: chunk.model })
            }
            if (choice?.delta?.content) {
                parts.push({ type: 'text-delta', textDelta: choice.delta.content })
            }

            for (const toolCall of choice?.delta?.tool_calls || []) {
                const index = toolCall.index || 0
                const current = toolCalls[index] || { id: '', name: '', args: '' }
                current.id = toolCall.id || current.id
                current.name = toolCall.function?.name || current.name
                current.args += toolCall.function?.arguments || ''
                toolCalls[index] = current
            }

            if (choice?.finish_reason) {
                Object.keys(toolCalls).forEach(index => {
                    const toolCall = toolCalls[index]
                    if (toolCall?.id && toolCall.name) {
                        parts.push({
                            type: 'tool-call',
                            toolCallType: 'function',
                            toolCallId: toolCall.id,
                            toolName: toolCall.name,
                            args: toolCall.args || '{}',
                        })
                    }
                })
                parts.push({
                    type: 'finish',
                    finishReason: this.getFinishReason(choice.finish_reason),
                    usage: {
                        promptTokens: chunk.usage?.prompt_tokens || 0,
                        completionTokens: chunk.usage?.completion_tokens || 0,
                    },
                })
            }

            return parts
        })
    }

    private toToolChoice(options: LanguageModelV1CallOptions): any {
        if (options.mode.type !== 'regular' || !options.mode.toolChoice) {
            return 'auto'
        }
        if (options.mode.toolChoice.type === 'tool') {
            return { type: 'function', function: { name: options.mode.toolChoice.toolName } }
        }
        return options.mode.toolChoice.type
    }

    private textFromParts(parts: any[]): string {
        return parts.filter(part => part.type === 'text').map(part => part.text).join('')
    }

    private stringify(value: unknown): string {
        return typeof value === 'string' ? value : JSON.stringify(value)
    }
}

class OpenAIResponsesLanguageModel extends OpenAIBaseLanguageModel {
    readonly provider = 'openai.responses'

    async doStream(options: LanguageModelV1CallOptions): Promise<any> {
        const body = this.buildRequestBody(options)
        const bodyText = JSON.stringify(body)
        const url = `${this.getBaseURL('https://api.openai.com')}/v1/responses`

        const response = await fetch(url, {
            method: 'POST',
            headers: this.getHeaders(),
            body: bodyText,
            signal: options.abortSignal,
        })

        if (!response.ok) {
            const errorText = await response.text()
            throw this.normalizeError(this.parseJson(errorText) || { message: response.statusText })
        }

        const responseText = await response.text()
        const responseBody = this.parseJson(responseText)
        if (!responseBody) {
            throw new Error(`Unable to parse OpenAI Responses API JSON response: ${this.truncate(responseText)}`)
        }

        return {
            stream: this.toLanguageModelStream(responseBody),
            rawCall: { rawPrompt: body.input, rawSettings: body },
            request: { body: bodyText },
            warnings: [],
        }
    }

    private buildRequestBody(options: LanguageModelV1CallOptions): any {
        const tools = this.getTools(options)
        const body: any = {
            model: this.settings.model,
            input: this.toResponsesInput(options.prompt),
        }
        const instructions = this.getInstructions(options.prompt)

        if (instructions) {
            body.instructions = instructions
        }
        if (options.maxTokens !== undefined) {
            body.max_output_tokens = options.maxTokens
        }
        if (tools.length) {
            body.tools = tools.map(tool => ({
                type: 'function',
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
            }))
            body.tool_choice = this.toToolChoice(options)
        }

        return body
    }

    private toResponsesInput(prompt: LanguageModelV1Prompt): any[] {
        const input: any[] = []

        prompt.forEach(message => {
            if (message.role === 'system') {
                input.push({ role: 'system', content: message.content })
                return
            }
            if (message.role === 'user') {
                input.push({
                    role: 'user',
                    content: this.toResponsesInputContent(message.content),
                })
                return
            }
            if (message.role === 'tool') {
                message.content.forEach(part => {
                    input.push({
                        type: 'function_call_output',
                        call_id: part.toolCallId,
                        output: this.stringify(part.result),
                    })
                })
                return
            }

            const text = this.textFromParts(message.content as any)
            if (text) {
                input.push({
                    role: 'assistant',
                    content: [{ type: 'output_text', text }],
                })
            }
            message.content.filter((part): part is any => part.type === 'tool-call').forEach(part => {
                input.push({
                    type: 'function_call',
                    call_id: part.toolCallId,
                    name: part.toolName,
                    arguments: this.stringify(part.args || {}),
                })
            })
        })

        return input
    }

    private toLanguageModelStream(response: any): ReadableStream<LanguageModelV1StreamPart> {
        const textParts = this.getTextFromResponseOutput(response.output)
        const toolCalls = this.getToolCallsFromResponseOutput(response.output)
        const finishReason = toolCalls.length
            ? 'tool-calls'
            : this.getFinishReason(response.incomplete_details?.reason || response.status)

        return new ReadableStream<LanguageModelV1StreamPart>({
            start: controller => {
                if (response.id) {
                    controller.enqueue({
                        type: 'response-metadata',
                        id: response.id,
                        timestamp: response.created_at ? new Date(response.created_at * 1000) : undefined,
                        modelId: response.model,
                    })
                }

                textParts.forEach(text => {
                    controller.enqueue({ type: 'text-delta', textDelta: text })
                })

                toolCalls.forEach(toolCall => {
                    controller.enqueue({
                        type: 'tool-call',
                        toolCallType: 'function',
                        toolCallId: toolCall.id,
                        toolName: toolCall.name,
                        args: toolCall.args || '{}',
                    })
                })

                if (response.error) {
                    controller.enqueue({ type: 'error', error: response.error })
                }

                controller.enqueue({
                    type: 'finish',
                    finishReason,
                    usage: {
                        promptTokens: response.usage?.input_tokens || 0,
                        completionTokens: response.usage?.output_tokens || 0,
                    },
                })
                controller.close()
            },
        })
    }

    private parseResponsesStream(body: ReadableStream<Uint8Array>): ReadableStream<LanguageModelV1StreamPart> {
        const toolCalls: Record<string, OpenAIToolCall> = {}
        let streamedText = false

        return parseSSEStream(body, sseEvent => {
            if (sseEvent.data === '[DONE]') {
                return []
            }

            const chunk = JSON.parse(sseEvent.data)
            const parts: LanguageModelV1StreamPart[] = []
            const eventType = chunk.type || sseEvent.event

            if (eventType === 'response.created' && chunk.response?.id) {
                parts.push({ type: 'response-metadata', id: chunk.response.id, modelId: chunk.response.model })
            } else if (eventType === 'response.output_text.delta') {
                streamedText = true
                parts.push({ type: 'text-delta', textDelta: chunk.delta || '' })
            } else if (eventType === 'response.function_call_arguments.delta') {
                const callId = chunk.item_id || chunk.call_id || chunk.output_index
                const current = toolCalls[callId] || { id: callId, name: '', args: '' }
                current.args += chunk.delta || ''
                toolCalls[callId] = current
            } else if (eventType === 'response.output_item.done' && chunk.item?.type === 'message') {
                this.getTextFromResponseContent(chunk.item.content).forEach(text => {
                    streamedText = true
                    parts.push({ type: 'text-delta', textDelta: text })
                })
            } else if (eventType === 'response.output_item.done' && chunk.item?.type === 'function_call') {
                const item = chunk.item
                const callId = item.call_id || item.id
                toolCalls[callId] = {
                    id: callId,
                    name: item.name,
                    args: item.arguments || toolCalls[callId]?.args || '{}',
                }
            } else if (eventType === 'response.completed') {
                if (!streamedText) {
                    this.getTextFromResponseOutput(chunk.response?.output).forEach(text => {
                        parts.push({ type: 'text-delta', textDelta: text })
                    })
                }
                this.getToolCallsFromResponseOutput(chunk.response?.output).forEach(toolCall => {
                    toolCalls[toolCall.id] = toolCall
                })
                Object.keys(toolCalls).forEach(callId => {
                    const toolCall = toolCalls[callId]
                    if (toolCall?.name) {
                        parts.push({
                            type: 'tool-call',
                            toolCallType: 'function',
                            toolCallId: toolCall.id,
                            toolName: toolCall.name,
                            args: toolCall.args || '{}',
                        })
                    }
                })
                parts.push({
                    type: 'finish',
                    finishReason: Object.keys(toolCalls).length ? 'tool-calls' : this.getFinishReason(chunk.response?.status),
                    usage: {
                        promptTokens: chunk.response?.usage?.input_tokens || 0,
                        completionTokens: chunk.response?.usage?.output_tokens || 0,
                    },
                })
            } else if (eventType === 'response.failed' || eventType === 'error') {
                parts.push({ type: 'error', error: chunk.response?.error || chunk.error })
            }

            return parts
        })
    }

    private getInstructions(prompt: LanguageModelV1Prompt): string {
        return prompt.filter(message => message.role === 'system').map(message => (message as any).content).join('\n')
    }

    private toToolChoice(options: LanguageModelV1CallOptions): any {
        if (options.mode.type !== 'regular' || !options.mode.toolChoice) {
            return 'auto'
        }
        if (options.mode.toolChoice.type === 'tool') {
            return { type: 'function', name: options.mode.toolChoice.toolName }
        }
        return options.mode.toolChoice.type
    }

    private textFromParts(parts: any[]): string {
        return parts.filter(part => part.type === 'text').map(part => part.text).join('')
    }

    private toResponsesInputContent(parts: any[]): any[] {
        return parts
            .filter(part => part.type === 'text')
            .map(part => ({ type: 'input_text', text: part.text }))
    }

    private getTextFromResponseContent(content: any[]): string[] {
        if (!Array.isArray(content)) {
            return []
        }
        return content
            .filter(part => (part.type === 'output_text' || part.type === 'text') && part.text)
            .map(part => part.text)
    }

    private getTextFromResponseOutput(output: any[]): string[] {
        if (!Array.isArray(output)) {
            return []
        }
        return output
            .filter(part => part.type === 'message')
            .reduce((texts: string[], part) => texts.concat(this.getTextFromResponseContent(part.content)), [])
    }

    private getToolCallsFromResponseOutput(output: any[]): OpenAIToolCall[] {
        if (!Array.isArray(output)) {
            return []
        }
        return output
            .filter(part => part.type === 'function_call')
            .map(part => ({
                id: part.call_id || part.id,
                name: part.name,
                args: part.arguments || '{}',
            }))
    }

    private stringify(value: unknown): string {
        return typeof value === 'string' ? value : JSON.stringify(value)
    }

    private parseJson(text: string): any | null {
        try {
            return JSON.parse(text)
        } catch (_error) {
            return null
        }
    }

    private truncate(text: string): string {
        return text.length > 4000 ? `${text.slice(0, 4000)}... [truncated]` : text
    }

}

function parseSSEStream(
    body: ReadableStream<Uint8Array>,
    parseEvent: (event: SSEEvent) => LanguageModelV1StreamPart[],
): ReadableStream<LanguageModelV1StreamPart> {
    let buffer = ''
    const decoder = new TextDecoder()
    const reader = body.getReader()

    return new ReadableStream<LanguageModelV1StreamPart>({
        async pull(controller) {
            while (true) {
                const boundary = getSSEEventBoundary(buffer)
                if (boundary !== -1) {
                    const rawEvent = buffer.slice(0, boundary)
                    buffer = buffer.slice(getSSEEventEnd(buffer, boundary))
                    const event = parseRawSSEEvent(rawEvent)

                    if (!event.data) {
                        continue
                    }

                    try {
                        parseEvent(event).forEach(part => controller.enqueue(part))
                    } catch (error) {
                        controller.enqueue({ type: 'error', error })
                    }
                    return
                }

                const { done, value } = await reader.read()
                if (done) {
                    const event = parseRawSSEEvent(buffer)
                    if (event.data) {
                        try {
                            parseEvent(event).forEach(part => controller.enqueue(part))
                        } catch (error) {
                            controller.enqueue({ type: 'error', error })
                        }
                    }
                    controller.close()
                    return
                }
                buffer += decoder.decode(value, { stream: true })
            }
        },
        cancel() {
            reader.cancel()
        },
    })
}

function getSSEEventBoundary(buffer: string): number {
    const lineBreaks = ['\r\n\r\n', '\n\n', '\r\r']
    const indexes = lineBreaks
        .map(lineBreak => buffer.indexOf(lineBreak))
        .filter(index => index !== -1)
    return indexes.length ? Math.min(...indexes) : -1
}

function getSSEEventEnd(buffer: string, boundary: number): number {
    if (buffer.slice(boundary, boundary + 4) === '\r\n\r\n') {
        return boundary + 4
    }
    return boundary + 2
}

function parseRawSSEEvent(rawEvent: string): SSEEvent {
    let event: string | undefined
    const data: string[] = []

    rawEvent.split(/\r?\n|\r/).forEach(line => {
        if (line.startsWith('event:')) {
            event = line.slice(6).trim()
        } else if (line.startsWith('data:')) {
            data.push(line.slice(5).trimStart())
        }
    })

    return { event, data: data.join('\n') }
}
