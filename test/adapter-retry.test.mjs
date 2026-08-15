import assert from 'node:assert/strict'
import test from 'node:test'

import { builtinProviders } from '@earendil-works/pi-ai/providers/all'

import { CodexAdapter } from '../src/adapter.js'

const providerId = 'openai-codex'
const provider = 'codex-oauth'
const model = builtinProviders()
  .find((entry) => entry.id === providerId)
  .getModels()
  .find((entry) => entry.id === 'gpt-5.3-codex-spark')

function adapterForError(errorMessage) {
  const models = {
    getModel: (_providerId, modelId) => (modelId === model.id ? model : undefined),
    getModels: () => [model],
    async *streamSimple() {
      yield { type: 'start', partial: null }
      yield {
        type: 'error',
        error: {
          api: 'openai-codex-responses',
          provider: providerId,
          model: model.id,
          stopReason: 'error',
          errorMessage,
          content: [],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      }
    },
  }
  return new CodexAdapter(models, providerId, provider, { streamIdleTimeoutMs: 5000 })
}

async function finishFor(errorMessage) {
  const chunks = []
  for await (const chunk of adapterForError(errorMessage).stream({
    provider,
    model: model.id,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'continue' }] }],
  })) chunks.push(chunk)
  return chunks.find((chunk) => chunk.type === 'finish')
}

test('canonical Codex processing failure is retryable and keeps its request id', async () => {
  const requestId = 'e686479e-ec1c-4deb-9c23-32f684d1bd50'
  const finish = await finishFor(`Codex error: An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID ${requestId} in your message.`)

  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'SERVER')
  assert.equal(finish.reason.failure.requestId, requestId)
})

test('known transient provider failures enter DSH retry categories', async (t) => {
  const cases = [
    ['WebSocket error', 'TRANSPORT'],
    ['getaddrinfo ENOTFOUND chatgpt.com', 'TRANSPORT'],
    ['connect EHOSTUNREACH 203.0.113.1', 'TRANSPORT'],
    ['write EPIPE', 'TRANSPORT'],
    ['UND_ERR_SOCKET', 'TRANSPORT'],
    ['upstream connect error or disconnect/reset before headers', 'TRANSPORT'],
    ['No response body', 'TRANSPORT'],
    ['Failed after retries', 'TRANSPORT'],
    ['OpenAI Responses stream ended before a terminal response event', 'TRANSPORT'],
    ['Invalid Codex SSE JSON: unexpected end of JSON input', 'TRANSPORT'],
    ['Too many requests', 'RATE_LIMIT'],
    ['Request throttled', 'RATE_LIMIT'],
    ['ResourceExhausted', 'RATE_LIMIT'],
    ['Bad Gateway', 'SERVER'],
    ['Service unavailable', 'SERVER'],
    ['temporarily unavailable', 'SERVER'],
    ['Codex error: upstream_error', 'SERVER'],
    ['Provider returned error', 'SERVER'],
    ['Server requested 60s retry delay', 'SERVER'],
    ['Please retry your request', 'SERVER'],
  ]

  for (const [message, code] of cases) await t.test(message, async () => {
    const finish = await finishFor(message)
    assert.equal(finish.reason.kind, 'error')
    assert.equal(finish.reason.failure.code, code)
  })
})

test('Codex context-size wording enters compaction recovery instead of blind retry', async () => {
  const finish = await finishFor('Engine protocol predict stream returned an error: {"code":500,"message":"Context size has been exceeded.","type":"server_error"}')

  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'CONTEXT_WINDOW_EXCEEDED')
})

test('deterministic remote model and subscription-limit errors remain non-retryable', async () => {
  const missingModel = await finishFor('OpenAI API error (500): Model does not exist.')
  const usageLimit = await finishFor('You have hit your ChatGPT usage limit (plus plan). Try again in ~12 min.')

  assert.equal(missingModel.reason.kind, 'error')
  assert.equal(missingModel.reason.failure.code, 'UNKNOWN_MODEL')
  assert.equal(usageLimit.reason.kind, 'error')
  assert.equal(usageLimit.reason.failure.code, 'QUOTA')
})

test('a stream that closes without a terminal event is retryable transport failure', async () => {
  const models = {
    getModel: (_providerId, modelId) => (modelId === model.id ? model : undefined),
    getModels: () => [model],
    async *streamSimple() {
      yield { type: 'start', partial: null }
    },
  }
  const adapter = new CodexAdapter(models, providerId, provider, { streamIdleTimeoutMs: 5000 })

  await assert.rejects(async () => {
    for await (const _chunk of adapter.stream({
      provider,
      model: model.id,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'continue' }] }],
    })) {}
  }, (error) => error.code === 'TRANSPORT')
})

test('thrown transport errors keep a retryable code at the adapter boundary', async () => {
  const models = {
    getModel: (_providerId, modelId) => (modelId === model.id ? model : undefined),
    getModels: () => [model],
    streamSimple() {
      throw new Error('fetch failed: getaddrinfo EAI_AGAIN chatgpt.com')
    },
  }
  const adapter = new CodexAdapter(models, providerId, provider, { streamIdleTimeoutMs: 5000 })

  await assert.rejects(async () => {
    for await (const _chunk of adapter.stream({
      provider,
      model: model.id,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'continue' }] }],
    })) {}
  }, (error) => error.code === 'TRANSPORT')
})

test('unknown Codex failures remain outside automatic retry policy', async () => {
  const finish = await finishFor('Codex error: unsupported conversation state')

  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'CODEX_ERROR')
  assert.equal(finish.reason.failure.requestId, undefined)
})
