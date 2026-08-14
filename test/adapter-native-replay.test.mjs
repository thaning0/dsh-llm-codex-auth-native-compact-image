import assert from 'node:assert/strict'
import test from 'node:test'

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createModels } from '@earendil-works/pi-ai'
import { convertResponsesMessages } from '@earendil-works/pi-ai/api/openai-responses-shared'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'

import { codexContext, textOnlyContext } from '../src/adapter.js'
import { nativeCompactCheckpointSource } from '../src/checkpoint.js'

const identity = '0123456789abcdef01234567'
const opaqueItem = {
  type: 'compaction',
  encrypted_content: 'opaque-ciphertext',
  future: { nested: ['preserved', 7] },
}

function checkpointMessage(overrides = {}) {
  return createUserMessage({
    content: [{ type: 'text', text: 'MARKER_MUST_NOT_REACH_PROVIDER' }],
    source: nativeCompactCheckpointSource('compact-1', undefined, {
      provider: 'codex-oauth',
      model: 'gpt-5.4',
      transportIdentity: identity,
      protocol: 'responses.compaction-trigger.v2',
      items: [opaqueItem],
      ...overrides,
    }),
  })
}

function model() {
  const provider = builtinProviders().find((entry) => entry.id === 'openai-codex')
  const models = createModels()
  models.setProvider(provider)
  return models.getModel('openai-codex', 'gpt-5.4')
}

test('adapter inserts opaque checkpoint before generic Responses conversion', () => {
  const context = textOnlyContext({
    messages: [
      checkpointMessage(),
      createUserMessage({
        content: [{ type: 'text', text: 'continue after compact' }],
        source: { kind: 'user' },
      }),
    ],
  }, 'openai-codex', {
    provider: 'codex-oauth',
    model: 'gpt-5.4',
    transportIdentity: identity,
  })
  const input = convertResponsesMessages(model(), context, new Set(['openai-codex']), {
    includeSystemPrompt: false,
  })

  assert.deepEqual(input[0], opaqueItem)
  assert.deepEqual(input[1], {
    role: 'user',
    content: [{ type: 'input_text', text: 'continue after compact' }],
  })
  assert.equal(JSON.stringify(input).includes('MARKER_MUST_NOT_REACH_PROVIDER'), false)
})

test('adapter inflates retained checkpoint image refs only for provider replay', async () => {
  const ref = {
    attachmentId: 'checkpoint-image',
    mediaType: 'image/png',
    bytes: 4,
    width: 1,
    height: 1,
  }
  const retainedImage = {
    role: 'user',
    content: [{
      type: 'input_image',
      detail: 'auto',
      image_url: { kind: 'dsh-attachment-image', version: 1, attachment: ref },
    }],
  }
  let reads = 0
  const context = await codexContext({
    model: 'gpt-5.4',
    messages: [checkpointMessage({ items: [retainedImage, opaqueItem] })],
  }, 'openai-codex', {
    provider: 'codex-oauth',
    model: 'gpt-5.4',
    transportIdentity: identity,
  }, {
    attachments: {
      async readImage(actual) {
        reads += 1
        assert.deepEqual(actual, ref)
        return { ref, data: Uint8Array.from([1, 2, 3, 4]) }
      },
    },
    imageInputSupported: true,
  })
  const input = convertResponsesMessages(model(), context, new Set(['openai-codex']), {
    includeSystemPrompt: false,
  })
  assert.equal(reads, 1)
  assert.deepEqual(input, [{
    role: 'user',
    content: [{
      type: 'input_image',
      detail: 'auto',
      image_url: 'data:image/png;base64,AQIDBA==',
    }],
  }, opaqueItem])
})

test('adapter rejects incompatible checkpoint before conversion', () => {
  assert.throws(
    () => textOnlyContext({ messages: [checkpointMessage()] }, 'openai-codex', {
      provider: 'codex-oauth',
      model: 'gpt-other',
      transportIdentity: identity,
    }),
    (error) => error.code === 'NATIVE_COMPACT_REPLAY_INCOMPATIBLE',
  )
})
