/**
 * Login/session state. The session itself is an httpOnly cookie set by
 * upload-api's /login — this store just tracks who (if anyone) it belongs to.
 * No token is ever held here; a plain fetch() already carries the cookie
 * since everything is same-origin (see nginx.conf).
 */
import { create } from 'zustand'

export const USERS_URL = '/users'
export const ETL_URL = '/etl/run'
export const ETL_JOBS_URL = '/etl/jobs'

export interface AuthUser {
  username: string
  role: 'admin' | 'viewer'
  premium: boolean
}

interface AuthState {
  user: AuthUser | null
  loading: boolean
  error: string | null
  /** Username of whoever just logged out — lets App show a goodbye splash
   * before falling back to the login screen. Cleared once that's shown. */
  farewell: string | null
  fetchMe: () => Promise<void>
  login: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
  clearFarewell: () => void
}

export const useAuth = create<AuthState>((set, get) => ({
  user: null,
  loading: true,
  error: null,
  farewell: null,

  fetchMe: async () => {
    try {
      const res = await fetch('/auth/me')
      set({ user: res.ok ? await res.json() : null, loading: false })
    } catch {
      set({ user: null, loading: false })
    }
  },

  login: async (username, password) => {
    set({ error: null })
    try {
      const res = await fetch('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        set({ error: body?.detail ?? `Anmeldung fehlgeschlagen: HTTP ${res.status}` })
        return
      }
      set({ user: body, error: null })
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
    }
  },

  logout: async () => {
    const name = get().user?.username ?? null
    await fetch('/logout', { method: 'POST' })
    set({ user: null, farewell: name })
  },

  clearFarewell: () => set({ farewell: null }),
}))
