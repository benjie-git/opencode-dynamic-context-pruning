import assert from "node:assert/strict"
import { test } from "node:test"
import {
    autoCandidates,
    compactionInfo,
    dropUnavailableVariant,
    parsePlannerMessages,
    parsePlannerModel,
    parsePlannerRanges,
    renderMessage,
    renderTranscript,
    resolvePlannerModel,
} from "../lib/compress/planner"
import type { PluginConfig } from "../lib/config"
import { createSessionState, type WithParts } from "../lib/state"
import type { ToolContext } from "../lib/compress/types"

function stateWithModel(modelRef?: ReturnType<typeof createSessionState>["modelRef"]) {
    const state = createSessionState()
    state.idFormat = "compact"
    state.modelRef = modelRef
    state.messageIds.byRawId.set("msg_1", "@1@")
    state.messageIds.byRawId.set("msg_2", "@2@")
    state.messageIds.byRef.set("@1@", "msg_1")
    state.messageIds.byRef.set("@2@", "msg_2")
    return state
}

function userMessage(id: string, text: string, model?: unknown): WithParts {
    return {
        info: { id, role: "user", model },
        parts: [{ type: "text", text }],
    } as unknown as WithParts
}

test("parsePlannerModel parses object and variant forms", () => {
    const parsed = parsePlannerModel({
        providerID: "opencode",
        model: "deepseek-v4.1-flash",
        variant: "low",
    })
    assert.deepEqual(parsed, {
        providerID: "opencode",
        id: "deepseek-v4.1-flash",
        variant: "low",
    })
    assert.equal(parsePlannerModel("not-a-model"), null)
})

test("resolvePlannerModel defaults to session model with low variant", () => {
    const state = stateWithModel({ providerID: "p", id: "m", variant: "high" })
    const config = {
        compress: { planner: { enabled: true, variant: "low" } },
    } as unknown as PluginConfig
    assert.deepEqual(resolvePlannerModel(config, state), {
        providerID: "p",
        id: "m",
        variant: "low",
    })
})

test("resolvePlannerModel accepts a level-only model object", () => {
    const state = stateWithModel({ providerID: "p", id: "m", variant: "high" })
    const config = {
        compress: { planner: { enabled: true, model: { variant: "medium" } } },
    } as unknown as PluginConfig
    assert.deepEqual(resolvePlannerModel(config, state), {
        providerID: "p",
        id: "m",
        variant: "medium",
    })
})

test("resolvePlannerModel uses configured planner model", () => {
    const state = stateWithModel({ providerID: "p", id: "m", variant: "high" })
    const config = {
        compress: {
            planner: {
                enabled: true,
                model: { providerID: "q", model: "n", variant: "medium" },
            },
        },
    } as unknown as PluginConfig
    assert.deepEqual(resolvePlannerModel(config, state), {
        providerID: "q",
        id: "n",
        variant: "medium",
    })
})

test("resolvePlannerModel finds model from latest user message", () => {
    const state = stateWithModel()
    const messages = [
        userMessage("msg_1", "hello", { providerID: "p", modelID: "m", variant: "high" }),
    ]
    const config = {
        compress: { planner: { enabled: true, variant: "low" } },
    } as unknown as PluginConfig
    assert.deepEqual(resolvePlannerModel(config, state, messages), {
        providerID: "p",
        id: "m",
        variant: "low",
    })
})

test("resolvePlannerModel returns null when disabled", () => {
    const config = { compress: { planner: { enabled: false } } } as unknown as PluginConfig
    assert.equal(resolvePlannerModel(config, stateWithModel()), null)
})

test("parsePlannerRanges parses fenced JSON", () => {
    const text = '```json\n{"ranges":[{"startId":"@1@","endId":"@2@","summary":"ok"}]}\n```'
    assert.deepEqual(parsePlannerRanges(text), [
        { startId: "@1@", endId: "@2@", topic: undefined, summary: "ok" },
    ])
})

test("parsePlannerMessages parses summary payloads", () => {
    const text = '{"messages":[{"messageId":"@1@","topic":"t","summary":"s"}]}'
    assert.deepEqual(parsePlannerMessages(text), [{ messageId: "@1@", topic: "t", summary: "s" }])
})

test("renderMessage includes ref and text and marks protected messages", () => {
    const state = stateWithModel()
    const message = userMessage("msg_1", "keep this")
    const rendered = renderMessage(message, state)
    assert.match(rendered ?? "", /@1@/)
    assert.match(rendered ?? "", /keep this/)
})

test("autoCandidates excludes the latest user request", () => {
    const state = stateWithModel()
    const messages = [userMessage("msg_1", "old"), userMessage("msg_2", "latest")]
    const ctx = {
        state,
        config: { compress: { mode: "range" } },
    } as unknown as ToolContext
    const candidates = autoCandidates(ctx, {
        rawMessages: messages,
        rawMessagesById: new Map(messages.map((message) => [message.info.id, message])),
    } as never)
    assert.deepEqual(
        candidates.map((message) => message.info.id),
        ["msg_1"],
    )
})

test("renderTranscript includes active compressed block summaries", () => {
    const state = stateWithModel()
    state.prune.messages.blocksById.set(1, {
        blockId: 1,
        active: true,
        anchorMessageId: "msg_1",
        summary: "[Compressed conversation section]\nolder findings",
    } as never)

    const rendered = renderTranscript([userMessage("msg_1", "raw")], state, {
        includeCompressedBlocks: true,
    })

    assert.match(rendered, /older findings/)
    assert.match(rendered, /compressed block/)
})

test("dropUnavailableVariant only keeps variants the model supports", () => {
    const model = { providerID: "p", id: "m", variant: "low" }

    assert.deepEqual(dropUnavailableVariant(model, new Set(["low"])), model)
    assert.deepEqual(dropUnavailableVariant(model, undefined), model)
    assert.deepEqual(dropUnavailableVariant(model, new Set(["high"])), {
        providerID: "p",
        id: "m",
    })
})

test("compactionInfo reports the configured model and thinking level", () => {
    const config = {
        compress: {
            planner: {
                enabled: true,
                model: "openrouter/deepseek/deepseek-v4.1-flash-1017#high",
            },
        },
    } as unknown as PluginConfig

    assert.deepEqual(compactionInfo(config), {
        enabled: true,
        model: "openrouter/deepseek/deepseek-v4.1-flash-1017",
        variant: "high",
    })
})

test("compactionInfo shows only the level when no model is configured", () => {
    const config = {
        compress: { planner: { enabled: true, variant: "low" } },
    } as unknown as PluginConfig

    assert.deepEqual(compactionInfo(config), { enabled: true, variant: "low" })
})

test("compactionInfo is disabled when the planner is disabled", () => {
    const config = {
        compress: { planner: { enabled: false, variant: "low" } },
    } as unknown as PluginConfig

    assert.deepEqual(compactionInfo(config), { enabled: false })
})
