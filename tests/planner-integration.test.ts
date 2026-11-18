import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync } from "node:fs"
import { createCompressRangeTool } from "../lib/compress/range"
import { createCompressMessageTool } from "../lib/compress/message"
import { createSessionState, type WithParts } from "../lib/state"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"

process.env.XDG_DATA_HOME = join(tmpdir(), `opencode-dcp-planner-data-${process.pid}`)
process.env.XDG_CONFIG_HOME = join(tmpdir(), `opencode-dcp-planner-config-${process.pid}`)
mkdirSync(process.env.XDG_DATA_HOME, { recursive: true })
mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true })

function buildConfig(mode: "range" | "message" = "range"): PluginConfig {
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
            mode,
            permission: "allow",
            showCompression: false,
            planner: { enabled: true, variant: "low" },
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
    }
}

function messages(sessionID: string): WithParts[] {
    return [
        {
            info: {
                id: "msg-user-1",
                role: "user",
                sessionID,
                model: { providerID: "anthropic", modelID: "claude-test", variant: "high" },
                time: { created: 1 },
            } as WithParts["info"],
            parts: [{ type: "text", text: "Investigate the release flow" }],
        },
        {
            info: {
                id: "msg-assistant-1",
                role: "assistant",
                sessionID,
                time: { created: 2 },
            } as WithParts["info"],
            parts: [{ type: "text", text: "I found the publish script and its tests" }],
        },
        {
            info: {
                id: "msg-user-2",
                role: "user",
                sessionID,
                model: { providerID: "anthropic", modelID: "claude-test", variant: "high" },
                time: { created: 3 },
            } as WithParts["info"],
            parts: [{ type: "text", text: "Now fix the remaining bug" }],
        },
    ] as unknown as WithParts[]
}

function buildTool(
    rawMessages: WithParts[],
    prompts: string[],
    response: string,
    mode: "range" | "message" = "range",
): ReturnType<typeof createCompressRangeTool> {
    const createTool = mode === "message" ? createCompressMessageTool : createCompressRangeTool
    return createTool({
        client: {
            session: {
                messages: async () => ({ data: rawMessages }),
                get: async () => ({ data: { parentID: null } }),
            },
        },
        state: createSessionState(),
        logger: new Logger(false),
        config: buildConfig(mode),
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compressRange: "", compressMessage: "" }
            },
        },
        planner: async ({ prompt }) => {
            prompts.push(prompt)
            return response
        },
    } as any)
}

const runContext = (sessionID: string) => ({
    ask: async () => {},
    metadata: () => {},
    sessionID,
    messageID: "msg-compress",
})

test("planner mode fills missing summaries for explicit ranges", async () => {
    const sessionID = `ses_planner_explicit_${Date.now()}`
    const prompts: string[] = []
    const tool = buildTool(
        messages(sessionID),
        prompts,
        '{"summaries":[{"startId":"m0001","endId":"m0002","summary":"Planned range summary."}]}',
    )

    const result = await tool.execute(
        {
            topic: "Release investigation",
            content: [{ startId: "m0001", endId: "m0002" }],
        },
        runContext(sessionID),
    )

    assert.match(result, /Compressed 2 messages/)
    assert.equal(prompts.length, 1)
    assert.match(prompts[0]!, /Investigate the release flow/)
})

test("planner mode auto-selects older ranges when content is omitted", async () => {
    const sessionID = `ses_planner_auto_${Date.now()}`
    const prompts: string[] = []
    const tool = buildTool(
        messages(sessionID),
        prompts,
        '{"ranges":[{"startId":"m0001","endId":"m0002","summary":"Auto planned summary."}]}',
    )

    const result = await tool.execute({ topic: "Old context" }, runContext(sessionID))

    assert.match(result, /Compressed 2 messages/)
    assert.equal(prompts.length, 1)
    assert.doesNotMatch(prompts[0]!, /Now fix the remaining bug/)
})

test("planner auto mode message tool generates summaries", async () => {
    const sessionID = `ses_planner_message_${Date.now()}`
    const prompts: string[] = []
    const tool = buildTool(
        messages(sessionID),
        prompts,
        '{"messages":[{"messageId":"m0001","summary":"Planned message summary."}]}',
        "message",
    )

    const result = await tool.execute({ topic: "Old context" }, runContext(sessionID))

    assert.match(result, /Compressed 1 message/)
    assert.equal(prompts.length, 1)
})

test("planner auto range ignores selections outside the candidate window", async () => {
    const sessionID = `ses_planner_auto_invalid_${Date.now()}`
    const tool = buildTool(
        messages(sessionID),
        [],
        '{"ranges":[{"startId":"m0003","endId":"m0003","summary":"Latest request."}]}',
    )

    await assert.rejects(
        tool.execute({ topic: "Old context" }, runContext(sessionID)),
        /selected no ranges/,
    )
})

test("planner auto range keeps valid candidates while dropping later ones", async () => {
    const sessionID = `ses_planner_auto_mixed_${Date.now()}`
    const tool = buildTool(
        messages(sessionID),
        [],
        '{"ranges":[{"startId":"m0003","endId":"m0003","summary":"Latest request."},{"startId":"m0001","endId":"m0002","summary":"Older work."}]}',
    )

    const result = await tool.execute({ topic: "Old context" }, runContext(sessionID))

    assert.match(result, /Compressed 2 messages/)
})

test("planner auto message ignores selections outside the candidate window", async () => {
    const sessionID = `ses_planner_message_invalid_${Date.now()}`
    const tool = buildTool(
        messages(sessionID),
        [],
        '{"messages":[{"messageId":"m0003","summary":"Latest request."}]}',
        "message",
    )

    await assert.rejects(
        tool.execute({ topic: "Old context" }, runContext(sessionID)),
        /selected no messages/,
    )
})

test("planner message mode reports entries skipped before summary generation", async () => {
    const sessionID = `ses_planner_message_skips_${Date.now()}`
    const tool = buildTool(
        messages(sessionID),
        [],
        '{"summaries":[{"messageId":"m0001","summary":"Planned message summary."}]}',
        "message",
    )

    const result = await tool.execute(
        {
            topic: "Old context",
            content: [
                { messageId: "m0001", topic: "Old work" },
                { messageId: "m9999", topic: "Missing" },
            ],
        },
        runContext(sessionID),
    )

    assert.match(result, /Compressed 1 message/)
    assert.match(result, /Skipped 1 issue/)
})

test("planner message mode reports all skipped entries when no plan remains", async () => {
    const sessionID = `ses_planner_message_no_plans_${Date.now()}`
    const tool = buildTool(messages(sessionID), [], "{}", "message")

    await assert.rejects(
        tool.execute(
            {
                topic: "Old context",
                content: [{ messageId: "m9999", topic: "Missing" }],
            },
            runContext(sessionID),
        ),
        /Unable to compress any messages/,
    )
})
