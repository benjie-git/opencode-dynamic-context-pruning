import type { SessionState, WithParts } from "../state"

/** Timestamp of the assistant response whose usage is the current provider count. */
export function lastUsageCreated(messages: WithParts[]): number | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
        const info = messages[i].info
        if (info.role !== "assistant") continue
        if ((info.tokens?.output ?? 0) <= 0) continue
        return info.time.created
    }
    return undefined
}

/**
 * Net tokens removed by compression blocks that are still active.
 * When `since` is set, only blocks created after that timestamp are counted, i.e.
 * the savings that the current provider usage cannot reflect yet.
 */
export function activeCompressionSavings(state: SessionState, since = 0): number {
    let total = 0
    for (const blockId of state.prune.messages.activeBlockIds) {
        const block = state.prune.messages.blocksById.get(blockId)
        if (!block?.active || block.createdAt <= since) continue
        total += Math.max(0, block.compressedTokens - block.summaryTokens)
    }
    return total
}

/**
 * Whether a compression block was applied after the last provider usage report.
 * The reported usage is then stale until the next assistant response, so another
 * background plan must not be started from it.
 */
export function compressionSinceUsage(state: SessionState, messages: WithParts[]): boolean {
    const since = lastUsageCreated(messages)
    if (since === undefined) return false
    for (const blockId of state.prune.messages.activeBlockIds) {
        const block = state.prune.messages.blocksById.get(blockId)
        if (block?.active && block.createdAt > since) return true
    }
    return false
}

/**
 * Estimate of the context the next request will use. The last provider usage is
 * authoritative, minus compression that was applied after that response.
 */
export function effectiveContextTokens(
    contextTotal: number,
    state: SessionState,
    messages: WithParts[],
): number {
    const since = lastUsageCreated(messages)
    const unreflected = since === undefined ? 0 : activeCompressionSavings(state, since)
    return Math.max(0, contextTotal - unreflected)
}
