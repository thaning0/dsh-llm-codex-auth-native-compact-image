import assert from 'node:assert/strict'
import test from 'node:test'

import {
  NATIVE_COMPACT_REPLAY_CODE,
  assertNativeCompactCompatibility,
  createNativeCompactCheckpoint,
  externalizeNativeCheckpointImages,
  nativeCompactCheckpointSource,
  readNativeCompactCheckpoint,
} from '../src/checkpoint.js'

const payload = {
  provider: 'codex-oauth',
  model: 'gpt-5.4',
  transportIdentity: '0123456789abcdef01234567',
  protocol: 'responses.compaction-trigger.v2',
  items: [{
    type: 'compaction',
    encrypted_content: 'opaque',
    unknown_future_field: { nested: [1, true, null, { kept: 'yes' }] },
  }],
}

test('native checkpoint source survives lossless JSON persistence', () => {
  const source = nativeCompactCheckpointSource('compact-1', 'command-1', payload)
  const restored = JSON.parse(JSON.stringify(source))
  const checkpoint = readNativeCompactCheckpoint(restored)
  assert.deepEqual(checkpoint, createNativeCompactCheckpoint(payload))
  assert.equal(checkpoint.items[0].unknown_future_field.nested[3].kept, 'yes')
  assert.equal(Object.isFrozen(checkpoint), true)
  assert.equal(Object.isFrozen(checkpoint.items[0]), true)
})

test('checkpoint externalizes known images and rejects inline image persistence', () => {
  const ref = {
    attachmentId: 'image-1',
    mediaType: 'image/png',
    bytes: 4,
    width: 1,
    height: 1,
  }
  const imageUrl = 'data:image/png;base64,AQIDBA=='
  const items = externalizeNativeCheckpointImages([{
    role: 'user',
    content: [{ type: 'input_image', detail: 'auto', image_url: imageUrl }],
  }], new Map([[imageUrl, ref]]))
  const checkpoint = createNativeCompactCheckpoint({ ...payload, items: [...items, ...payload.items] })
  assert.deepEqual(checkpoint.items[0].content[0].image_url, {
    kind: 'dsh-attachment-image',
    version: 1,
    attachment: ref,
  })
  assert.equal(JSON.stringify(checkpoint).includes('data:image'), false)
  assert.equal(JSON.stringify(checkpoint).includes('AQIDBA=='), false)
  assert.throws(
    () => createNativeCompactCheckpoint({
      ...payload,
      items: [{ role: 'user', content: [{ type: 'input_image', image_url: imageUrl }] }, ...payload.items],
    }),
    (error) => error.code === NATIVE_COMPACT_REPLAY_CODE,
  )
})

test('ordinary compact source is not mistaken for a native checkpoint', () => {
  assert.equal(readNativeCompactCheckpoint({ kind: 'plugin', plugin: 'compact', compactionId: 'x' }), undefined)
  assert.equal(readNativeCompactCheckpoint({ kind: 'user' }), undefined)
})

test('checkpoint compatibility fails closed for route, model, identity, and version', () => {
  const checkpoint = createNativeCompactCheckpoint(payload)
  assert.equal(assertNativeCompactCompatibility(checkpoint, {
    provider: 'codex-oauth',
    model: 'gpt-5.4',
    transportIdentity: payload.transportIdentity,
  }), checkpoint)
  for (const expected of [
    { provider: 'other', model: 'gpt-5.4', transportIdentity: payload.transportIdentity },
    { provider: 'codex-oauth', model: 'gpt-other', transportIdentity: payload.transportIdentity },
    { provider: 'codex-oauth', model: 'gpt-5.4', transportIdentity: 'different' },
  ]) {
    assert.throws(
      () => assertNativeCompactCompatibility(checkpoint, expected),
      (error) => error.code === NATIVE_COMPACT_REPLAY_CODE,
    )
  }
  const source = nativeCompactCheckpointSource('compact-1', undefined, payload)
  const changed = JSON.parse(JSON.stringify(source))
  changed.nativeCompact.version = 999
  assert.throws(
    () => readNativeCompactCheckpoint(changed),
    (error) => error.code === NATIVE_COMPACT_REPLAY_CODE,
  )
})
