import { tool } from "@opencode-ai/plugin"

const z = tool.schema
const session = z.object({ sessionID: z.string() })
const stats = z.object({
    sessionTokens: z.number(),
    sessionSummaryTokens: z.number(),
    sessionDurationMs: z.number(),
    sessionTools: z.number(),
    sessionMessages: z.number(),
    allTime: z.object({
        totalTokens: z.number(),
        totalTools: z.number(),
        totalMessages: z.number(),
        sessionCount: z.number(),
    }),
})
const context = z.object({
    system: z.number(),
    user: z.number(),
    assistant: z.number(),
    tools: z.number(),
    toolCount: z.number(),
    toolsInContextCount: z.number(),
    prunedTokens: z.number(),
    prunedToolCount: z.number(),
    prunedMessageCount: z.number(),
    total: z.number(),
})

const compaction = z.object({
    enabled: z.boolean(),
    model: z.string().optional(),
    variant: z.string().optional(),
})

const background = z.object({
    status: z.enum(["idle", "ready", "running", "failed"]),
    failures: z.number().optional(),
    error: z.string().optional(),
    startsAt: z.number().optional(),
    currentTokens: z.number().optional(),
})

export const rpc = {
    id: "dcp",
    methods: {
        status: { input: z.object({}), output: z.object({ enabled: z.boolean() }) },
        snapshot: {
            input: session,
            output: z.object({
                manualMode: z.boolean(),
                canCompress: z.boolean(),
                blockedReason: z.string().optional(),
                compaction,
                background,
                effectiveTokens: z.number(),
                savedTokens: z.number(),
                context,
                stats,
            }),
        },
        manual: { input: session.extend({ enabled: z.boolean() }), output: z.object({}) },
    },
    events: {},
} as const
