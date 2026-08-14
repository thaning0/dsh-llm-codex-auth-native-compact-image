import { deepFreeze } from '@deepseek-ai/dsh-llm'

export const NATIVE_COMPACT_KIND = 'openai-codex-native-compaction'
export const NATIVE_COMPACT_VERSION = 1
export const NATIVE_COMPACT_REPLAY_CODE = 'NATIVE_COMPACT_REPLAY_INCOMPATIBLE'
const ATTACHMENT_IMAGE_KIND = 'dsh-attachment-image'
const ATTACHMENT_IMAGE_VERSION = 1

function incompatible(message, cause) {
  const error = new Error(`native compact checkpoint is incompatible: ${message}`, cause === undefined ? undefined : { cause })
  error.code = NATIVE_COMPACT_REPLAY_CODE
  return error
}

function ownedJson(value, field) {
  try {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) throw new TypeError(`${field} is not JSON-serializable`)
    return JSON.parse(encoded)
  } catch (error) {
    throw incompatible(`${field} must be lossless JSON`, error)
  }
}

function attachmentKey(ref) {
  return JSON.stringify([
    String(ref.attachmentId),
    ref.mediaType,
    ref.bytes,
    ref.width,
    ref.height,
    ref.name ?? null,
  ])
}

function validateAttachmentRef(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw incompatible('checkpoint image attachment ref must be an object')
  if (typeof value.attachmentId !== 'string' || value.attachmentId.length === 0) throw incompatible('checkpoint image attachmentId must be a non-empty string')
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(value.mediaType)) throw incompatible('checkpoint image mediaType is unsupported')
  for (const key of ['bytes', 'width', 'height']) {
    if (!Number.isSafeInteger(value[key]) || value[key] <= 0) throw incompatible(`checkpoint image ${key} must be a positive integer`)
  }
  if (value.name !== undefined && typeof value.name !== 'string') throw incompatible('checkpoint image name must be a string')
  return value
}

function isAttachmentImage(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && value.kind === ATTACHMENT_IMAGE_KIND
}

function validateCheckpointImages(value) {
  if (typeof value === 'string' && value.startsWith('data:image/')) {
    throw incompatible('checkpoint items must not persist inline image data')
  }
  if (value === null || typeof value !== 'object') return
  if (!Array.isArray(value)
    && value.type === 'input_image') {
    if (typeof value.image_url === 'string' && value.image_url.startsWith('data:image/')) {
      throw incompatible('checkpoint items must not persist inline image data')
    }
    if (isAttachmentImage(value.image_url)) {
      if (value.image_url.version !== ATTACHMENT_IMAGE_VERSION) throw incompatible('checkpoint image reference version is unsupported')
      validateAttachmentRef(value.image_url.attachment)
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) validateCheckpointImages(item)
  } else {
    for (const item of Object.values(value)) validateCheckpointImages(item)
  }
}

function transformCheckpointImages(value, transform) {
  if (value === null || typeof value !== 'object') return value
  if (!Array.isArray(value) && value.type === 'input_image') return transform(value)
  if (Array.isArray(value)) return value.map((item) => transformCheckpointImages(item, transform))
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, transformCheckpointImages(item, transform)]))
}

export function externalizeNativeCheckpointImages(items, imageReferences) {
  return transformCheckpointImages(items, (item) => {
    if (typeof item.image_url !== 'string' || !item.image_url.startsWith('data:image/')) return item
    const attachment = imageReferences.get(item.image_url)
    if (attachment === undefined) throw incompatible('provider returned an unrecognized inline image')
    return {
      ...item,
      image_url: {
        kind: ATTACHMENT_IMAGE_KIND,
        version: ATTACHMENT_IMAGE_VERSION,
        attachment,
      },
    }
  })
}

export function checkpointHasAttachmentImages(checkpoint) {
  let found = false
  transformCheckpointImages(checkpoint.items, (item) => {
    if (isAttachmentImage(item.image_url)) found = true
    return item
  })
  return found
}

export async function inflateNativeCheckpointImages(checkpoint, attachments, signal, imageReferences = new Map()) {
  const reads = new Map()
  const inflate = async (value) => {
    if (value === null || typeof value !== 'object') return value
    if (!Array.isArray(value) && value.type === 'input_image' && isAttachmentImage(value.image_url)) {
      const ref = validateAttachmentRef(value.image_url.attachment)
      const key = attachmentKey(ref)
      let pending = reads.get(key)
      if (pending === undefined) {
        pending = attachments.readImage(ref, signal)
        reads.set(key, pending)
      }
      const stored = await pending
      const imageUrl = `data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString('base64')}`
      imageReferences.set(imageUrl, stored.ref)
      return { ...value, image_url: imageUrl }
    }
    if (Array.isArray(value)) return Promise.all(value.map(inflate))
    const entries = await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await inflate(item)]))
    return Object.fromEntries(entries)
  }
  return inflate(checkpoint.items)
}

export function createNativeCompactCheckpoint(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw incompatible('input must be an object')
  for (const key of ['provider', 'model', 'transportIdentity', 'protocol']) {
    if (typeof input[key] !== 'string' || input[key].length === 0) throw incompatible(`${key} must be a non-empty string`)
  }
  if (input.provider !== 'codex-oauth') throw incompatible(`provider ${input.provider} is unsupported`)
  if (input.protocol !== 'responses.compaction-trigger.v2' && input.protocol !== 'responses.compact.v1') {
    throw incompatible(`protocol ${input.protocol} is unsupported`)
  }
  if (!Array.isArray(input.items) || input.items.length === 0) throw incompatible('items must be a non-empty array')
  const items = ownedJson(input.items, 'items')
  if (JSON.stringify(items) !== JSON.stringify(input.items)) throw incompatible('items changed during JSON round-trip')
  validateCheckpointImages(items)
  return deepFreeze({
    kind: NATIVE_COMPACT_KIND,
    version: NATIVE_COMPACT_VERSION,
    provider: input.provider,
    model: input.model,
    transportIdentity: input.transportIdentity,
    protocol: input.protocol,
    items,
  })
}

export function nativeCompactCheckpointSource(compactionId, sourceCommandId, checkpoint) {
  return deepFreeze({
    kind: 'plugin',
    plugin: 'compact',
    compactionId,
    ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
    nativeCompact: createNativeCompactCheckpoint(checkpoint),
  })
}

/** Return undefined for ordinary messages; validate native checkpoint candidates strictly. */
export function readNativeCompactCheckpoint(source) {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return undefined
  if (source.kind !== 'plugin' || source.plugin !== 'compact' || source.nativeCompact === undefined) return undefined
  const checkpoint = source.nativeCompact
  if (checkpoint === null || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) throw incompatible('payload must be an object')
  if (checkpoint.kind !== NATIVE_COMPACT_KIND) throw incompatible(`unknown kind ${String(checkpoint.kind)}`)
  if (checkpoint.version !== NATIVE_COMPACT_VERSION) throw incompatible(`unsupported version ${String(checkpoint.version)}`)
  return createNativeCompactCheckpoint(checkpoint)
}

export function assertNativeCompactCompatibility(checkpoint, expected) {
  if (checkpoint.provider !== expected.provider) {
    throw incompatible(`provider ${checkpoint.provider} cannot replay through ${expected.provider}`)
  }
  if (checkpoint.model !== expected.model) {
    throw incompatible(`model ${checkpoint.model} cannot replay through ${expected.model}`)
  }
  if (checkpoint.transportIdentity !== expected.transportIdentity) {
    throw incompatible('authenticated account/workspace identity changed')
  }
  // Only V2 supports replay through compaction items; V1 checkpoints must be
  // refused because they lack a structured item that survives SSE parsing.
  if (checkpoint.protocol === 'responses.compact.v1') {
    throw incompatible(`protocol ${checkpoint.protocol} cannot be replayed — only v2 is supported`)
  }
  return checkpoint
}

export function containsNativeCompactCheckpoint(messages) {
  return messages.some((message) => readNativeCompactCheckpoint(message.source) !== undefined)
}
