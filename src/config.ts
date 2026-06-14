import { ConfigProvider, Platform } from 'tabby-core'

export class PilotConfigProvider extends ConfigProvider {
    defaults = {
        pilot: {
            provider: 'anthropic',
            providers: {
                anthropic: {
                    apiKey: '',
                    baseURL: '',
                    model: '',
                },
                openaiResponses: {
                    apiKey: '',
                    baseURL: '',
                    model: '',
                },
                openaiChat: {
                    apiKey: '',
                    baseURL: '',
                    model: '',
                },
            },
            maxTokens: 4096,
            temperature: 0.7,
            sessions: [],
        },
        hotkeys: {
            'pilot-open-chat': [],
        },
    }

    platformDefaults = {
        [Platform.macOS]: {
            hotkeys: {
                'pilot-open-chat': ['⌘-Shift-C'],
            },
        },
        [Platform.Windows]: {
            hotkeys: {
                'pilot-open-chat': ['Ctrl-Shift-C'],
            },
        },
        [Platform.Linux]: {
            hotkeys: {
                'pilot-open-chat': ['Ctrl-Shift-C'],
            },
        },
    }
}
