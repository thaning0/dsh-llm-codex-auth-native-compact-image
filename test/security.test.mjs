import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const tokenFreeRuntime = [
  '../src/engine.js',
  '../src/compaction-plugin.js',
  '../src/checkpoint.js',
  '../src/native-compact.js',
]

test('engine, checkpoint, and command layers contain no credential access', async () => {
  const source = (await Promise.all(tokenFreeRuntime.map((path) =>
    readFile(new URL(path, import.meta.url), 'utf8')))).join('\n')
  assert.doesNotMatch(source, /credentials?\.(resolve|set|unset)/)
  assert.doesNotMatch(source, /OPENAI_CODEX_OAUTH/)
  assert.doesNotMatch(source, /authorization\s*:/i)
  assert.doesNotMatch(source, /refresh[_A-Za-z]*token/i)
  assert.doesNotMatch(source, /\.credentials\.yaml/)
})
