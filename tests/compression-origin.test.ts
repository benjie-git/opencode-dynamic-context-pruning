import assert from "node:assert/strict"
import { test } from "node:test"
import { applyCompressionState } from "../lib/compress/state"
import { Logger } from "../lib/logger"
import { syncCompressionBlocks } from "../lib/messages"
import { createSessionState, type WithParts } from "../lib/state"

test("background compression blocks survive sync using the selected anchor as origin", () => {
    const state = createSessionState("compact")
    state.prune.messages.byMessageId.set("anchor", {
        tokenCount: 100,
        allBlockIds: [],
        activeBlockIds: [],
    })

    applyCompressionState(
        state,
        {
            topic: "test",
            batchTopic: "test",
            startId: "anchor",
            endId: "anchor",
            mode: "range",
            runId: 1,
            summaryTokens: 10,
        },
        {
            startReference: {} as never,
            endReference: {} as never,
            messageIds: ["anchor"],
            messageTokenById: new Map([["anchor", 100]]),
            toolIds: [],
            requiredBlockIds: [],
        },
        "anchor",
        1,
        "summary",
        [],
    )

    const block = state.prune.messages.blocksById.get(1)
    assert.equal(block?.compressMessageId, "anchor")

    const messages = [{ info: { id: "anchor" } }] as unknown as WithParts[]
    syncCompressionBlocks(state, new Logger(false), messages)

    assert.equal(state.prune.messages.activeBlockIds.has(1), true)
})
