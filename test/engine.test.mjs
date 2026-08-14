import assert from 'node:assert/strict'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'

import { readNativeCompactCheckpoint } from '../src/checkpoint.js'
import {
  NativeCompactionEngine,
  estimateOpaqueReplayTokens,
  resolveNativeCompactionPolicy,
} from '../src/engine.js'

function user(text) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

const IMAGE_REF = {
  attachmentId: 'attachment-image-1',
  mediaType: 'image/png',
  bytes: 4,
  width: 1,
  height: 1,
  name: 'pixel.png',
}
const IMAGE_BYTES = Uint8Array.from([1, 2, 3, 4])

function userWithImage(text) {
  return createUserMessage({
    content: [{ type: 'text', text }, { type: 'image', attachment: IMAGE_REF }],
    source: { kind: 'user' },
  })
}

function fixture({ failCompact = false, failFlush = false, oversizedCheckpoint = false, imageHistory = false } = {}) {
  const root = new Context()
  let flushes = 0
  root.provide('tokenMeter', {
    measure(session) {
      return {
        totalTokens: session.surface.nodes.length * 100,
        nodes: session.surface.nodes.map((seq) => ({ seq, tokens: 100 })),
      }
    },
  })
  root.provide('sessions', {
    async flush() {
      flushes += 1
      if (failFlush) throw new Error('disk unavailable')
    },
  })
  const session = Session.create(SessionId('native-engine-test'))
  session.append('request/header', {
    header: { config: { provider: 'codex-oauth', model: 'gpt-5.4' } },
    reason: 'initial',
  })
  session.append(
    'user/message',
    imageHistory ? userWithImage('old history containing important state') : user('old history containing important state'),
    { surfaceOp: 'append' },
  )
  session.append('user/message', user('recent tail remains verbatim'), { surfaceOp: 'append' })

  let capturedContext
  const transport = {
    async identity(model) {
      assert.equal(model, 'gpt-5.4')
      return '0123456789abcdef01234567'
    },
    supportsImageInput() {
      return true
    },
    async compactContext({ model, context }) {
      assert.equal(model, 'gpt-5.4')
      assert.ok(context.messages.length > 0)
      capturedContext = context
      if (failCompact) throw new Error('provider compact failed')
      return {
        protocol: 'responses.compaction-trigger.v2',
        model,
        transportIdentity: '0123456789abcdef01234567',
        items: [
          ...(imageHistory ? [{
            role: 'user',
            content: [{
              type: 'input_image',
              detail: 'auto',
              image_url: `data:image/png;base64,${Buffer.from(IMAGE_BYTES).toString('base64')}`,
            }],
          }] : []),
          {
            type: 'compaction',
            encrypted_content: oversizedCheckpoint ? 'x'.repeat(5000) : 'opaque-state',
            future: { kept: true },
          },
        ],
        usage: { input_tokens: 20, output_tokens: 2 },
      }
    },
  }
  const engine = new NativeCompactionEngine(root, transport, {
    resolveAttachments: () => ({
      async readImage(ref) {
        assert.deepEqual(ref, IMAGE_REF)
        return { ref: IMAGE_REF, data: IMAGE_BYTES }
      },
    }),
  })
  const agent = {
    session,
    options: {},
    runMaintenance(operation) {
      return Promise.resolve(operation(new AbortController().signal))
    },
  }
  return {
    root,
    session,
    engine,
    agent,
    flushes: () => flushes,
    capturedContext: () => capturedContext,
  }
}

test('manual native engine replaces a balanced prefix and persists checkpoint source', async () => {
  const fx = fixture()
  try {
    const result = await fx.engine.compactNow(fx.agent, new AbortController().signal, 'command-1')
    assert.equal(result.shadowedSeqs.length, 1)
    assert.equal(fx.flushes(), 1)
    const messages = fx.session.deriveMessages()
    assert.equal(messages.length, 2)
    assert.equal(messages[1].content[0].text, 'recent tail remains verbatim')
    const checkpoint = readNativeCompactCheckpoint(messages[0].source)
    assert.equal(checkpoint.model, 'gpt-5.4')
    assert.equal(checkpoint.items[0].future.kept, true)

    const restored = Session.create(
      SessionId('native-engine-restored'),
      JSON.parse(JSON.stringify(fx.session.events)),
    )
    assert.deepEqual(
      readNativeCompactCheckpoint(restored.deriveMessages()[0].source),
      checkpoint,
    )
  } finally {
    await fx.root.fiber.dispose()
  }
})

test('manual native compaction resolves and persists image history', async () => {
  const fx = fixture({ imageHistory: true })
  try {
    await fx.engine.compactNow(fx.agent, new AbortController().signal, 'command-image')
    const image = fx.capturedContext().messages[0].content.find((block) => block.type === 'image')
    assert.deepEqual(image, {
      type: 'image',
      data: Buffer.from(IMAGE_BYTES).toString('base64'),
      mimeType: 'image/png',
    })
    const checkpoint = readNativeCompactCheckpoint(fx.session.deriveMessages()[0].source)
    assert.equal(checkpoint.items[0].content[0].type, 'input_image')
    assert.deepEqual(checkpoint.items[0].content[0].image_url, {
      kind: 'dsh-attachment-image',
      version: 1,
      attachment: IMAGE_REF,
    })
    const rawEvents = JSON.stringify(fx.session.events)
    assert.equal(rawEvents.includes('data:image'), false)
    assert.equal(rawEvents.includes(Buffer.from(IMAGE_BYTES).toString('base64')), false)
    assert.equal(fx.session.events
      .filter((event) => event.type === 'compaction/summary')
      .some((event) => Object.hasOwn(event.data, 'rawOutput')), false)
    for (let index = 0; index < 3; index += 1) {
      fx.session.append('user/message', user(`post-image-history-${index}`), { surfaceOp: 'append' })
    }
    await fx.engine.compactNow(fx.agent, new AbortController().signal, 'command-image-repeat')
    assert.equal(fx.session.surface.replaceGeneration, 2)
    assert.equal(JSON.stringify(readNativeCompactCheckpoint(fx.session.deriveMessages()[0].source)).includes('data:image'), false)
    const restored = Session.create(
      SessionId('native-engine-image-restored'),
      JSON.parse(JSON.stringify(fx.session.events)),
    )
    assert.deepEqual(readNativeCompactCheckpoint(restored.deriveMessages()[0].source), checkpoint)
  } finally {
    await fx.root.fiber.dispose()
  }
})

test('manual engine supports repeated compaction over a prior native checkpoint', async () => {
  const fx = fixture()
  try {
    await fx.engine.compactNow(fx.agent, new AbortController().signal, 'command-1')
    const second = await fx.engine.compactNow(fx.agent, new AbortController().signal, 'command-2')
    assert.equal(second.shadowedSeqs.length, 1)
    assert.equal(fx.session.surface.replaceGeneration, 2)
    assert.equal(fx.flushes(), 2)
    assert.equal(readNativeCompactCheckpoint(fx.session.deriveMessages()[0].source).version, 1)
  } finally {
    await fx.root.fiber.dispose()
  }
})

test('manual engine refuses an opaque checkpoint that would increase context', async () => {
  const fx = fixture({ oversizedCheckpoint: true })
  const before = [...fx.session.surface.nodes]
  try {
    await assert.rejects(
      fx.engine.compactNow(fx.agent, new AbortController().signal, 'command-oversized'),
      (error) => error.code === 'summary'
        && error.cause?.code === 'NATIVE_COMPACT_NOT_USEFUL'
        && /would not reduce context/.test(error.cause.message),
    )
    assert.deepEqual(fx.session.surface.nodes, before)
    assert.equal(fx.session.events.some((event) => event.type === 'compaction/summary'), false)
    assert.equal(fx.flushes(), 1)
  } finally {
    await fx.root.fiber.dispose()
  }
})

test('transport failure records a closed bracket without replacing surface', async () => {
  const fx = fixture({ failCompact: true })
  const before = [...fx.session.surface.nodes]
  try {
    await assert.rejects(
      fx.engine.compactNow(fx.agent, new AbortController().signal, 'command-2'),
      (error) => error.code === 'summary',
    )
    assert.deepEqual(fx.session.surface.nodes, before)
    assert.equal(fx.session.events.filter((event) => event.type === 'compaction/start').length, 1)
    assert.equal(fx.session.events.filter((event) => event.type === 'compaction/end').length, 1)
    assert.equal(fx.session.events.some((event) => event.type === 'compaction/summary'), false)
    assert.equal(fx.flushes(), 1)
  } finally {
    await fx.root.fiber.dispose()
  }
})

test('Scheme A reports persistence failure after committed replacement', async () => {
  const fx = fixture({ failFlush: true })
  try {
    await assert.rejects(
      fx.engine.compactNow(fx.agent, new AbortController().signal, 'command-3'),
      (error) => error.code === 'persistence',
    )
    assert.equal(fx.session.surface.replaceGeneration, 1)
    assert.equal(readNativeCompactCheckpoint(fx.session.deriveMessages()[0].source).kind, 'openai-codex-native-compaction')
  } finally {
    await fx.root.fiber.dispose()
  }
})

function automaticFixture({ provider = 'codex-oauth', contextWindow = 500, imageHistory = false } = {}) {
  const root = new Context()
  let compactCalls = 0
  let sawImage = false
  root.provide('tokenMeter', {
    measure(session) {
      return {
        totalTokens: session.surface.nodes.length * 100,
        nodes: session.surface.nodes.map((seq) => ({ seq, tokens: 100 })),
      }
    },
  })
  root.provide('sessions', { async flush() {} })
  root.provide('llm', {
    async resolveModelInfo() {
      return { context: { contextWindow } }
    },
  })
  const session = Session.create(SessionId(`native-auto-${provider}`))
  session.append('request/header', {
    header: { config: { provider, model: provider === 'codex-oauth' ? 'gpt-5.4' : 'other-model' } },
    reason: 'initial',
  })
  for (let index = 0; index < 5; index += 1) {
    session.append(
      'user/message',
      imageHistory && index === 0 ? userWithImage(`history-${index}`) : user(`history-${index}`),
      { surfaceOp: 'append' },
    )
  }
  session.append('turn/start', { turn: 1 })
  const transport = {
    async identity() {
      return '0123456789abcdef01234567'
    },
    supportsImageInput() {
      return true
    },
    async compactContext({ model, context }) {
      compactCalls += 1
      assert.equal(model, 'gpt-5.4')
      assert.ok(context.messages.length > 0)
      sawImage = context.messages.some((message) => Array.isArray(message.content)
        && message.content.some((block) => block.type === 'image'))
      return {
        protocol: 'responses.compaction-trigger.v2',
        model,
        transportIdentity: '0123456789abcdef01234567',
        items: [{ type: 'compaction', encrypted_content: 'opaque-auto-state' }],
      }
    },
  }
  const engine = new NativeCompactionEngine(root, transport, {
    resolveAttachments: () => ({
      async readImage(ref) {
        assert.deepEqual(ref, IMAGE_REF)
        return { ref: IMAGE_REF, data: IMAGE_BYTES }
      },
    }),
    auto: false,
    thresholdRatio: 0.8,
    retainRatio: 0.2,
    compactionRetries: 1,
  })
  return {
    root,
    session,
    engine,
    agent: { session, options: {} },
    compactCalls: () => compactCalls,
    sawImage: () => sawImage,
  }
}

test('automatic pressure compaction writes a native checkpoint with image history inside the open turn', async () => {
  const fx = automaticFixture({ imageHistory: true })
  try {
    const result = await fx.engine.compactIfNeeded(fx.agent, 'pressure', new AbortController().signal)
    assert.ok(result)
    assert.equal(fx.compactCalls(), 1)
    assert.equal(fx.sawImage(), true)
    assert.equal(fx.session.events[result.startSeq].data.turn, 1)
    assert.equal(fx.session.events[result.endSeq].data.turn, 1)
    assert.equal(readNativeCompactCheckpoint(fx.session.deriveMessages()[0].source).protocol, 'responses.compaction-trigger.v2')
  } finally {
    await fx.root.fiber.dispose()
  }
})

test('automatic overflow recovery forces one native reduction', async () => {
  const fx = automaticFixture({ contextWindow: 10000 })
  try {
    const result = await fx.engine.compactIfNeeded(fx.agent, 'context-overflow', new AbortController().signal)
    assert.ok(result)
    assert.equal(fx.compactCalls(), 1)
    assert.equal(readNativeCompactCheckpoint(fx.session.deriveMessages()[0].source).kind, 'openai-codex-native-compaction')
  } finally {
    await fx.root.fiber.dispose()
  }
})

test('automatic native compaction ignores foreign providers without transport traffic', async () => {
  const fx = automaticFixture({ provider: 'deepseek-official' })
  try {
    assert.equal(await fx.engine.compactIfNeeded(fx.agent, 'pressure', new AbortController().signal), null)
    assert.equal(await fx.engine.compactIfNeeded(fx.agent, 'context-overflow', new AbortController().signal), null)
    assert.equal(fx.compactCalls(), 0)
    assert.equal(fx.session.surface.replaceGeneration, 0)
  } finally {
    await fx.root.fiber.dispose()
  }
})

test('public compactRegion contract commits an explicit balanced native range', async () => {
  const fx = automaticFixture()
  try {
    const original = fx.session.surface.nodes.slice(0, 3)
    const [start, , end] = original
    const result = await fx.engine.compactRegion(start, end, fx.agent, new AbortController().signal)
    assert.deepEqual(result.shadowedSeqs, original)
    assert.equal(fx.compactCalls(), 1)
    assert.equal(readNativeCompactCheckpoint(fx.session.deriveMessages()[0].source).version, 1)
  } finally {
    await fx.root.fiber.dispose()
  }
})

test('automatic policy validates threshold, retention, and retry bounds', () => {
  assert.deepEqual(resolveNativeCompactionPolicy({ auto: true }), {
    auto: true,
    thresholdRatio: 0.8,
    retainRatio: 0.16,
    compactionRetries: 1,
    maxOverflowRetries: 1,
  })
  assert.throws(() => resolveNativeCompactionPolicy({ retainRatio: 0.9 }), /less than thresholdRatio/)
  assert.throws(() => resolveNativeCompactionPolicy({ maxOverflowRetries: -1 }), /non-negative integer/)
})

test('opaque replay estimator follows Codex ciphertext model-visible accounting', () => {
  const encrypted = 'x'.repeat(260000)
  const expectedCiphertextTokens = Math.ceil((Math.floor(encrypted.length * 3 / 4) - 650) / 4)
  assert.equal(
    estimateOpaqueReplayTokens([{ type: 'compaction', encrypted_content: encrypted }]),
    expectedCiphertextTokens + 16,
  )
  assert.ok(expectedCiphertextTokens + 16 < Math.ceil(JSON.stringify([{ type: 'compaction', encrypted_content: encrypted }]).length / 2))

  const retained = { role: 'user', content: [{ type: 'input_text', text: 'x'.repeat(4000) }] }
  assert.equal(
    estimateOpaqueReplayTokens([retained]),
    Math.ceil(JSON.stringify(retained).length / 4) + 16,
  )

  const image = {
    role: 'user',
    content: [{ type: 'input_image', detail: 'auto', image_url: `data:image/png;base64,${'A'.repeat(20000)}` }],
  }
  const imageTokens = estimateOpaqueReplayTokens([image])
  assert.ok(imageTokens >= 1844)
  assert.ok(imageTokens < Math.ceil(JSON.stringify(image).length / 4))
})
