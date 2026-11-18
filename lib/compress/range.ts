import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "./types"
import { rangeFormat } from "../prompts/extensions/tool"
import { formatMessageRef, formatBlockRef, type IdFormat } from "../message-ids"
import { finalizeSession, prepareSession } from "./pipeline"
import { applyResolvedRangeCompression } from "./apply"
import { fillRangeSummaries, isPlannerEnabled, planAutoRangeCompression } from "./planner"
import { plannerRangeInstructions } from "../prompts/extensions/planner"
import { resolveRanges, validateArgs, validateNonOverlapping } from "./range-utils"
import { COMPRESSED_BLOCK_HEADER } from "./state"
import type { CompressRangeToolArgs } from "./types"

function buildSchema(format: IdFormat, plannerEnabled: boolean) {
    const content = tool.schema
        .array(
            tool.schema.object({
                startId: tool.schema
                    .string()
                    .describe(
                        `Message or block ID marking the beginning of range (e.g. ${formatMessageRef(1, format)}, ${formatBlockRef(2, format)})`,
                    ),
                endId: tool.schema
                    .string()
                    .describe(
                        `Message or block ID marking the end of range (e.g. ${formatMessageRef(12, format)}, ${formatBlockRef(5, format)})`,
                    ),
                summary: plannerEnabled
                    ? tool.schema
                          .string()
                          .optional()
                          .describe(
                              "Optional summary. Omit to let DCP's configured planner model write it.",
                          )
                    : tool.schema
                          .string()
                          .describe("Complete technical summary replacing all content in range"),
            }),
        )
        .describe("One or more ranges to compress, each with start/end boundaries and a summary")

    return {
        topic: tool.schema
            .string()
            .describe("Short label (3-5 words) for display - e.g., 'Auth System Exploration'"),
        content: plannerEnabled
            ? content
                  .optional()
                  .describe(
                      "Optional ranges to compress. Omit the whole field to let DCP choose the safest older ranges automatically.",
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

export function createCompressRangeTool(ctx: ToolContext): ReturnType<typeof tool> {
    ctx.prompts.reload()
    const runtimePrompts = ctx.prompts.getRuntimePrompts()
    const plannerEnabled = isPlannerEnabled(ctx)

    return tool({
        description:
            runtimePrompts.compressRange +
            rangeFormat(ctx.state.idFormat) +
            (plannerEnabled ? plannerRangeInstructions(ctx.state.idFormat) : ""),
        args: buildSchema(ctx.state.idFormat, plannerEnabled),
        async execute(args, toolCtx) {
            const input = args as CompressRangeToolArgs
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
                `Compress Range: ${input.topic}`,
            )

            let effectiveInput = input
            if (plannerEnabled) {
                if (!input.content || input.content.length === 0) {
                    effectiveInput = {
                        ...input,
                        content: await planAutoRangeCompression(
                            ctx,
                            toolCtx.sessionID,
                            input.topic,
                            input.focus,
                            searchContext,
                        ),
                    }
                } else {
                    const preliminaryPlans = resolveRanges(input, searchContext, ctx.state)
                    validateNonOverlapping(preliminaryPlans)
                    effectiveInput = {
                        ...input,
                        content: await fillRangeSummaries(
                            ctx,
                            toolCtx.sessionID,
                            input.topic,
                            input.focus,
                            preliminaryPlans,
                            searchContext,
                        ),
                    }
                }
                validateArgs(effectiveInput)
            }

            const resolvedPlans = resolveRanges(effectiveInput, searchContext, ctx.state)
            validateNonOverlapping(resolvedPlans)

            const { notifications, totalCompressedMessages } = await applyResolvedRangeCompression(
                ctx,
                searchContext,
                input.topic,
                resolvedPlans,
                {
                    messageID: toolCtx.messageID,
                    callID: callId,
                },
            )

            await finalizeSession(ctx, toolCtx, rawMessages, notifications, input.topic)

            return `Compressed ${totalCompressedMessages} messages into ${COMPRESSED_BLOCK_HEADER}.`
        },
    })
}
