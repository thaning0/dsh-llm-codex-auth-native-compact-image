const DEFAULT_CACHE_MS = 60_000

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function normalizeWindow(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const rawUsed = finiteNumber(value.used_percent)
  if (rawUsed === undefined) return undefined
  const usedPercent = Math.min(100, Math.max(0, rawUsed))
  const remainingPercent = Math.round((100 - usedPercent) * 10) / 10
  const resetAt = finiteNumber(value.reset_at)
  const windowSeconds = finiteNumber(value.limit_window_seconds)
  return Object.freeze({
    usedPercent,
    remainingPercent,
    ...(resetAt === undefined ? {} : { resetAt }),
    ...(windowSeconds === undefined ? {} : { windowSeconds }),
  })
}

/** Convert the undocumented WHAM response into a small, token-free public shape. */
export function normalizeSubscriptionUsage(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('Codex usage response must be an object')
  }
  const rateLimit = payload.rate_limit
  const primary = normalizeWindow(rateLimit?.primary_window)
  const secondary = normalizeWindow(rateLimit?.secondary_window)
  if (primary === undefined && secondary === undefined) {
    throw new TypeError('Codex usage response contains no rate-limit windows')
  }
  const planType = typeof payload.plan_type === 'string' && payload.plan_type.length > 0
    ? payload.plan_type
    : undefined
  return Object.freeze({
    ...(planType === undefined ? {} : { planType }),
    ...(primary === undefined ? {} : { primary }),
    ...(secondary === undefined ? {} : { secondary }),
  })
}

function windowLabel(window, fallback) {
  const seconds = window?.windowSeconds
  if (seconds === undefined) return fallback
  if (seconds % 86_400 === 0) return `${seconds / 86_400} 天`
  if (seconds % 3_600 === 0) return `${seconds / 3_600} 小时`
  return fallback
}

function percentText(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

/** Human-readable Chinese summary used by /codex-usage. */
export function formatSubscriptionUsage(usage) {
  const windows = [
    usage.primary === undefined ? undefined : `${windowLabel(usage.primary, '短周期')}剩余 ${percentText(usage.primary.remainingPercent)}%`,
    usage.secondary === undefined ? undefined : `${windowLabel(usage.secondary, '长周期')}剩余 ${percentText(usage.secondary.remainingPercent)}%`,
  ].filter(Boolean)
  const plan = usage.planType === undefined ? '' : `（${usage.planType}）`
  return `Codex 订阅用量${plan}：${windows.join('；')}。`
}

/** Short-lived cache shared by the settings page and conversation command. */
export class CodexUsageService {
  #transport
  #cacheMs
  #cached
  #pending

  constructor(transport, options = {}) {
    this.#transport = transport
    this.#cacheMs = options.cacheMs ?? DEFAULT_CACHE_MS
  }

  async get(options = {}) {
    const force = options.force === true
    if (!force && this.#cached !== undefined && Date.now() - this.#cached.updatedAt < this.#cacheMs) {
      return this.#cached
    }
    if (this.#pending !== undefined) return this.#pending
    this.#pending = this.#transport.fetchSubscriptionUsage(options)
      .then((usage) => Object.freeze({ ...usage, updatedAt: Date.now() }))
      .then((usage) => {
        this.#cached = usage
        return usage
      })
      .finally(() => {
        this.#pending = undefined
      })
    return this.#pending
  }

  clear() {
    this.#cached = undefined
  }
}
