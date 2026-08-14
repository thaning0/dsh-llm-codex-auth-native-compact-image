/** Agent-scoped Cordis entry for manual and automatic provider-native compaction. */
import {
  installManualCompactCommand,
  resolveNativeCompactConfig,
} from './native-compact.js'
import { NativeCompactionEngine } from './engine.js'

export const name = 'dsh-llm-codex-auth-native-compact-image/compaction'
export const inject = ['llm', 'commands', 'tokenMeter', 'sessions', 'codexOAuthTransport']

export function apply(ctx, config) {
  const provider = config?.provider ?? 'codex-oauth'
  const nativeCompact = resolveNativeCompactConfig(config)
  if (ctx.get('compaction') !== undefined) {
    throw new Error('native compaction preset entry cannot start while another ctx.compaction service is registered in this agent realm')
  }
  new NativeCompactionEngine(ctx, ctx.codexOAuthTransport, {
    provider,
    resolveAttachments: () => ctx.get('attachments'),
    auto: nativeCompact.mode === 'automatic',
    thresholdRatio: config?.thresholdRatio,
    retainRatio: config?.retainRatio,
    compactionRetries: config?.compactionRetries,
    maxOverflowRetries: config?.maxOverflowRetries,
  })
  installManualCompactCommand(ctx)
  ctx.logger.info(`dsh-llm-codex-auth-native-compact-image: agent-scoped native compaction ready in ${nativeCompact.mode} mode for provider "${provider}"`)
}
