/**
 * Login/session state. The session itself is an httpOnly cookie set by
 * upload-api's /login, /guest-session or /register (paid tiers land here
 * only after PayPal confirms — see App.tsx's return-redirect handling) —
 * this store just tracks who (if anyone) it belongs to. No token is ever
 * held here; a plain fetch() already carries the cookie since everything is
 * same-origin (see nginx.conf).
 */
import { create } from 'zustand'

export const USERS_URL = '/users'
export const ETL_URL = '/etl/run'
export const ETL_JOBS_URL = '/etl/jobs'
export const GUEST_SESSION_URL = '/guest-session'
export const REGISTER_URL = '/register'
export const SUBSCRIPTION_CANCEL_URL = '/subscription/cancel'

export type Tier = 'guest' | 'free' | 'pro' | 'premium'
/** Numeric rank so "does this user meet tier X" is one comparison —
 * mirrors upload-api/app.py's TIER_RANK exactly, keep the two in sync. */
export const TIER_RANK: Record<Tier, number> = { guest: 0, free: 1, pro: 2, premium: 3 }

export function meetsTier(userTier: Tier | undefined, min: Tier): boolean {
  return TIER_RANK[userTier ?? 'guest'] >= TIER_RANK[min]
}

export type Role = 'admin' | 'editor' | 'viewer'

export interface AuthUser {
  username: string
  role: Role
  tier: Tier
}

/**
 * Admin or editor — full analysis/editing capability regardless of
 * subscription_tier (mirrors upload-api/app.py's is_privileged_role()
 * exactly). Deliberately NOT what gates the strictly-admin-only UI (user
 * accounts, groups/grants) — those stay `role === 'admin'` checks, since
 * editor is explicitly blocked from those on the backend too.
 */
export function isPrivileged(user: AuthUser | null | undefined): boolean {
  return user?.role === 'admin' || user?.role === 'editor'
}

/** Meets a tier requirement, with admin/editor bypassing it entirely — the
 * one function every tier-gated UI control (Dashboard, Upload,
 * Geoprocessing, ETL, AI) should check, so "editor" never has to be
 * special-cased at each call site. */
export function hasFullAccess(user: AuthUser | null | undefined, min: Tier): boolean {
  return isPrivileged(user) || meetsTier(user?.tier, min)
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
  continueAsGuest: () => Promise<void>
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

  continueAsGuest: async () => {
    set({ error: null })
    try {
      const res = await fetch(GUEST_SESSION_URL, { method: 'POST' })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        set({ error: body?.detail ?? `HTTP ${res.status}` })
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
