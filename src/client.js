/**
 * Browser half: a settings-page section with login/logout controls and
 * sanitized ChatGPT subscription usage. OAuth material always stays host-side.
 *
 * @module dsh-llm-codex-auth-native-compact-image/client
 */
import { createElement as h, useCallback, useEffect, useState } from 'react'

const SECTION_ID = 'codex-oauth'

async function responseJson(response) {
  const payload = await response.json()
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error ?? `HTTP ${response.status}`)
  }
  return payload
}

function percentText(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function windowLabel(window, fallback) {
  const seconds = window?.windowSeconds
  if (typeof seconds !== 'number') return fallback
  if (seconds % 86_400 === 0) return `${seconds / 86_400} 天窗口`
  if (seconds % 3_600 === 0) return `${seconds / 3_600} 小时窗口`
  return fallback
}

function resetText(resetAt) {
  return typeof resetAt === 'number'
    ? `重置：${new Date(resetAt * 1000).toLocaleString()}`
    : '重置时间未知'
}

function UsageWindow({ title, window }) {
  if (window === undefined) return null
  const remaining = Math.min(100, Math.max(0, window.remainingPercent))
  const color = remaining > 50 ? '#22c55e' : remaining > 20 ? '#f59e0b' : '#ef4444'
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '12px' } },
      h('span', null, windowLabel(window, title)),
      h('strong', null, `剩余 ${percentText(remaining)}%`),
    ),
    h('div', {
      role: 'progressbar',
      'aria-label': `${title}剩余用量`,
      'aria-valuemin': 0,
      'aria-valuemax': 100,
      'aria-valuenow': remaining,
      style: { height: '8px', overflow: 'hidden', borderRadius: '999px', background: 'rgba(127, 127, 127, 0.25)' },
    }, h('div', {
      style: { width: `${remaining}%`, height: '100%', borderRadius: 'inherit', background: color, transition: 'width 160ms ease' },
    })),
    h('small', { style: { opacity: 0.72 } }, resetText(window.resetAt)),
  )
}

function CodexSection() {
  const [data, setData] = useState(null)
  const [usage, setUsage] = useState(null)
  const [usageLoading, setUsageLoading] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setData(await responseJson(await fetch('/codex-oauth/status')))
    } catch (error) {
      setData({ ok: false, statusText: error instanceof Error ? error.message : String(error) })
    }
  }, [])

  const refreshUsage = useCallback(async (force = false) => {
    setUsageLoading(true)
    try {
      const suffix = force ? '?refresh=1' : ''
      setUsage(await responseJson(await fetch(`/codex-oauth/usage${suffix}`)))
    } catch (error) {
      setUsage({ ok: false, error: error instanceof Error ? error.message : String(error) })
    } finally {
      setUsageLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, 3000)
    return () => clearInterval(timer)
  }, [refresh])

  const connected = data?.connected === true
  useEffect(() => {
    if (!connected) {
      setUsage(null)
      return undefined
    }
    refreshUsage()
    const timer = setInterval(refreshUsage, 60_000)
    return () => clearInterval(timer)
  }, [connected, refreshUsage])

  const act = useCallback(async (operation) => {
    try {
      await responseJson(await fetch(`/codex-oauth/${operation}`, { method: 'POST' }))
    } catch {}
    await refresh()
  }, [refresh])

  const statusText = data?.statusText ?? '加载中…'
  const pending = !connected && data?.verificationUrl

  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
    pending
      ? h('p', null,
        '请打开 ',
        h('a', { href: data.verificationUrl, target: '_blank', rel: 'noreferrer' }, data.verificationUrl),
        '，输入设备码 ',
        h('b', null, data.userCode),
      )
      : h('p', null, statusText),
    connected
      ? h('button', { type: 'button', onClick: () => act('logout') }, '登出')
      : h('button', { type: 'button', onClick: () => act('login') }, '登录 ChatGPT 账号'),
    connected && data?.expiresAt
      ? h('p', null, 'access token 到期：', new Date(data.expiresAt).toLocaleString())
      : null,
    connected
      ? h('section', { style: { display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '4px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' } },
          h('strong', null, `订阅用量${usage?.planType ? `（${usage.planType}）` : ''}`),
          h('button', {
            type: 'button',
            disabled: usageLoading,
            onClick: () => refreshUsage(true),
          }, usageLoading ? '刷新中…' : '刷新用量'),
        ),
        usage === null
          ? h('p', null, '正在加载订阅用量…')
          : usage.ok === false
            ? h('p', { style: { color: '#ef4444' } }, `用量查询失败：${usage.error}`)
            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
              h(UsageWindow, { title: '短周期', window: usage.primary }),
              h(UsageWindow, { title: '长周期', window: usage.secondary }),
              usage.updatedAt
                ? h('small', { style: { opacity: 0.72 } }, `更新时间：${new Date(usage.updatedAt).toLocaleString()}`)
                : null,
            ),
      )
      : null,
  )
}

export const name = 'dsh-llm-codex-auth-native-compact-image'
export const inject = ['slots']

export function apply(ctx) {
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: SECTION_ID,
    order: 100,
    label: 'Codex 订阅 (ChatGPT)',
  }, CodexSection))
}
