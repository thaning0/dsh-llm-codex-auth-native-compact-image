import assert from 'node:assert/strict'
import test from 'node:test'

import { LlmError } from '@deepseek-ai/dsh-llm'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { convertResponsesMessages } from '@earendil-works/pi-ai/api/openai-responses-shared'

import { CodexAdapter, codexContext } from '../src/adapter.js'

const PROVIDER_ID = 'openai-codex'
const MODEL_ID = 'gpt-5.4'
const model = builtinProviders()
  .find((provider) => provider.id === PROVIDER_ID)
  .getModels()
  .find((candidate) => candidate.id === MODEL_ID)

const imageRef = (id, mediaType = 'image/png') => ({
  attachmentId: id,
  mediaType,
  bytes: 4,
  width: 1,
  height: 1,
  name: `${id}.png`,
})

function attachmentStore(entries) {
  const reads = []
  return {
    reads,
    async readImage(ref, signal) {
      signal?.throwIfAborted()
      reads.push(String(ref.attachmentId))
      const data = entries.get(String(ref.attachmentId))
      assert.ok(data, `missing fixture attachment ${String(ref.attachmentId)}`)
      return { ref, data }
    },
  }
}

function responseInput(context) {
  return convertResponsesMessages(model, context, new Set(['openai', 'openai-codex', 'opencode']), {
    includeSystemPrompt: false,
    toolOptions: {
      strict: null,
      supportsStrictMode: true,
      supportsOpenAIGrammarTools: false,
    },
  })
}

test('user attachments and deferred read_image content become Responses input_image items', async () => {
  const first = imageRef('user-image')
  const second = imageRef('read-image', 'image/jpeg')
  const store = attachmentStore(new Map([
    ['user-image', Uint8Array.from([1, 2, 3, 4])],
    ['read-image', Uint8Array.from([5, 6, 7, 8])],
  ]))
  const signal = new AbortController().signal
  const context = await codexContext({
    model: MODEL_ID,
    signal,
    messages: [
      {
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'inspect attachment' }, { type: 'image', attachment: first }],
      },
      {
        role: 'user',
        source: { kind: 'plugin', plugin: 'tool-fs' },
        content: [{ type: 'text', text: '<file>/tmp/read.jpg</file>' }, { type: 'image', attachment: second }],
      },
    ],
  }, PROVIDER_ID, undefined, { attachments: store, imageInputSupported: true })

  assert.deepEqual(store.reads, ['user-image', 'read-image'])
  assert.deepEqual(context.messages[0].content[1], {
    type: 'image',
    data: Buffer.from([1, 2, 3, 4]).toString('base64'),
    mimeType: 'image/png',
  })
  assert.deepEqual(context.messages[1].content[1], {
    type: 'image',
    data: Buffer.from([5, 6, 7, 8]).toString('base64'),
    mimeType: 'image/jpeg',
  })

  const input = responseInput(context)
  assert.deepEqual(input[0].content[1], {
    type: 'input_image',
    detail: 'auto',
    image_url: `data:image/png;base64,${Buffer.from([1, 2, 3, 4]).toString('base64')}`,
  })
  assert.deepEqual(input[1].content[1], {
    type: 'input_image',
    detail: 'auto',
    image_url: `data:image/jpeg;base64,${Buffer.from([5, 6, 7, 8]).toString('base64')}`,
  })
})

test('CodexAdapter resolves attachments during a real stream call', async () => {
  const ref = imageRef('stream-image')
  const store = attachmentStore(new Map([
    ['stream-image', Uint8Array.from([13, 14, 15, 16])],
  ]))
  let captured
  const models = {
    getModel(_provider, id) {
      return id === MODEL_ID ? model : undefined
    },
    getModels() {
      return [model]
    },
    streamSimple(_model, context) {
      captured = context
      return (async function* () {
        yield { type: 'start', partial: null }
        yield { type: 'text_start', contentIndex: 0 }
        yield { type: 'text_delta', contentIndex: 0, delta: 'ok' }
        yield { type: 'text_end', contentIndex: 0, content: 'ok' }
        yield {
          type: 'done',
          message: {
            api: 'openai-codex-responses',
            provider: PROVIDER_ID,
            model: MODEL_ID,
            stopReason: 'stop',
            content: [{ type: 'text', text: 'ok' }],
            usage: { input: 1, output: 1 },
          },
        }
      })()
    },
  }
  const adapter = new CodexAdapter(models, PROVIDER_ID, 'codex-oauth', {
    resolveAttachments: () => store,
    streamIdleTimeoutMs: 5000,
  })
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'codex-oauth',
    model: MODEL_ID,
    messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'image', attachment: ref }] }],
  })) chunks.push(chunk)
  assert.equal(chunks.at(-1).type, 'finish')
  assert.equal(captured.messages[0].content[0].data, Buffer.from([13, 14, 15, 16]).toString('base64'))
  assert.deepEqual(store.reads, ['stream-image'])
})

test('tool-result images are resolved once and lowered inside function_call_output', async () => {
  const image = imageRef('tool-image', 'image/webp')
  const store = attachmentStore(new Map([
    ['tool-image', Uint8Array.from([9, 10, 11, 12])],
  ]))
  const context = await codexContext({
    model: MODEL_ID,
    messages: [
      {
        role: 'assistant',
        source: { kind: 'model', provider: 'codex-oauth', model: 'gpt-5.5' },
        content: [{ type: 'tool-call', id: 'call_image|original_item', name: 'render', arguments: '{}' }],
      },
      {
        role: 'user',
        source: { kind: 'plugin', plugin: 'image-tool' },
        content: [{
          type: 'tool-result',
          toolCallId: 'call_image|original_item',
          content: [
            { type: 'text', text: 'rendered image' },
            { type: 'image', attachment: image },
            { type: 'image', attachment: image },
          ],
        }],
      },
    ],
  }, PROVIDER_ID, undefined, { attachments: store, imageInputSupported: true })

  assert.deepEqual(store.reads, ['tool-image'])
  const input = responseInput(context)
  const call = input.find((item) => item.type === 'function_call')
  const output = input.find((item) => item.type === 'function_call_output')
  assert.ok(call)
  assert.ok(output)
  assert.equal(output.call_id, call.call_id)
  assert.equal(Array.isArray(output.output), true)
  assert.equal(output.output.filter((item) => item.type === 'input_image').length, 2)
  assert.equal(output.output[1].image_url, `data:image/webp;base64,${Buffer.from([9, 10, 11, 12]).toString('base64')}`)
})

test('image conversion fails before attachment I/O for unsupported models or missing storage', async () => {
  const message = {
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'image', attachment: imageRef('blocked') }],
  }
  let reads = 0
  const attachments = {
    async readImage() {
      reads += 1
      throw new Error('must not read')
    },
  }
  await assert.rejects(
    codexContext({ model: 'text-model', messages: [message] }, PROVIDER_ID, undefined, {
      attachments,
      imageInputSupported: false,
    }),
    (error) => error instanceof LlmError && error.failure?.code === 'UNSUPPORTED_CONTENT',
  )
  assert.equal(reads, 0)
  await assert.rejects(
    codexContext({ model: MODEL_ID, messages: [message] }, PROVIDER_ID, undefined, {
      imageInputSupported: true,
    }),
    (error) => error instanceof LlmError && error.failure?.code === 'UNSUPPORTED_CONTENT',
  )
})
