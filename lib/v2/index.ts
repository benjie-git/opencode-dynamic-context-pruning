import type { Plugin } from "@opencode/plugin"
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { getConfig } from "../config"
import { Logger } from "../logger"
import { PromptStore } from "../prompts/store"
import { createCompressMessageTool, createCompressRangeTool } from "../compress"
import { compactionInfo, dropUnavailableVariant, resolvePlannerModel } from "../compress/planner"
import {
    backgroundCompressionEnabled,
    backgroundCompressionStatus,
    isBackgroundCompressionPlanCurrent,
    startBackgroundCompression,
    takeBackgroundCompressionPlan,
    takeDueBackgroundCompression,
} from "../compress/precompute"
import { applyResolvedMessageCompression, applyResolvedRangeCompression } from "../compress/apply"
import { activeCompressionSavings, effectiveContextTokens } from "../compress/estimate"
import { buildSearchContext } from "../compress/search"
import { resolveRanges, validateNonOverlapping } from "../compress/range-utils"
import { resolveMessages } from "../compress/message-utils"
import { finalizeSession } from "../compress/pipeline"
import type {
    CompressMessageEntry,
    CompressRangeEntry,
    PlannerRuntime,
    ToolContext,
} from "../compress/types"
import { attachCompressionDuration } from "../compress/state"
import { createCommandExecuteHandler, createSystemPromptHandler } from "../hooks"
import {
    createSessionState,
    ensureSessionInitialized,
    checkSession,
    saveSessionState,
    syncToolCache,
    type SessionState,
    type WithParts,
} from "../state"
import { assignMessageRefs } from "../message-ids"
import { applyPendingManualTrigger } from "../commands/manual"
import {
    buildPriorityMap,
    buildToolIdList,
    injectCompressNudges,
    injectMessageIds,
    injectExtendedSubAgentResults,
    prune,
    stripHallucinations,
    syncCompressionBlocks,
} from "../messages"
import { isContextOverLimits, resolveBackgroundLeadTokens } from "../messages/inject/utils"
import { countTokens } from "../token-utils"
import { matchesGlob } from "../protected-patterns"
import { history, project } from "./messages"
import { analyzeContextTokens } from "../commands/context"
import { buildStatsReport } from "../commands/stats"
import { rpc } from "./rpc"

// Extension point for future model-invisible V2 reports. Never use synthetic()
// here: its text would enter the model's context, unlike V1 ignored messages.
export async function report(logger: Logger, text: string, sessionID?: string) {
    logger.debug("V2 report (display pending)", { sessionID, text })
}

export async function setup(ctx: Plugin.Context) {
    const warnings = {
        tui: {
            showToast: async (input: { body: { message: string } }) => {
                console.warn(`DCP: ${input.body.message}`)
            },
        },
    }
    const config = getConfig({ directory: ctx.location.directory, client: warnings })
    if (!config.enabled) {
        await ctx.rpc.register(
            { ...rpc, methods: { status: rpc.methods.status } },
            { status: async () => ({ enabled: false }) },
        )
        return
    }
    const logger = new Logger(config.debug)
    const prompts = new PromptStore(
        logger,
        ctx.location.directory,
        config.experimental.customPrompts,
        "compact",
    )
    const sessions = new Map<string, SessionState>()
    const queues = new Map<string, Promise<unknown>>()
    const limits = new Map<string, number>()
    const modelVariants = new Map<string, Set<string>>()
    const aliases: Record<string, string> = {
        task: "subagent",
        bash: "shell",
        apply_patch: "patch",
    }
    for (const list of [
        config.compress.protectedTools,
        config.commands.protectedTools,
        config.strategies.deduplication.protectedTools,
        config.strategies.purgeErrors.protectedTools,
    ]) {
        for (const name of [...list])
            if (aliases[name] && !list.includes(aliases[name]!)) list.push(aliases[name]!)
    }

    function serial<T>(sessionID: string, operation: () => Promise<T>): Promise<T> {
        const pending = (queues.get(sessionID) ?? Promise.resolve()).catch(() => {}).then(operation)
        queues.set(sessionID, pending)
        void pending
            .finally(() => {
                if (queues.get(sessionID) === pending) queues.delete(sessionID)
            })
            .catch(() => {})
        return pending
    }

    const client = {
        session: {
            get: async ({ path }: { path: { id: string } }) => ({
                data: await ctx.session.get({ sessionID: path.id }),
            }),
            messages: async ({ path }: { path: { id: string } }) => {
                const [entries, session] = await Promise.all([
                    ctx.session.context({ sessionID: path.id }),
                    ctx.session.get({ sessionID: path.id }),
                ])
                return { data: history(entries, session) }
            },
            prompt: async (input: {
                path: { id: string }
                body: { parts: Array<{ text: string }> }
            }) =>
                report(logger, input.body.parts.map((part) => part.text).join("\n"), input.path.id),
        },
        tui: {
            showToast: async (input: { body: { message: string } }) =>
                report(logger, input.body.message),
        },
    }

    async function load(sessionID: string, agentID?: string) {
        const [session, entries] = await Promise.all([
            ctx.session.get({ sessionID }),
            ctx.session.context({ sessionID }),
        ])
        const selected =
            agentID ??
            session.agent ??
            entries.findLast((entry) => entry.type === "assistant")?.agent
        if (!selected) throw new Error("DCP commands require a session with a selected agent")
        const { data: agent } = await ctx.agent.get({ agentID: selected })
        let state = sessions.get(sessionID)
        if (!state) {
            state = createSessionState("compact")
            sessions.set(sessionID, state)
        }
        const messages = history(entries, session)
        await ensureSessionInitialized(
            client,
            state,
            sessionID,
            logger,
            messages,
            config.manualMode.enabled,
        )
        await checkSession(client, state, logger, messages, config.manualMode.enabled)
        const rule = [...agent.permissions, ...(session.permissions ?? [])].findLast(
            (rule) => matchesGlob("compress", rule.action) && matchesGlob("*", rule.resource),
        )
        state.compressPermission =
            config.compress.permission === "deny"
                ? "deny"
                : rule?.effect === "deny"
                  ? "deny"
                  : config.compress.permission === "ask" || rule?.effect === "ask"
                    ? "ask"
                    : "allow"
        return { state, entries, session, messages }
    }

    function allowed(state: SessionState) {
        if (state.isSubAgent && !config.experimental.allowSubAgents)
            throw new Error("DCP compression is disabled in subagents")
        if (state.compressPermission === "deny") throw new Error("DCP compression is denied")
    }

    // permission.assert exists from OpenCode 2.0.29; the plugin types used here predate it.
    const permission = ctx.permission as typeof ctx.permission & {
        assert?: (input: {
            sessionID: string
            agent?: string
            action: string
            resources: string[]
            save?: string[]
            source?: { type: "tool"; messageID: string; id: string }
        }) => Promise<void>
    }

    await ctx.model.transform((editor) => {
        limits.clear()
        modelVariants.clear()
        for (const model of editor.list()) {
            const key = `${model.providerID}/${model.id}`
            limits.set(key, model.limit.context)
            modelVariants.set(key, new Set(model.variants.map((variant) => String(variant.id))))
        }
    })
    for (const kind of ["context", "compaction"] as const)
        await ctx.session.hook(kind, (event) =>
            serial(event.sessionID, async () => {
                const { state, entries, session, messages } = await load(
                    event.sessionID,
                    event.agent,
                )
                if (state.isSubAgent && !config.experimental.allowSubAgents) {
                    delete event.tools?.compress
                    return
                }
                if (state.compressPermission === "deny") delete event.tools?.compress
                state.modelContextLimit = limits.get(`${event.model.providerID}/${event.model.id}`)
                state.modelRef = {
                    providerID: event.model.providerID,
                    id: event.model.id,
                    variant: event.model.variant,
                }
                state.systemPromptTokens = countTokens(
                    event.system.map((part) => part.text).join("\n"),
                )
                const view = project(event.messages, entries, {
                    ...session,
                    agent: event.agent,
                    model: event.model,
                })
                stripHallucinations(view.messages, state.idFormat)
                assignMessageRefs(state, view.messages)
                // Compaction may select only a prefix; block origins can be in the retained tail.
                syncCompressionBlocks(state, logger, messages)
                syncToolCache(state, config, logger, view.messages)
                buildToolIdList(state, view.messages)

                const modelKey = `${event.model.providerID}/${event.model.id}`
                const beforePrune = isContextOverLimits(
                    config,
                    state,
                    event.model.providerID,
                    event.model.id,
                    messages,
                )
                if (
                    kind === "context" &&
                    beforePrune.overMaxLimit &&
                    state.compressPermission === "allow" &&
                    !state.manualMode
                ) {
                    await applyBackgroundPlan(event.sessionID, state, messages, modelKey)
                }

                prune(state, logger, config, view.messages, view.summaryBase)
                await injectExtendedSubAgentResults(
                    client,
                    state,
                    logger,
                    view.messages,
                    config.experimental.allowSubAgents,
                )
                const priorities = buildPriorityMap(config, state, view.messages)
                prompts.reload()
                const backgroundStatus = backgroundCompressionStatus(event.sessionID).status
                // A restarted session has no in-memory plan yet (status "idle"), so the
                // first turn after a restart would otherwise receive the over-max nudge
                // and plan in the main session. The idle hook starts a plan instead.
                const canPlanInBackground =
                    backgroundCompressionEnabled(config) &&
                    state.compressPermission === "allow" &&
                    !state.manualMode &&
                    (!state.isSubAgent || config.experimental.allowSubAgents)
                const suppressNudges =
                    kind === "context" &&
                    (backgroundStatus === "running" ||
                        backgroundStatus === "ready" ||
                        (backgroundStatus === "idle" && canPlanInBackground))
                injectCompressNudges(
                    state,
                    config,
                    logger,
                    view.messages,
                    prompts.getRuntimePrompts(),
                    priorities,
                    kind === "context",
                    suppressNudges,
                )
                injectMessageIds(state, config, view.messages, priorities)

                if (kind === "context") {
                    const usage = isContextOverLimits(
                        config,
                        state,
                        event.model.providerID,
                        event.model.id,
                        view.messages,
                    )
                    const lead = resolveBackgroundLeadTokens(
                        config.compress.background.lead,
                        usage.baseMaxContextLimit,
                    )
                    if (
                        usage.baseMaxContextLimit !== undefined &&
                        usage.currentTokens >= usage.baseMaxContextLimit - (lead ?? 0)
                    ) {
                        // Do not depend on the idle hook: it may not run for this session
                        // (or may fail to load it), which previously left the session
                        // over budget with nudges suppressed and no plan started.
                        scheduleBackgroundCompression(
                            state,
                            event.sessionID,
                            messages,
                            buildSearchContext(state, messages),
                            modelKey,
                            usage.currentTokens,
                        )
                    }
                }

                applyPendingManualTrigger(state, view.messages, logger)
                event.messages = view.restore()
                const system = { system: event.system.map((part) => part.text) }
                await createSystemPromptHandler(
                    state,
                    logger,
                    config,
                    prompts,
                )(
                    {
                        sessionID: event.sessionID,
                        model: { limit: { context: state.modelContextLimit ?? 0 } },
                    },
                    system,
                )
                event.system = system.system.map((text, index) => ({
                    ...event.system[index],
                    type: "text",
                    text,
                }))
                await logger.saveContext(event.sessionID, view.messages)
            }),
        )

    async function applyBackgroundPlan(
        sessionID: string,
        state: SessionState,
        messages: WithParts[],
        modelKey: string | undefined,
    ): Promise<boolean> {
        const plan = takeBackgroundCompressionPlan(sessionID)
        if (!plan) return false
        if (!isBackgroundCompressionPlanCurrent(plan, messages, modelKey)) {
            logger.info("Discarded stale background compression plan", { sessionID })
            return false
        }
        try {
            const compression = compressionContext(state)
            const searchContext = buildSearchContext(state, messages)
            let notifications
            if (plan.mode === "range") {
                const resolved = resolveRanges(
                    {
                        topic: plan.topic,
                        content: plan.entries as CompressRangeEntry[],
                    },
                    searchContext,
                    state,
                )
                validateNonOverlapping(resolved)
                ;({ notifications } = await applyResolvedRangeCompression(
                    compression,
                    searchContext,
                    plan.topic,
                    resolved,
                    {},
                ))
            } else {
                const resolved = resolveMessages(
                    {
                        topic: plan.topic,
                        content: plan.entries as CompressMessageEntry[],
                    },
                    searchContext,
                    state,
                    config,
                )
                if (resolved.plans.length === 0) {
                    throw new Error("Background compression plan has no resolvable messages")
                }
                ;({ notifications } = await applyResolvedMessageCompression(
                    compression,
                    searchContext,
                    plan.topic,
                    resolved.plans,
                    {},
                ))
            }
            await finalizeSession(
                compression,
                {
                    sessionID,
                    ask: async () => {},
                    metadata: () => {},
                },
                messages,
                notifications,
                plan.topic,
            )
            logger.info("Applied background compression plan", {
                sessionID,
                mode: plan.mode,
                ranges: plan.entries?.length ?? 0,
            })
            return true
        } catch (cause) {
            logger.warn("Discarded background compression plan", {
                sessionID,
                error: cause instanceof Error ? cause.message : String(cause),
            })
            return false
        }
    }

    // Starts planning just after the current context hook returns, so the request is
    // already on its way while the planner runs (providers accept concurrent requests).
    function scheduleBackgroundCompression(
        state: SessionState,
        sessionID: string,
        messages: WithParts[],
        searchContext: ReturnType<typeof buildSearchContext>,
        modelKey: string | undefined,
        currentTokens: number,
    ): void {
        setTimeout(() => {
            startBackgroundCompression({
                ctx: compressionContext(state),
                sessionID,
                messages,
                searchContext,
                modelKey,
                currentTokens,
                onReady: () => {
                    void serial(sessionID, () => applyReadyBackgroundCompression(sessionID))
                },
            })
        }, 250)
    }

    // Applies a plan that finished while the session was idle. This keeps the next
    // request from paying for compression inside its context hook.
    async function applyReadyBackgroundCompression(sessionID: string): Promise<void> {
        if (backgroundCompressionStatus(sessionID).status !== "ready") return
        let loaded
        try {
            loaded = await load(sessionID)
        } catch {
            return
        }
        const { state, messages } = loaded
        if (state.compressPermission !== "allow" || state.manualMode) return
        if (state.isSubAgent && !config.experimental.allowSubAgents) return
        const providerID = state.modelRef?.providerID
        const modelID = state.modelRef?.id
        await applyBackgroundPlan(
            sessionID,
            state,
            messages,
            providerID && modelID ? `${providerID}/${modelID}` : undefined,
        )
    }

    // Runs while the session is idle, so a ready plan is applied before the next request
    // instead of synchronously inside its context hook.
    async function runIdleBackgroundCompression(sessionID: string): Promise<void> {
        const due = takeDueBackgroundCompression(sessionID)
        // A restarted session can already be over the limit without ever having marked a
        // plan due, so inspect over-limit sessions instead of bailing out here.
        if (
            !due &&
            backgroundCompressionStatus(sessionID).status === "idle" &&
            !backgroundCompressionEnabled(config)
        ) {
            return
        }

        let loaded
        try {
            loaded = await load(sessionID)
        } catch {
            return
        }
        const { state, messages } = loaded
        if (state.compressPermission !== "allow" || state.manualMode) return
        if (state.isSubAgent && !config.experimental.allowSubAgents) return

        const providerID = state.modelRef?.providerID
        const modelID = state.modelRef?.id
        const modelKey = providerID && modelID ? `${providerID}/${modelID}` : undefined
        const usage = isContextOverLimits(config, state, providerID, modelID, messages)

        const overBaseMax =
            usage.baseMaxContextLimit !== undefined &&
            usage.currentTokens > usage.baseMaxContextLimit
        if (usage.overMaxLimit || overBaseMax) {
            if (await applyBackgroundPlan(sessionID, state, messages, modelKey)) return
            // Over-limit sessions are past the lead window by definition. Start planning
            // anyway so a session that was already over the limit (for example after a
            // restart, when in-memory plans are gone) can still compress in the background.
            startBackgroundCompression({
                ctx: compressionContext(state),
                sessionID,
                messages,
                searchContext: buildSearchContext(state, messages),
                modelKey,
                currentTokens: usage.currentTokens,
                onReady: () => {
                    void serial(sessionID, () => applyReadyBackgroundCompression(sessionID))
                },
            })
            return
        }
        if (!due || usage.baseMaxContextLimit === undefined) return

        const lead = resolveBackgroundLeadTokens(
            config.compress.background.lead,
            usage.baseMaxContextLimit,
        )
        if (lead === undefined) return
        if (usage.currentTokens < usage.baseMaxContextLimit - lead) return
        startBackgroundCompression(due)
    }

    // OpenCode runs model requests from the context hook. Starting the planner there made
    // it compete with (and on single-slot providers delay) the step's own request, so the
    // planner starts only once the turn's model work has finished.
    const idleSession = ctx.session as typeof ctx.session & {
        hook(
            name: "experimental.idle",
            callback: (event: { sessionID: string }) => void,
        ): Promise<unknown>
    }
    await idleSession.hook("experimental.idle", (event) => {
        // Serialize with context hooks so state cannot change under a request.
        void serial(event.sessionID, () => runIdleBackgroundCompression(event.sessionID))
    })

    const planner: PlannerRuntime = async ({ prompt, state: plannerState }) => {
        const resolved = resolvePlannerModel(config, plannerState)
        if (!resolved) {
            throw new Error(
                "DCP compression planner could not resolve a model. Configure compress.planner.model or re-run compression from a model request.",
            )
        }
        const key = `${resolved.providerID}/${resolved.id}`
        const model = dropUnavailableVariant(resolved, modelVariants.get(key))
        if (resolved.variant && !model.variant) {
            logger.warn("Planner model variant is unavailable; using the default", {
                providerID: resolved.providerID,
                modelID: resolved.id,
                variant: resolved.variant,
            })
        }
        const { text } = await ctx.generate.text({ prompt, model })
        return text
    }

    const compressionContext = (state: SessionState): ToolContext => ({
        client,
        state,
        logger,
        config,
        prompts,
        planner,
    })

    if (config.compress.permission !== "deny") {
        const define = (state: SessionState): ToolDefinition =>
            (config.compress.mode === "message"
                ? createCompressMessageTool
                : createCompressRangeTool)(compressionContext(state))
        const definition = define(createSessionState("compact"))
        await ctx.tool.transform((editor) =>
            editor.add({
                name: "compress",
                description: definition.description,
                input: tool.schema.object(definition.args),
                options: { codemode: false, permission: "compress" },
                execute: (input, context) =>
                    serial(context.sessionID, async () => {
                        const { state } = await load(context.sessionID, context.agent)
                        allowed(state)
                        const started = Date.now()
                        const legacy = define(state)
                        const content = await legacy.execute(input, {
                            sessionID: context.sessionID,
                            messageID: context.messageID,
                            callID: context.id,
                            agent: context.agent,
                            directory: ctx.location.directory,
                            worktree: ctx.location.directory,
                            abort: new AbortController().signal,
                            ask: async () => {
                                allowed(state)
                                if (state.compressPermission !== "ask") return
                                if (!permission.assert)
                                    throw new Error(
                                        "DCP: compress permission 'ask' requires OpenCode 2.0.29 or newer. Compression was not performed.",
                                    )
                                await permission.assert({
                                    sessionID: context.sessionID,
                                    agent: context.agent,
                                    action: "compress",
                                    resources: ["*"],
                                    save: ["*"],
                                    source: {
                                        type: "tool",
                                        messageID: context.messageID,
                                        id: context.id,
                                    },
                                })
                            },
                            metadata: ({ title }: { title?: string }) => {
                                void context.progress({ title })
                            },
                        } as Parameters<typeof legacy.execute>[1])
                        attachCompressionDuration(
                            state.prune.messages,
                            context.messageID,
                            context.id,
                            Date.now() - started,
                        )
                        await saveSessionState(state, logger)
                        // Both shared compression executors return text; the V1 helper's
                        // public return type also permits unrelated attachment results.
                        return { content: content as string }
                    }),
            }),
        )
    }
    if (config.commands.enabled)
        await ctx.command.transform((editor) => {
            for (const name of ["dcp", "dcp-compress"])
                editor.add({
                    name,
                    description: name === "dcp" ? "DCP commands" : "Trigger DCP manual compression",
                    execute: async (invocation) => {
                        const prompt = await serial(invocation.sessionID, async () => {
                            const { state } = await load(invocation.sessionID)
                            const permission =
                                state.compressPermission ?? config.compress.permission
                            if (
                                name === "dcp-compress" ||
                                invocation.prompt.text.trim().split(/\s+/)[0] === "compress"
                            )
                                allowed(state)
                            const output = { parts: [] }
                            await createCommandExecuteHandler(
                                client,
                                state,
                                logger,
                                config,
                                ctx.location.directory,
                                { global: { compress: permission }, agents: {} },
                            )(
                                {
                                    command: name,
                                    sessionID: invocation.sessionID,
                                    arguments: invocation.prompt.text,
                                },
                                output,
                            )
                            state.compressPermission = permission
                            const pending = state.pendingManualTrigger
                            if (!pending) return
                            allowed(state)
                            state.pendingManualTrigger = null
                            return pending.prompt
                        })
                        if (prompt)
                            await ctx.session.prompt({
                                sessionID: invocation.sessionID,
                                text: prompt,
                                delivery: invocation.delivery,
                            })
                    },
                })
        })
    await ctx.rpc.register(rpc, {
        status: async () => ({ enabled: config.commands.enabled }),
        snapshot: ({ sessionID }) =>
            serial(sessionID, async () => {
                const { state, messages } = await load(sessionID)
                syncCompressionBlocks(state, logger, messages)
                const context = analyzeContextTokens(state, messages)
                const effectiveTokens = effectiveContextTokens(context.total, state, messages)
                const savedTokens = activeCompressionSavings(state)
                const usage = isContextOverLimits(
                    config,
                    state,
                    state.modelRef?.providerID,
                    state.modelRef?.id,
                    messages,
                )
                const backgroundLead = resolveBackgroundLeadTokens(
                    config.compress.background.lead,
                    usage.baseMaxContextLimit,
                )
                const startsAt =
                    usage.baseMaxContextLimit !== undefined && backgroundLead !== undefined
                        ? usage.baseMaxContextLimit - backgroundLead
                        : undefined
                return {
                    manualMode: !!state.manualMode,
                    canCompress:
                        state.compressPermission !== "deny" &&
                        (!state.isSubAgent || config.experimental.allowSubAgents),
                    compaction: compactionInfo(config),
                    background: {
                        ...backgroundCompressionStatus(sessionID),
                        currentTokens: usage.currentTokens,
                        ...(startsAt !== undefined ? { startsAt } : {}),
                    },
                    effectiveTokens,
                    savedTokens,
                    context,
                    stats: await buildStatsReport(state, logger),
                }
            }),
        manual: ({ sessionID, enabled }) =>
            serial(sessionID, async () => {
                const { state } = await load(sessionID)
                state.manualMode = enabled ? "active" : false
                await saveSessionState(state, logger)
                return {}
            }),
    })
    logger.info("DCP V2 initialized")
    return () => {
        sessions.clear()
        limits.clear()
    }
}
