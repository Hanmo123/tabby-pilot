import { Injectable } from '@angular/core'
import { ConfigService } from 'tabby-core'
import { ChatSession, ChatMessage, PilotProviderType } from '../api/interfaces'

@Injectable({ providedIn: 'root' })
export class SessionService {
    private currentSessionId: string | null = null

    constructor(
        private config: ConfigService,
    ) {}

    createSession(workingDirectory?: string, provider?: PilotProviderType): ChatSession {
        const session: ChatSession = {
            id: this.generateId(),
            title: 'New Chat',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messages: [],
            provider: provider || this.config.store.pilot.provider || 'anthropic',
            workingDirectory,
        }

        this.getSessions().push(session)
        this.save()
        this.currentSessionId = session.id

        return session
    }

    getSession(id: string): ChatSession | undefined {
        return this.getSessions().find(s => s.id === id)
    }

    getCurrentSession(): ChatSession | null {
        if (!this.currentSessionId) {
            return null
        }
        return this.getSession(this.currentSessionId) || null
    }

    setCurrentSession(id: string): void {
        this.currentSessionId = id
    }

    getSessions(): ChatSession[] {
        if (!this.config.store.pilot.sessions) {
            this.config.store.pilot.sessions = []
        }
        return this.config.store.pilot.sessions
    }

    updateSession(id: string, updates: Partial<ChatSession>): void {
        const sessions = this.getSessions()
        const index = sessions.findIndex(s => s.id === id)
        
        if (index !== -1) {
            sessions[index] = {
                ...sessions[index],
                ...updates,
                updatedAt: Date.now(),
            }
            this.save()
        }
    }

    addMessage(sessionId: string, message: ChatMessage): void {
        const session = this.getSession(sessionId)
        if (session) {
            session.messages.push(message)
            session.updatedAt = Date.now()
            
            if (session.title === 'New Chat' && message.role === 'user') {
                session.title = this.generateTitle(message.content)
            }
            
            this.save()
        }
    }

    updateMessage(sessionId: string, message: ChatMessage): void {
        const session = this.getSession(sessionId)
        if (session) {
            const index = session.messages.findIndex(m => m.id === message.id)
            if (index !== -1) {
                session.messages[index] = message
                session.updatedAt = Date.now()
                this.save()
            }
        }
    }

    deleteSession(id: string): void {
        const sessions = this.getSessions()
        const index = sessions.findIndex(s => s.id === id)
        
        if (index !== -1) {
            sessions.splice(index, 1)
            this.save()
            
            if (this.currentSessionId === id) {
                this.currentSessionId = sessions.length > 0 ? sessions[0].id : null
            }
        }
    }

    clearSession(id: string): void {
        const session = this.getSession(id)
        if (session) {
            session.messages = []
            session.updatedAt = Date.now()
            this.save()
        }
    }

    private save(): void {
        this.config.save()
    }

    private generateId(): string {
        return `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    }

    private generateTitle(content: string): string {
        const title = content.substring(0, 50).trim()
        return title.length < content.length ? `${title}...` : title
    }
}
