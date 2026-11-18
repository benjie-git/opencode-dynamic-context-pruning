import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "./types"
import { messageFormat } from "../prompts/extensions/tool"
import { formatMessageRef, type IdFormat } from "../message-ids"
import { formatIssues, formatResult, resolveMessages, validateArgs } from "./message-utils"
import { finalizeSession, prepareSession } from "./pipeline"
import { applyResolvedMessageCompression } from "./apply"
import { fillMessageSummaries, isPlannerEnabled, planAutoMessageCompression } from "./planner"
import { plannerMessageInstructions } from "../prompts/extensions/planner"
import type { CompressMessageToolArgs } from "./types"

function buildSchema(format: IdFormat, plannerEnabled: boolean) {
    const content = tool.schema
        .array(
            tool.schema.object({
                messageId: tool.schema
                    .string()
                    .describe(`Raw message ID to compress (e.g. ${formatMessageRef(1, format)})`),
                topic: tool.schema
                    .string()
                    .describe("Short label (3-5 words) for this one message summary"),
                summary: plannerEnabled
                    ? tool.schema
                          .string()
                          .optional()
                          .describe(
                              "Optional summary. Omit to let DCP's configured planner model write it.",
                          )
                    : tool.schema
                          .string()
                          .describe("Complete technical summary replacing that one message"),
            }),
        )
        .describe("Batch of individual message summaries to create in one tool call")

    return {
        topic: tool.schema
            .string()
            .describe(
                "Short label (3-5 words) for the overall batch - e.g., 'Closed Research Notes'",
            ),
        content: plannerEnabled
            ? content
                  .optional()
                  .describe(
                      "Optional messages to compress. Omit the whole field to let DCP choose the safest older messages automatically.",
                  )
            : content,
        ...(plannerEnabled
            ? {
                  focus: tool.schema
                      .string()
                      .optional()
                      .describe(
                          "Optional guidance for the planner about what to preserve or prioritize",
                      ),
              }
            : {}),
    }
}

export function createCompressMessageTool(ctx: ToolContext): ReturnType<typeof tool> {
    ctx.prompts.reload()
    const runtimePrompts = ctx.prompts.getRuntimePrompts()
    const plannerEnabled = isPlannerEnabled(ctx)

    return tool({
        description:
            runtimePrompts.compressMessage +
            messageFormat(ctx.state.idFormat) +
            (plannerEnabled ? plannerMessageInstructions(ctx.state.idFormat) : ""),
        args: buildSchema(ctx.state.idFormat, plannerEnabled),
        async execute(args, toolCtx) {
            const input = args as CompressMessageToolArgs
            validateArgs(input, {
                allowEmptyContent: plannerEnabled,
                allowMissingSummary: plannerEnabled,
            })
            const callId =
                typeof (toolCtx as unknown as { callID?: unknown }).callID === "string"
                    ? (toolCtx as unknown as { callID: string }).callID
                    : undefined

            const { rawMessages, searchContext } = await prepareSession(
                ctx,
                toolCtx,
                `Compress Message: ${input.topic}`,
            )

            let effectiveInput = input
            let preliminaryIssues: string[] = []
            let preliminarySkippedCount = 0
            if (plannerEnabled) {
                if (!input.content || input.content.length === 0) {
                    effectiveInput = {
                        ...input,
                        content: await planAutoMessageCompression(
                            ctx,
                            toolCtx.sessionID,
                            input.topic,
                            input.focus,
                            searchContext,
                        ),
                    }
                } else {
                    const preliminary = resolveMessages(input, searchContext, ctx.state, ctx.config)
                    preliminaryIssues = preliminary.skippedIssues
                    preliminarySkippedCount = preliminary.skippedCount
                    if (preliminary.plans.length === 0) {
                        throw new Error(formatIssues(preliminaryIssues, preliminarySkippedCount))
                    }
                    effectiveInput = {
                        ...input,
                        content: await fillMessageSummaries(
                            ctx,
                            toolCtx.sessionID,
                            input.topic,
                            input.focus,
                            preliminary.plans,
                            searchContext,
                        ),
                    }
                }
                validateArgs(effectiveInput)
            }

            const resolved = resolveMessages(effectiveInput, searchContext, ctx.state, ctx.config)
            const { plans } = resolved
            const skippedIssues = [...preliminaryIssues, ...resolved.skippedIssues]
            const skippedCount = preliminarySkippedCount + resolved.skippedCount

            if (plans.length === 0 && skippedCount > 0) {
                throw new Error(formatIssues(skippedIssues, skippedCount))
            }

            const { notifications } = await applyResolvedMessageCompression(
                ctx,
                searchContext,
                input.topic,
                plans,
                { messageID: toolCtx.messageID, callID: callId },
            )

            await finalizeSession(ctx, toolCtx, rawMessages, notifications, input.topic)

            return formatResult(plans.length, skippedIssues, skippedCount)
        },
    })
}
