import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CodexUsageService,
  formatSubscriptionUsage,
  normalizeSubscriptionUsage,
} from '../src/usage.js'
import { installServerRoutes } from '../src/server.js'
import { installCommands } from '../src/commands.js'

const RAW_USAGE = {
  plan_type: 'plus',
  rate_limit: {
    primary_window: { used_percent: 6, reset_at: 1_738_300_000, limit_window_seconds: 18_000 },
    secondary_window: { used_percent: 24.5, reset_at: 1_738_900_000, limit_window_seconds: 604_800 },
  },
}

test('normalizes WHAM windows into remaining subscription percentages', () => {
  const usage = normalizeSubscriptionUsage(RAW_USAGE)
  assert.deepEqual(usage, {
    planType: 'plus',
    primary: {
      usedPercent: 6,
      remainingPercent: 94,
      resetAt: 1_738_300_000,
      windowSeconds: 18_000,
    },
    secondary: {
      usedPercent: 24.5,
      remainingPercent: 75.5,
      resetAt: 1_738_900_000,
      windowSeconds: 604_800,
    },
  })
  assert.equal(formatSubscriptionUsage(usage), 'Codex 订阅用量（plus）：5 小时剩余 94%；7 天剩余 75.5%。')
})

test('rejects payloads without usable rate-limit windows', () => {
  assert.throws(() => normalizeSubscriptionUsage({ rate_limit: {} }), /no rate-limit windows/)
  assert.equal(normalizeSubscriptionUsage({
    rate_limit: { primary_window: { used_percent: -5 } },
  }).primary.remainingPercent, 100)
})

test('usage service caches results and supports a forced refresh', async () => {
  let calls = 0
  const service = new CodexUsageService({
    async fetchSubscriptionUsage() {
      calls += 1
      return normalizeSubscriptionUsage(RAW_USAGE)
    },
  }, { cacheMs: 60_000 })

  const first = await service.get()
  const second = await service.get()
  assert.equal(first, second)
  assert.equal(calls, 1)
  await service.get({ force: true })
  assert.equal(calls, 2)
  service.clear()
  await service.get()
  assert.equal(calls, 3)
})

test('/codex-usage reports remaining percentages and logout clears cached usage', async () => {
  const commands = []
  let cleared = 0
  let loggedOut = 0
  const ctx = { commands: { register(definition) { commands.push(definition) } } }
  const login = { state: undefined, async logout() { loggedOut += 1 } }
  const store = { async read() { return { type: 'oauth' } } }
  const usage = {
    async get(options) {
      assert.equal(options.force, true)
      return normalizeSubscriptionUsage(RAW_USAGE)
    },
    clear() { cleared += 1 },
  }
  installCommands(ctx, login, store, 'openai-codex', usage)

  const result = await commands.find((command) => command.name === 'codex-usage').handler()
  assert.equal(result.kind, 'success')
  assert.match(result.text, /5 小时剩余 94%/)
  assert.match(result.text, /7 天剩余 75\.5%/)

  await commands.find((command) => command.name === 'codex-logout').handler()
  assert.equal(loggedOut, 1)
  assert.equal(cleared, 1)
})

test('HTTP usage route returns sanitized cached usage and requires login', async () => {
  let route
  let credential
  let forced
  const ctx = {
    get(name) {
      if (name !== 'webServer') return undefined
      return { register(definition) { route = definition; return () => {} } }
    },
  }
  const login = { state: undefined, async logout() {}, start() {}, async waitState() {} }
  const store = { async read() { return credential } }
  const usage = {
    async get(options) {
      forced = options.force
      return { ...normalizeSubscriptionUsage(RAW_USAGE), updatedAt: 123 }
    },
    clear() {},
  }
  installServerRoutes(ctx, login, store, 'openai-codex', usage)

  async function request(url) {
    let body
    const res = {
      setHeader() {},
      end(value) { body = JSON.parse(value) },
    }
    await route.handler({ url }, res)
    return { status: res.statusCode, body }
  }

  const signedOut = await request('/codex-oauth/usage')
  assert.equal(signedOut.status, 401)
  assert.equal(JSON.stringify(signedOut.body).includes('token'), false)

  credential = { type: 'oauth' }
  const result = await request('/codex-oauth/usage?refresh=1')
  assert.equal(result.status, 200)
  assert.equal(result.body.primary.remainingPercent, 94)
  assert.equal(forced, true)
  assert.equal('access' in result.body, false)
})
