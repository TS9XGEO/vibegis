/**
 * The AI Agent chat panel's state. Session-only, never persisted to
 * localStorage — same convention as panels.ts/uploadState.ts for ephemeral
 * UI state (frontend-app/CLAUDE.md), and doubly so here: nothing about a
 * chat with an LLM, or the fact a key is configured, should survive past a
 * reload on its own.
 */
import { create } from 'zustand'

import type { FilterCondition, FilterLogic } from './filter'
import { useApp } from './wms'

export const AI_CHAT_URL = '/ai/chat'
export const AI_SETTINGS_KEY_URL = '/ai/settings/key'
export const AI_EXECUTE_ACTION_URL = '/ai/execute-action'

export interface AiChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/** A map-control action the backend's tool loop asked the frontend to apply. */
export type AiAction =
  | { type: 'zoomToLayer'; layerName: string }
  | { type: 'setLayerVisibility'; layerName: string; visible: boolean }
  | { type: 'filterLayer'; layerName: string; logic: FilterLogic; conditions: FilterCondition[] }

export interface AiPendingAction {
  token: string
  kind: 'geoprocess' | 'etl_run'
  summary: string
}

interface AiAgentState {
  open: boolean
  messages: AiChatMessage[]
  pendingAction: AiPendingAction | null
  sending: boolean
  confirming: boolean
  error: string | null

  toggle: () => void
  sendMessage: (text: string) => Promise<void>
  confirmPendingAction: () => Promise<void>
  dismissPendingAction: () => void
  reset: () => void
}

function applyAction(action: AiAction) {
  const app = useApp.getState()
  if (action.type === 'zoomToLayer') {
    app.zoomToLayer(action.layerName)
  } else if (action.type === 'setLayerVisibility') {
    app.setLayerVisible(action.layerName, action.visible)
  } else if (action.type === 'filterLayer') {
    app.setAttributeFilter(action.layerName, { logic: action.logic, conditions: action.conditions })
  }
}

export const useAiAgent = create<AiAgentState>((set, get) => ({
  open: false,
  messages: [],
  pendingAction: null,
  sending: false,
  confirming: false,
  error: null,

  toggle: () => set((s) => ({ open: !s.open })),

  sendMessage: async (text) => {
    const trimmed = text.trim()
    if (!trimmed || get().sending) return
    const messages = [...get().messages, { role: 'user', content: trimmed } as AiChatMessage]
    set({ messages, sending: true, error: null })

    try {
      const res = await fetch(AI_CHAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, layers: useApp.getState().layers }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) throw new Error(body?.detail ?? `HTTP ${res.status}`)

      for (const action of (body.actions ?? []) as AiAction[]) applyAction(action)

      set((s) => ({
        messages: [...s.messages, { role: 'assistant', content: body.reply ?? '' }],
        pendingAction: body.pendingAction ?? null,
        sending: false,
      }))
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e), sending: false })
    }
  },

  confirmPendingAction: async () => {
    const pending = get().pendingAction
    if (!pending || get().confirming) return
    set({ confirming: true, error: null })
    try {
      const res = await fetch(AI_EXECUTE_ACTION_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: pending.token }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) throw new Error(body?.detail ?? `HTTP ${res.status}`)

      set((s) => ({
        messages: [...s.messages, { role: 'assistant', content: `Erledigt: ${pending.summary}` }],
        pendingAction: null,
        confirming: false,
      }))
      await useApp.getState().load()
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e), confirming: false })
    }
  },

  dismissPendingAction: () => set({ pendingAction: null }),

  reset: () => set({ messages: [], pendingAction: null, error: null, sending: false, confirming: false }),
}))
