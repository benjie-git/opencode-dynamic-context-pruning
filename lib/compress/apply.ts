import { countTokens } from "../token-utils"
import {
    appendProtectedPromptInfo,
    appendProtectedTools,
    appendProtectedUserMessages,
} from "./protected-content"
import {
    appendMissingBlockSummaries,
    injectBlockPlaceholders,
    parseBlockPlaceholders,
    validateSummaryPlaceholders,
} from "./range-utils"
import {
    allocateBlockId,
    allocateRunId,
    applyCompressionState,
    wrapCompressedSummary,
} from "./state"
import type { NotificationEntry } from "./pipeline"
import type {
    ResolvedMessageCompression,
    ResolvedRangeCompression,
    SearchContext,
    ToolContext,
} from "./types"

export interface CompressionToolMeta {
    messageID?: string
    callID?: string
}

export interface AppliedCompression {
    notifications: NotificationEntry[]
    totalCompressedMessages: number
}

export async function applyResolvedRangeCompression(
    ctx: ToolContext,
    searchContext: SearchContext,
    topic: string,
    plans: ResolvedRangeCompression[],
    meta: CompressionToolMeta,
): Promise<AppliedCompression> {
    const notifications: NotificationEntry[] = []
    const preparedPlans: Array<{
        entry: (typeof plans)[number]["entry"]
        selection: (typeof plans)[number]["selection"]
        anchorMessageId: string
        finalSummary: string
        consumedBlockIds: number[]
    }> = []
    let totalCompressedMessages = 0

    for (const plan of plans) {
        const parsedPlaceholders = parseBlockPlaceholders(plan.entry.summary, ctx.state.idFormat)
        const missingBlockIds = validateSummaryPlaceholders(
            parsedPlaceholders,
            plan.selection.requiredBlockIds,
            plan.selection.startReference,
            plan.selection.endReference,
            searchContext.summaryByBlockId,
        )

        const injected = injectBlockPlaceholders(
            plan.entry.summary,
            parsedPlaceholders,
            searchContext.summaryByBlockId,
            plan.selection.startReference,
            plan.selection.endReference,
        )

        const summaryWithUsers = appendProtectedUserMessages(
            injected.expandedSummary,
            plan.selection,
            searchContext,
            ctx.state,
            ctx.config.compress.protectUserMessages,
        )

        const summaryWithPromptInfo = appendProtectedPromptInfo(
            summaryWithUsers,
            plan.selection,
            searchContext,
            ctx.state,
            ctx.config.compress.protectTags,
        )

        const summaryWithTools = await appendProtectedTools(
            ctx.client,
            ctx.state,
            ctx.config.experimental.allowSubAgents,
            summaryWithPromptInfo,
            plan.selection,
            searchContext,
            ctx.config.compress.protectedTools,
            ctx.config.protectedFilePatterns,
        )

        const completedSummary = appendMissingBlockSummaries(
            summaryWithTools,
            missingBlockIds,
            searchContext.summaryByBlockId,
            injected.consumedBlockIds,
            ctx.state.idFormat,
        )

        preparedPlans.push({
            entry: plan.entry,
            selection: plan.selection,
            anchorMessageId: plan.anchorMessageId,
            finalSummary: completedSummary.expandedSummary,
            consumedBlockIds: completedSummary.consumedBlockIds,
        })
    }

    const runId = allocateRunId(ctx.state)

    for (const preparedPlan of preparedPlans) {
        const blockId = allocateBlockId(ctx.state)
        const storedSummary = wrapCompressedSummary(
            blockId,
            preparedPlan.finalSummary,
            ctx.state.idFormat,
        )
        const summaryTokens = countTokens(storedSummary)

        const applied = applyCompressionState(
            ctx.state,
            {
                topic,
                batchTopic: topic,
                startId: preparedPlan.entry.startId,
                endId: preparedPlan.entry.endId,
                mode: "range",
                runId,
                compressMessageId: meta.messageID,
                compressCallId: meta.callID,
                summaryTokens,
            },
            preparedPlan.selection,
            preparedPlan.anchorMessageId,
            blockId,
            storedSummary,
            preparedPlan.consumedBlockIds,
        )

        totalCompressedMessages += applied.messageIds.length

        notifications.push({
            blockId,
            runId,
            summary: preparedPlan.finalSummary,
            summaryTokens,
        })
    }

    return { notifications, totalCompressedMessages }
}

export async function applyResolvedMessageCompression(
    ctx: ToolContext,
    searchContext: SearchContext,
    topic: string,
    plans: ResolvedMessageCompression[],
    meta: CompressionToolMeta,
): Promise<AppliedCompression> {
    const notifications: NotificationEntry[] = []
    const preparedPlans: Array<{
        plan: (typeof plans)[number]
        summaryWithTools: string
    }> = []

    for (const plan of plans) {
        const summaryWithPromptInfo = appendProtectedPromptInfo(
            plan.entry.summary,
            plan.selection,
            searchContext,
            ctx.state,
            ctx.config.compress.protectTags,
        )

        const summaryWithTools = await appendProtectedTools(
            ctx.client,
            ctx.state,
            ctx.config.experimental.allowSubAgents,
            summaryWithPromptInfo,
            plan.selection,
            searchContext,
            ctx.config.compress.protectedTools,
            ctx.config.protectedFilePatterns,
        )

        preparedPlans.push({ plan, summaryWithTools })
    }

    const runId = allocateRunId(ctx.state)

    for (const { plan, summaryWithTools } of preparedPlans) {
        const blockId = allocateBlockId(ctx.state)
        const storedSummary = wrapCompressedSummary(blockId, summaryWithTools, ctx.state.idFormat)
        const summaryTokens = countTokens(storedSummary)

        applyCompressionState(
            ctx.state,
            {
                topic: plan.entry.topic,
                batchTopic: topic,
                startId: plan.entry.messageId,
                endId: plan.entry.messageId,
                mode: "message",
                runId,
                compressMessageId: meta.messageID,
                compressCallId: meta.callID,
                summaryTokens,
            },
            plan.selection,
            plan.anchorMessageId,
            blockId,
            storedSummary,
            [],
        )

        notifications.push({
            blockId,
            runId,
            summary: summaryWithTools,
            summaryTokens,
        })
    }

    return { notifications, totalCompressedMessages: notifications.length }
}
