import assert from "node:assert/strict"
import { test } from "node:test"
import {
    activeCompressionSavings,
    effectiveContextTokens,
    lastUsageCreated,
} from "../lib/compress/estimate"
import type { SessionState, WithParts } from "../lib/state"

function stateWith(
    blocks: Array<{
        id: number
        active?: boolean
        compressed: number
        summary: number
        createdAt: number
    }>,
): SessionState {
    return {
        prune: {
            messages: {
                activeBlockIds: new Set(blocks.map((block) => block.id)),
                blocksById: new Map(
                    blocks.map((block) => [
                        block.id,
                        {
                            blockId: block.id,
                            active: block.active ?? true,
                            compressedTokens: block.compressed,
                            summaryTokens: block.summary,
                            createdAt: block.createdAt,
                        },
                    ]),
                ),
            },
        },
    } as unknown as SessionState
}

function messagesWithUsage(created: number): WithParts[] {
    return [
        {
            info: {
                role: "assistant",
                tokens: { output: 10 },
                time: { created },
            },
        },
    ] as unknown as WithParts[]
}

test("lastUsageCreated returns the most recent assistant response time", () => {
    const messages = [
        { info: { role: "assistant", tokens: { output: 10 }, time: { created: 1000 } } },
        { info: { role: "assistant", tokens: { output: 5 }, time: { created: 2000 } } },
    ] as unknown as WithParts[]
    assert.equal(lastUsageCreated(messages), 2000)
})

test("activeCompressionSavings only counts blocks created after the usage", () => {
    const state = stateWith([
        { id: 1, compressed: 5000, summary: 500, createdAt: 1000 },
        { id: 2, compressed: 3000, summary: 1000, createdAt: 2000 },
        { id: 3, compressed: 1000, summary: 100, createdAt: 3000, active: false },
    ])
    assert.equal(activeCompressionSavings(state), 6500)
    assert.equal(activeCompressionSavings(state, 1500), 2000)
    assert.equal(activeCompressionSavings(state, 2500), 0)
})

test("effectiveContextTokens subtracts compression applied after the last usage", () => {
    const state = stateWith([
        { id: 1, compressed: 5000, summary: 500, createdAt: 1000 },
        { id: 2, compressed: 3000, summary: 1000, createdAt: 2000 },
    ])
    assert.equal(effectiveContextTokens(20000, state, messagesWithUsage(1500)), 18000)
    assert.equal(effectiveContextTokens(20000, state, messagesWithUsage(2500)), 20000)
})

test("effectiveContextTokens falls back to the provider total without usage", () => {
    const state = stateWith([{ id: 1, compressed: 5000, summary: 500, createdAt: 1000 }])
    assert.equal(effectiveContextTokens(20000, state, []), 20000)
})
