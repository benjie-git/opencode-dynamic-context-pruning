import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync } from "node:fs"
import { createSessionState, type WithParts } from "../lib/state"
import { Logger } from "../lib/logger"
import { assignMessageRefs } from "../lib/message-ids"
import { buildSearchContext } from "../lib/compress/search"
import { applyResolvedRangeCompression } from "../lib/compress/apply"
import { resolveRanges } from "../lib/compress/range-utils"
import { prune } from "../lib/messages/prune"
import {
    isBackgroundCompressionPlanCurrent,
    markBackgroundCompressionDue,
    startBackgroundCompression,
    takeBackgroundCompressionPlan,
    takeDueBackgroundCompression,
} from "../lib/compress/precompute"
import { resolveBackgroundLeadTokens } from "../lib/messages/inject/utils"

process.env.XDG_DATA_HOME = join(tmpdir(), `opencode-dcp-precompute-data-${process.pid}`)
process.env.XDG_CONFIG_HOME = join(tmpdir(), `opencode-dcp-precompute-config-${process.pid}`)
mkdirSync(process.env.XDG_DATA_HOME, { recursive: true })
mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true })

const sessionID = "ses-precompute"

function messages(): WithParts[] {
    return [
        {
            info: {
                id: "msg-user-1",
                role: "user",
                sessionID,
                model: { providerID: "anthropic", modelID: "claude-test" },
                time: { created: 1 },
            },
            parts: [{ type: "text", text: "Investigate the release flow" }],
        },
        {
            info: { id: "msg-assistant-1", role: "assistant", sessionID, time: { created: 2 } },
            parts: [{ type: "text", text: "I found the publish script and its tests" }],
        },
        {
            info: {
                id: "msg-user-2",
                role: "user",
                sessionID,
                model: { providerID: "anthropic", modelID: "claude-test" },
                time: { created: 3 },
            },
            parts: [{ type: "text", text: "Now fix the remaining bug" }],
        },
    ] as unknown as WithParts[]
}

function buildConfig() {
    return {
        enabled: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        manualMode: { enabled: false, automaticStrategies: true },
        turnProtection: { enabled: false, turns: 4 },
        experimental: { allowSubAgents: true, customPrompts: false },
        protectedFilePatterns: [],
        compress: {
            mode: "range",
            permission: "allow",
            showCompression: false,
            summaryBuffer: true,
            planner: { enabled: true, variant: "low" },
            background: { enabled: true, lead: "15%" },
            maxContextLimit: 150000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
        },
        strategies: {
            deduplication: { enabled: true, protectedTools: [] },
            purgeErrors: { enabled: true, turns: 4, protectedTools: [] },
        },
    } as any
}

async function readyPlan(onReady?: () => void) {
    const raw = messages()
    const state = createSessionState()
    state.compressPermission = "allow"
    assignMessageRefs(state, raw)
    const config = buildConfig()
    const start = state.messageIds.byRawId.get("msg-user-1")!
    const end = state.messageIds.byRawId.get("msg-assistant-1")!
    const ctx = {
        client: {},
        state,
        logger: new Logger(false),
        config,
        prompts: { reload() {}, getRuntimePrompts: () => ({}) },
        planner: async () =>
            JSON.stringify([{ startId: start, endId: end, summary: "summary of the first turn" }]),
    }
    const started = startBackgroundCompression({
        ctx: ctx as any,
        sessionID,
        messages: raw,
        searchContext: buildSearchContext(state, raw),
        modelKey: "anthropic/claude-test",
        currentTokens: 130000,
        ...(onReady ? { onReady } : {}),
    })
    assert.equal(started, true)

    for (let attempt = 0; attempt < 100; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10))
        const plan = takeBackgroundCompressionPlan(sessionID)
        if (plan) {
            return { plan, raw, state, ctx }
        }
    }
    throw new Error("background compression plan did not become ready")
}

test("background compression plan becomes ready and validates its snapshot", async () => {
    const { plan, raw } = await readyPlan()
    assert.equal(plan.status, "ready")
    assert.equal(plan.mode, "range")
    assert.equal(plan.entries?.length, 1)
    assert.equal(isBackgroundCompressionPlanCurrent(plan, raw, "anthropic/claude-test"), true)
    assert.equal(isBackgroundCompressionPlanCurrent(plan, raw, "openai/other-model"), false)
    assert.equal(
        isBackgroundCompressionPlanCurrent(plan, raw.slice(1), "anthropic/claude-test"),
        false,
    )
})

test("onReady fires once when the background plan becomes ready", async () => {
    let calls = 0
    await readyPlan(() => {
        calls += 1
    })
    assert.equal(calls, 1)
})

test("a ready plan applies compression blocks that prune materializes", async () => {
    const { plan, raw, state, ctx } = await readyPlan()
    const searchContext = buildSearchContext(state, raw)
    const resolved = resolveRanges(
        { topic: plan.topic, content: plan.entries as any },
        searchContext,
        state,
    )
    const applied = await applyResolvedRangeCompression(
        ctx as any,
        searchContext,
        plan.topic,
        resolved,
        {},
    )
    assert.equal(applied.notifications.length, 1)
    assert.equal(state.prune.messages.activeBlockIds.size, 1)

    const view = structuredClone(raw)
    prune(state, new Logger(false), buildConfig(), view)
    const text = JSON.stringify(view)
    assert.match(text, /Compressed conversation section/)
    assert.doesNotMatch(text, /Investigate the release flow/)
})

test("does not start a second plan from usage that predates the applied compression", async () => {
    const { plan, raw, state, ctx } = await readyPlan()
    const assistant = raw[1].info as any
    assistant.tokens = { output: 10 }
    assistant.time = { created: 2 }

    const searchContext = buildSearchContext(state, raw)
    const resolved = resolveRanges(
        { topic: plan.topic, content: plan.entries as any },
        searchContext,
        state,
    )
    await applyResolvedRangeCompression(ctx as any, searchContext, plan.topic, resolved, {})

    assert.equal(
        startBackgroundCompression({
            ctx: ctx as any,
            sessionID,
            messages: raw,
            searchContext: buildSearchContext(state, raw),
            modelKey: "anthropic/claude-test",
            currentTokens: 130000,
        }),
        false,
    )
})

test("applies only the planned chunks and keeps turns added while planning", async () => {
    const { plan, raw, state, ctx } = await readyPlan()
    const extended = [
        ...raw,
        {
            info: {
                id: "msg-user-3",
                role: "user",
                sessionID,
                model: { providerID: "anthropic", modelID: "claude-test" },
                time: { created: 4 },
            },
            parts: [{ type: "text", text: "Continue while compressing" }],
        },
        {
            info: {
                id: "msg-assistant-3",
                role: "assistant",
                sessionID,
                time: { created: 5 },
            },
            parts: [{ type: "text", text: "The new turn is untouched" }],
        },
    ] as unknown as WithParts[]
    assignMessageRefs(state, extended)

    // Appending messages after the planned boundary does not invalidate the plan.
    assert.equal(isBackgroundCompressionPlanCurrent(plan, extended, "anthropic/claude-test"), true)

    const searchContext = buildSearchContext(state, extended)
    const resolved = resolveRanges(
        { topic: plan.topic, content: plan.entries as any },
        searchContext,
        state,
    )
    await applyResolvedRangeCompression(ctx as any, searchContext, plan.topic, resolved, {})

    const view = structuredClone(extended)
    prune(state, new Logger(false), buildConfig(), view)
    const text = JSON.stringify(view)
    assert.match(text, /Compressed conversation section/)
    assert.doesNotMatch(text, /Investigate the release flow/)
    assert.match(text, /Continue while compressing/)
    assert.match(text, /The new turn is untouched/)
})

test("background compression attempts are capped after repeated failures", async () => {
    const raw = messages()
    const state = createSessionState()
    state.compressPermission = "allow"
    assignMessageRefs(state, raw)
    const config = buildConfig()
    const ctx = {
        client: {},
        state,
        logger: new Logger(false),
        config,
        prompts: { reload() {}, getRuntimePrompts: () => ({}) },
        planner: async () => {
            throw new Error("planner failed")
        },
    }
    const start = () =>
        startBackgroundCompression({
            ctx: ctx as any,
            sessionID: "ses-precompute-failures",
            messages: raw,
            searchContext: buildSearchContext(state, raw),
            modelKey: "anthropic/claude-test",
            currentTokens: 130000,
        })

    assert.equal(start(), true)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(start(), true)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(start(), false)
})

test("lead tokens accept numbers and percentages of the resolved max", () => {
    assert.equal(resolveBackgroundLeadTokens(20000, 100000), 20000)
    assert.equal(resolveBackgroundLeadTokens("15%", 100000), 15000)
    assert.equal(resolveBackgroundLeadTokens("15%", undefined), undefined)
    assert.equal(resolveBackgroundLeadTokens(-5, 100000), 0)
})

test("a queued background request is taken exactly once", () => {
    const state = createSessionState()
    const raw = messages()
    const request = {
        ctx: {} as never,
        sessionID: "ses-precheck-due",
        messages: raw,
        searchContext: buildSearchContext(state, raw),
        modelKey: "anthropic/claude-test",
        currentTokens: 130000,
    }

    markBackgroundCompressionDue(request as never)
    assert.equal(takeDueBackgroundCompression("ses-precheck-due"), request)
    assert.equal(takeDueBackgroundCompression("ses-precheck-due"), undefined)
})
