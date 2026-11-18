import type { PluginConfig } from "../config"
import type { CompressionMode, WithParts } from "../state"
import { isIgnoredUserMessage } from "../messages/query"
import { compressionSinceUsage } from "./estimate"
import { planAutoMessageCompression, planAutoRangeCompression } from "./planner"
import type { CompressMessageEntry, CompressRangeEntry, SearchContext, ToolContext } from "./types"

const TOPIC = "Automatic compression"
const MAX_FAILURES = 2
const FAILURE_COOLDOWN_MS = 5 * 60_000

export interface BackgroundCompressionPlan {
    sessionID: string
    mode: CompressionMode
    topic: string
    modelKey?: string
    firstMessageId?: string
    lastMessageId?: string
    createdAt: number
    status: "running" | "ready" | "failed"
    entries?: CompressRangeEntry[] | CompressMessageEntry[]
    error?: string
    failures: number
    retryAt?: number
}

export interface StartBackgroundCompressionInput {
    ctx: ToolContext
    sessionID: string
    messages: WithParts[]
    searchContext: SearchContext
    modelKey?: string
    currentTokens: number
    /** Called in the background as soon as the plan is ready, so it can be applied while idle. */
    onReady?: () => void
}

const plans = new Map<string, BackgroundCompressionPlan>()
const due = new Map<string, StartBackgroundCompressionInput>()

export function backgroundCompressionEnabled(config: PluginConfig): boolean {
    return config.compress.background.enabled && (config.compress.planner?.enabled ?? false)
}

/**
 * Records that compression will be needed soon. The planner is started from the
 * session's idle hook instead, so it cannot compete with the step's model request.
 */
export function markBackgroundCompressionDue(input: StartBackgroundCompressionInput): void {
    due.set(input.sessionID, input)
}

export function takeDueBackgroundCompression(
    sessionID: string,
): StartBackgroundCompressionInput | undefined {
    const input = due.get(sessionID)
    due.delete(sessionID)
    return input
}

export function clearBackgroundCompressionDue(sessionID: string): void {
    due.delete(sessionID)
}

export interface BackgroundCompressionSnapshot {
    status: "idle" | "running" | "ready" | "failed"
    failures?: number
    error?: string
    /** Token count at which background planning starts for this session. */
    startsAt?: number
    /** Current provider-reported context usage. */
    currentTokens?: number
}

export function backgroundCompressionStatus(sessionID: string): BackgroundCompressionSnapshot {
    const plan = plans.get(sessionID)
    if (!plan) {
        return { status: "idle" }
    }
    return {
        status: plan.status,
        ...(plan.failures > 0 ? { failures: plan.failures } : {}),
        ...(plan.error ? { error: plan.error } : {}),
    }
}

export function startBackgroundCompression(input: StartBackgroundCompressionInput): boolean {
    const { ctx, sessionID } = input
    if (!backgroundCompressionEnabled(ctx.config)) {
        return false
    }
    if (ctx.state.compressPermission !== "allow") {
        return false
    }
    if (ctx.state.isSubAgent && !ctx.config.experimental.allowSubAgents) {
        return false
    }
    if (ctx.state.manualMode) {
        return false
    }
    // The provider count predates the compression just applied, so it would look
    // over budget and immediately trigger a second plan. Wait for the next response
    // to report the real size before planning again.
    if (compressionSinceUsage(ctx.state, input.messages)) {
        return false
    }

    const existing = plans.get(sessionID)
    if (existing?.status === "running" || existing?.status === "ready") {
        return false
    }
    if (existing?.status === "failed" && existing.retryAt !== undefined) {
        if (Date.now() < existing.retryAt) {
            return false
        }
        // Cooldown elapsed: allow a fresh series of attempts.
        existing.failures = 0
        existing.retryAt = undefined
    }

    const plan: BackgroundCompressionPlan = {
        sessionID,
        mode: ctx.config.compress.mode,
        topic: TOPIC,
        modelKey: input.modelKey,
        firstMessageId: firstMessageId(input.messages),
        lastMessageId: input.messages.at(-1)?.info.id,
        createdAt: Date.now(),
        status: "running",
        failures: existing?.failures ?? 0,
    }
    plans.set(sessionID, plan)
    void runPlan(plan, input)
    return true
}

async function runPlan(
    plan: BackgroundCompressionPlan,
    input: StartBackgroundCompressionInput,
): Promise<void> {
    const { ctx, sessionID, searchContext } = input
    try {
        const entries =
            plan.mode === "range"
                ? await planAutoRangeCompression(
                      ctx,
                      sessionID,
                      plan.topic,
                      undefined,
                      searchContext,
                  )
                : await planAutoMessageCompression(
                      ctx,
                      sessionID,
                      plan.topic,
                      undefined,
                      searchContext,
                  )

        // A newer plan may have replaced this one while the planner was running.
        if (plans.get(sessionID) !== plan) {
            return
        }

        plan.status = "ready"
        plan.entries = entries
        ctx.logger.info("Background compression plan ready", {
            sessionID,
            mode: plan.mode,
            ranges: entries.length,
            currentTokens: input.currentTokens,
        })
        input.onReady?.()
    } catch (cause) {
        if (plans.get(sessionID) !== plan) {
            return
        }
        plan.status = "failed"
        plan.error = cause instanceof Error ? cause.message : String(cause)
        plan.failures += 1
        if (plan.failures >= MAX_FAILURES) {
            plan.retryAt = Date.now() + FAILURE_COOLDOWN_MS
        }
        ctx.logger.warn("Background compression planning failed", {
            sessionID,
            error: plan.error,
            failures: plan.failures,
        })
    }
}

export function takeBackgroundCompressionPlan(
    sessionID: string,
): BackgroundCompressionPlan | undefined {
    const plan = plans.get(sessionID)
    if (!plan || plan.status !== "ready" || !plan.entries) {
        return undefined
    }
    plans.delete(sessionID)
    return plan
}

export function discardBackgroundCompressionPlan(sessionID: string): void {
    plans.delete(sessionID)
}

export function isBackgroundCompressionPlanCurrent(
    plan: BackgroundCompressionPlan,
    messages: WithParts[],
    modelKey: string | undefined,
): boolean {
    if (plan.modelKey !== modelKey) {
        return false
    }
    if (firstMessageId(messages) !== plan.firstMessageId) {
        return false
    }
    if (plan.lastMessageId && !messages.some((message) => message.info.id === plan.lastMessageId)) {
        return false
    }
    return true
}

function firstMessageId(messages: WithParts[]): string | undefined {
    return messages.find((message) => !isIgnoredUserMessage(message))?.info.id
}
