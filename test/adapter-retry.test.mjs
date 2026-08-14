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

test('unknown Codex failures remain outside automatic retry policy', async () => {
  const finish = await finishFor('Codex error: unsupported conversation state')

  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'CODEX_ERROR')
  assert.equal(finish.reason.failure.requestId, undefined)
})
