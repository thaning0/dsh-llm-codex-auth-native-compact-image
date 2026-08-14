import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CodexOAuthTransport,
  CodexOAuthTransportError,
} from '../src/transport.js'

const ACCOUNT_ID = 'acct-private-123'
const ACCESS_TOKEN = jwt({
  'https://api.openai.com/auth': { chatgpt_account_id: ACCOUNT_ID },
})
const MODEL = {
  id: 'gpt-test-codex',
  name: 'GPT test Codex',
  api: 'openai-codex-responses',
  provider: 'openai-codex',
  baseUrl: 'https://chatgpt.com/backend-api',
  input: ['text', 'image'],
  reasoning: true,
  contextWindow: 272000,
  maxTokens: 128000,
  compat: { supportsOpenAIGrammarTools: true },
}

function jwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode(payload)}.signature-secret`
}

function models() {
  return {
    getModel(provider, model) {
      return provider === 'openai-codex' && model === MODEL.id ? MODEL : undefined
    },
    getModels(provider) {
      return provider === 'openai-codex' ? [MODEL] : []
    },
    async getAuth(model) {
      assert.equal(model, MODEL)
      return { auth: { apiKey: ACCESS_TOKEN } }
    },
  }
}

function sse(events) {
  const text = [...events.map((event) => `data: ${JSON.stringify(event)}`), 'data: [DONE]', ''].join('\n')
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function compactSse(item = { type: 'compaction', encrypted_content: 'opaque-ciphertext' }) {
  return sse([
    { type: 'response.output_item.done', item },
    { type: 'response.completed', response: { id: 'resp_compact', usage: { input_tokens: 10 } } },
  ])
}

test('compact uses V2 on only the ChatGPT Codex backend and preserves opaque items', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return compactSse({
      type: 'compaction',
      encrypted_content: 'opaque-ciphertext',
      future_field: { kept: true },
    })
  }
  const transport = new CodexOAuthTransport(models(), { fetchImpl })
  const original = { role: 'user', content: [{ type: 'input_text', text: 'hello' }] }
  const result = await transport.compact({
    model: MODEL.id,
    input: [original],
    signal: new AbortController().signal,
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://chatgpt.com/backend-api/codex/responses')
  assert.equal(calls[0].init.headers.authorization, `Bearer ${ACCESS_TOKEN}`)
  assert.equal(calls[0].init.headers['chatgpt-account-id'], ACCOUNT_ID)
  const body = JSON.parse(calls[0].init.body)
  assert.deepEqual(body.input, [original, { type: 'compaction_trigger' }])
  assert.equal(body.stream, true)
  assert.equal(result.protocol, 'responses.compaction-trigger.v2')
  assert.equal(result.model, MODEL.id)
  assert.match(result.transportIdentity, /^[a-f0-9]{24}$/)
  assert.notEqual(result.transportIdentity, ACCOUNT_ID)
  assert.deepEqual(result.items, [
    original,
    {
      type: 'compaction',
      encrypted_content: 'opaque-ciphertext',
      future_field: { kept: true },
    },
  ])
  assert.deepEqual(result.usage, { input_tokens: 10 })
  assert.doesNotMatch(JSON.stringify(result), new RegExp(ACCOUNT_ID))
  assert.equal(JSON.stringify(result).includes(ACCESS_TOKEN), false)
})

test('compact preserves retained image data independently of the text-token budget', async () => {
  const image = {
    role: 'user',
    content: [{
      type: 'input_image',
      detail: 'auto',
      image_url: `data:image/png;base64,${'A'.repeat(400000)}`,
    }],
  }
  const transport = new CodexOAuthTransport(models(), { fetchImpl: async () => compactSse() })
  const result = await transport.compact({ model: MODEL.id, input: [image] })
  assert.equal(result.items[0].content[0].image_url, image.content[0].image_url)
  assert.equal(result.items[1].type, 'compaction')
})

test('compactContext lowers pi image blocks into Responses input_image', async () => {
  let body
  const transport = new CodexOAuthTransport(models(), {
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body)
      return compactSse()
    },
  })
  assert.equal(transport.supportsImageInput(MODEL.id), true)
  await transport.compactContext({
    model: MODEL.id,
    context: {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'inspect' },
          { type: 'image', data: 'AQIDBA==', mimeType: 'image/png' },
        ],
      }],
    },
  })
  assert.deepEqual(body.input[0].content[1], {
    type: 'input_image',
    detail: 'auto',
    image_url: 'data:image/png;base64,AQIDBA==',
  })
  assert.equal(body.input.at(-1).type, 'compaction_trigger')
})

test('probe compacts, JSON-round-trips, and replays opaque items', async () => {
  const calls = []
  let probeNonce
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    const request = JSON.parse(init.body)
    if (request.input.at(-1)?.type === 'compaction_trigger') {
      return compactSse({ type: 'compaction', encrypted_content: 'opaque-probe-state' })
    }
    const prompt = request.input.at(-1)?.content?.[0]?.text
    assert.match(prompt, /exact probe code/)
    const firstRequest = JSON.parse(calls[0].init.body)
    probeNonce = firstRequest.input
      .flatMap((item) => item.content ?? [])
      .map((item) => item.text ?? '')
      .join('\n')
      .match(/DSH_NATIVE_COMPACT_[A-Z0-9]+/)[0]
    return sse([
      { type: 'response.output_text.delta', delta: probeNonce },
      { type: 'response.completed', response: { id: 'resp_probe' } },
    ])
  }
  const transport = new CodexOAuthTransport(models(), { fetchImpl })
  const result = await transport.probe({ model: MODEL.id, signal: new AbortController().signal })

  assert.equal(calls.length, 2)
  assert.equal(calls[0].url, 'https://chatgpt.com/backend-api/codex/responses')
  assert.equal(calls[1].url, 'https://chatgpt.com/backend-api/codex/responses')
  assert.equal(result.itemCount, 2)
  assert.equal(result.persistenceRoundTripVerified, true)
  assert.equal(result.replayVerified, true)
  const replayBody = JSON.parse(calls[1].init.body)
  assert.deepEqual(replayBody.input[1], {
    type: 'compaction',
    encrypted_content: 'opaque-probe-state',
  })
  assert.equal(JSON.stringify(replayBody).includes(probeNonce), false)
})

test('transport refuses an account identity change before network I/O', async () => {
  const transport = new CodexOAuthTransport(models(), {
    fetchImpl: async () => assert.fail('fetch must not run'),
  })
  await assert.rejects(
    transport.compact({
      model: MODEL.id,
      input: [{ role: 'user' }],
      expectedTransportIdentity: 'different-account',
    }),
    (error) => error.code === 'NATIVE_COMPACT_IDENTITY',
  )
})

test('production transport fails closed on a non-ChatGPT backend', async () => {
  const badModels = models()
  badModels.getModel = () => ({ ...MODEL, baseUrl: 'https://api.openai.com/v1' })
  badModels.getAuth = async () => ({ auth: { apiKey: ACCESS_TOKEN } })
  const transport = new CodexOAuthTransport(badModels, {
    fetchImpl: async () => assert.fail('fetch must not run'),
  })

  await assert.rejects(
    transport.compact({ model: MODEL.id, input: [{}] }),
    (error) => error instanceof CodexOAuthTransportError
      && error.code === 'NATIVE_COMPACT_ENDPOINT'
      && !error.message.includes(ACCESS_TOKEN),
  )
})

test('fetchSubscriptionUsage authenticates WHAM and returns only sanitized percentages', async () => {
  let call
  const transport = new CodexOAuthTransport(models(), {
    fetchImpl: async (url, init) => {
      call = { url, init }
      return Response.json({
        plan_type: 'pro',
        rate_limit: {
          primary_window: { used_percent: 12, reset_at: 1_800_000_000, limit_window_seconds: 18_000 },
          secondary_window: { used_percent: 34, reset_at: 1_800_500_000, limit_window_seconds: 604_800 },
        },
        private_server_field: ACCESS_TOKEN,
      })
    },
  })

  const usage = await transport.fetchSubscriptionUsage()
  assert.equal(call.url, 'https://chatgpt.com/backend-api/wham/usage')
  assert.equal(call.init.method, 'GET')
  assert.equal(call.init.headers.authorization, `Bearer ${ACCESS_TOKEN}`)
  assert.equal(call.init.headers['chatgpt-account-id'], ACCOUNT_ID)
  assert.deepEqual(usage, {
    planType: 'pro',
    primary: { usedPercent: 12, remainingPercent: 88, resetAt: 1_800_000_000, windowSeconds: 18_000 },
    secondary: { usedPercent: 34, remainingPercent: 66, resetAt: 1_800_500_000, windowSeconds: 604_800 },
  })
  assert.equal(JSON.stringify(usage).includes(ACCESS_TOKEN), false)
  assert.equal(JSON.stringify(usage).includes(ACCOUNT_ID), false)
})

test('explicit test backend accepts loopback only', async () => {
  const seen = []
  const transport = new CodexOAuthTransport(models(), {
    testBaseUrl: 'http://127.0.0.1:43210/mock',
    fetchImpl: async (url) => {
      seen.push(url)
      return compactSse()
    },
  })
  await transport.compact({ model: MODEL.id, input: [{ role: 'user' }] })
  assert.deepEqual(seen, ['http://127.0.0.1:43210/mock/codex/responses'])

  const refused = new CodexOAuthTransport(models(), {
    testBaseUrl: 'https://example.com/mock',
    fetchImpl: async () => assert.fail('fetch must not run'),
  })
  await assert.rejects(
    refused.compact({ model: MODEL.id, input: [{}] }),
    (error) => error.code === 'NATIVE_COMPACT_ENDPOINT',
  )
})
