import type { PlannerConfig, PluginConfig } from "../config"
import { formatBlockRef, formatMessageRef, parseBoundaryId, type IdFormat } from "../message-ids"
import { isIgnoredUserMessage, isProtectedUserMessage } from "../messages/query"
import type { CompressionBlock, SessionState, WithParts } from "../state"
import { extractToolContent } from "../token-utils"
import type {
    CompressMessageEntry,
    CompressRangeEntry,
    ResolvedMessageCompression,
    ResolvedRangeCompression,
    SearchContext,
    ToolContext,
} from "./types"

const TOOL_OUTPUT_LIMIT = 4000

export interface ModelRef {
    providerID: string
    id: string
    variant?: string
}

export interface PlannerRangeSelection {
    startId: string
    endId: string
    topic?: string
    summary: string
}

export interface PlannerMessageSelection {
    messageId: string
    topic?: string
    summary: string
}

function cleanVariant(variant: string | undefined): string | undefined {
    const trimmed = variant?.trim()
    return trimmed ? trimmed : undefined
}

/**
 * Thinking level given as `model: { variant }`, without a provider/model reference.
 * That form means "use the session's current model at this level".
 */
function modelVariant(model: PlannerConfig["model"] | undefined): string | undefined {
    if (typeof model !== "object" || model === null) {
        return undefined
    }
    return cleanVariant(model.variant)
}

export function parsePlannerModel(value: PlannerConfig["model"] | undefined): ModelRef | null {
    if (!value) {
        return null
    }

    if (typeof value === "string") {
        const trimmed = value.trim()
        const separator = trimmed.indexOf("/")
        if (separator <= 0 || separator === trimmed.length - 1) {
            return null
        }

        const providerID = trimmed.slice(0, separator)
        const rest = trimmed.slice(separator + 1)
        const variantSeparator = rest.lastIndexOf("#")
        const id = variantSeparator === -1 ? rest : rest.slice(0, variantSeparator)
        const variant = variantSeparator === -1 ? undefined : rest.slice(variantSeparator + 1)
        if (!id) {
            return null
        }

        return {
            providerID,
            id,
            variant: cleanVariant(variant),
        }
    }

    if (
        typeof value !== "object" ||
        value === null ||
        typeof value.providerID !== "string" ||
        typeof value.model !== "string"
    ) {
        return null
    }

    return {
        providerID: value.providerID,
        id: value.model,
        variant: cleanVariant(value.variant),
    }
}

export function resolvePlannerModel(
    config: PluginConfig,
    state: SessionState,
    messages: WithParts[] = [],
): ModelRef | null {
    const planner = config.compress.planner
    if (!planner?.enabled) {
        return null
    }

    const shorthandVariant = modelVariant(planner.model)
    const variant = shorthandVariant ?? cleanVariant(planner.variant) ?? "low"
    const configured = parsePlannerModel(planner.model)
    if (configured) {
        return {
            ...configured,
            variant: configured.variant ?? variant,
        }
    }
    const fallback = findCurrentModel(state, messages)
    if (!fallback) {
        return null
    }

    return {
        ...fallback,
        variant,
    }
}

export interface CompactionInfo {
    enabled: boolean
    /** Explicitly configured model, formatted as `providerID/modelID`. */
    model?: string
    /** Thinking level (model variant) used for compression. */
    variant?: string
}

// Display-only view of the compaction model for the TUI panel. When no model is
// configured the current session model is used, so only the level is meaningful.
export function compactionInfo(config: PluginConfig): CompactionInfo {
    const planner = config.compress.planner
    if (!planner?.enabled) {
        return { enabled: false }
    }

    const configured = parsePlannerModel(planner.model)
    const variant =
        configured?.variant ?? modelVariant(planner.model) ?? cleanVariant(planner.variant) ?? "low"
    return {
        enabled: true,
        ...(configured ? { model: `${configured.providerID}/${configured.id}` } : {}),
        variant,
    }
}

export function dropUnavailableVariant(
    model: ModelRef,
    availableVariants: ReadonlySet<string> | undefined,
): ModelRef {
    if (!model.variant || !availableVariants || availableVariants.has(model.variant)) {
        return model
    }
    const { variant: _unavailable, ...rest } = model
    return rest
}

function findCurrentModel(state: SessionState, messages: WithParts[]): ModelRef | null {
    if (state.modelRef) {
        return { ...state.modelRef }
    }

    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index]
        if (!message || isIgnoredUserMessage(message) || message.info.role !== "user") {
            continue
        }

        const model = (message.info as any).model
        const providerID = model?.providerID
        const id = model?.modelID ?? model?.id
        if (typeof providerID === "string" && typeof id === "string") {
            return {
                providerID,
                id,
                variant: cleanVariant(model?.variant),
            }
        }
    }

    return null
}

export function isPlannerEnabled(ctx: ToolContext): boolean {
    return !!ctx.planner && !!ctx.config.compress.planner?.enabled
}

function truncate(text: string, limit = TOOL_OUTPUT_LIMIT): string {
    if (text.length <= limit) {
        return text
    }
    return `${text.slice(0, limit)}\n[... truncated ${text.length - limit} characters]`
}

function stringify(value: unknown): string {
    if (typeof value === "string") {
        return value
    }
    try {
        return JSON.stringify(value)
    } catch {
        return String(value)
    }
}

export function renderMessage(
    message: WithParts,
    state: SessionState,
    options: { config?: PluginConfig } = {},
): string | null {
    const ref = state.messageIds.byRawId.get(message.info.id)
    if (!ref) {
        return null
    }

    const markers: string[] = []
    if (options.config && isProtectedUserMessage(options.config, message)) {
        markers.push("PROTECTED - DO NOT SELECT")
    }
    const alreadyCompressed =
        (state.prune.messages.byMessageId.get(message.info.id)?.activeBlockIds.length ?? 0) > 0
    if (alreadyCompressed) {
        markers.push("ALREADY COMPRESSED - DO NOT SELECT")
    }

    const header = `### ${ref} | ${message.info.role}${markers.length > 0 ? ` | ${markers.join(" | ")}` : ""}`
    const lines: string[] = [header]
    const parts = Array.isArray(message.parts) ? message.parts : []

    for (const part of parts) {
        if (part.type === "text") {
            if (part.text?.trim()) {
                lines.push(part.text.trim())
            }
            continue
        }

        if (part.type === "reasoning" || part.type === "step-start") {
            continue
        }

        if (part.type === "tool") {
            const toolPart = part as any
            lines.push(`[tool: ${toolPart.tool ?? "unknown"}]`)
            const contents = extractToolContent(toolPart)
            if (contents.length > 0) {
                lines.push(truncate(contents.join("\n")))
            } else if (
                toolPart.state?.status === "running" ||
                toolPart.state?.status === "pending"
            ) {
                lines.push("[tool still running]")
            }
            continue
        }

        if (part.type === "file") {
            const filePart = part as any
            lines.push(`[file: ${filePart.filename ?? filePart.url ?? "attachment"}]`)
        }
    }

    if (lines.length === 1) {
        lines.push("[no textual content]")
    }

    return lines.join("\n")
}

export function renderTranscript(
    messages: WithParts[],
    state: SessionState,
    options: { config?: PluginConfig; includeCompressedBlocks?: boolean } = {},
): string {
    const blocksByAnchor = options.includeCompressedBlocks ? activeBlocksByAnchor(state) : undefined
    const rendered: string[] = []
    for (const message of messages) {
        const text = renderMessage(message, state, options)
        if (text) {
            rendered.push(text)
        }
        for (const block of blocksByAnchor?.get(message.info.id) ?? []) {
            rendered.push(renderCompressedBlock(block, state))
        }
    }
    return rendered.join("\n\n")
}

function activeBlocksByAnchor(state: SessionState): Map<string, CompressionBlock[]> {
    const blocksByAnchor = new Map<string, CompressionBlock[]>()
    for (const block of state.prune.messages.blocksById.values()) {
        if (!block.active) {
            continue
        }
        const blocks = blocksByAnchor.get(block.anchorMessageId)
        if (blocks) {
            blocks.push(block)
        } else {
            blocksByAnchor.set(block.anchorMessageId, [block])
        }
    }
    for (const blocks of blocksByAnchor.values()) {
        blocks.sort((left, right) => left.blockId - right.blockId)
    }
    return blocksByAnchor
}

function renderCompressedBlock(block: CompressionBlock, state: SessionState): string {
    const header = `### ${formatBlockRef(block.blockId, state.idFormat)} | compressed block`
    return `${header}\n${block.summary}`
}

function blockPlaceholder(blockId: number, format: IdFormat): string {
    const ref = formatBlockRef(blockId, format)
    return format === "compact" ? ref : `(${ref})`
}

function plannerOutputFormat(format: IdFormat): string {
    return `${formatMessageRef(1, format)}, ${formatMessageRef(2, format)}`
}

function rangeSelectionPrompt(
    state: SessionState,
    transcript: string,
    topic: string,
    focus?: string,
): string {
    const example = plannerOutputFormat(state.idFormat)
    const blockExample = formatBlockRef(1, state.idFormat)
    const blockPlaceholderExample = blockPlaceholder(1, state.idFormat)
    return `You are the compression planner for DCP (Dynamic Context Pruning). Decide which parts of the conversation below should be replaced by summaries, and write those summaries yourself. This planning runs on a fast, low-thinking model; do the work carefully but concisely.

${topic ? `The main agent requested this compression with the topic: "${topic}".` : ""}
${focus?.trim() ? `Additional focus from the main agent: "${focus.trim()}"` : ""}

Your job:
1. Choose one or more NON-OVERLAPPING contiguous ranges of older conversation messages that are safe to compress.
2. Do NOT select the most recent user request or anything that is still needed verbatim for the active task.
3. Prefer compressing closed exploration, verbose tool output, and completed work. Keep unresolved constraints, active instructions, and recent context.
4. Write an exhaustive but lean summary for each range. Preserve file paths, signatures, decisions, constraints, user intent, and key findings. Strip noise and failed dead ends.
5. Each range must start and end on a message or compressed-block ID shown below, and ranges must not overlap.
6. Do not select a message marked PROTECTED. Messages marked ALREADY COMPRESSED may only be included as part of a broader range.
7. Compressed block sections are shown as \`### ${blockExample} | compressed block\`. If a selected range includes one, include that block's placeholder exactly once in the summary, for example \`${blockPlaceholderExample}\`. Do not invent block placeholders.

Return ONLY a JSON object with this shape (no prose, no markdown fences):
{
  "ranges": [
    {
      "startId": "${example.split(",")[0].trim()}",
      "endId": "${example.split(",")[1]?.trim() ?? example.split(",")[0].trim()}",
      "topic": "Short 3-5 word label",
      "summary": "Complete technical summary of the range"
    }
  ]
}

If nothing is safe to compress, return {"ranges": []}.

CONVERSATION TO ANALYZE:
${transcript}
`
}

function messageSelectionPrompt(
    state: SessionState,
    transcript: string,
    topic: string,
    focus?: string,
): string {
    const example = plannerOutputFormat(state.idFormat)
    return `You are the compression planner for DCP (Dynamic Context Pruning). Decide which individual messages below should be replaced by summaries, and write those summaries yourself. This planning runs on a fast, low-thinking model; do the work carefully but concisely.

${topic ? `The main agent requested this compression with the topic: "${topic}".` : ""}
${focus?.trim() ? `Additional focus from the main agent: "${focus.trim()}"` : ""}

Your job:
1. Choose individual older messages that are safe to compress independently.
2. Do NOT select the most recent user request or anything still needed verbatim for the active task.
3. Prefer compressing closed exploration, verbose tool output, and completed work. Keep unresolved constraints, active instructions, and recent context.
4. Write an exhaustive but lean summary for each selected message. Preserve file paths, signatures, decisions, constraints, user intent, and key findings. Strip noise and failed dead ends.
5. Do not select a message marked PROTECTED or ALREADY COMPRESSED.

Return ONLY a JSON object with this shape (no prose, no markdown fences):
{
  "messages": [
    {
      "messageId": "${example.split(",")[0].trim()}",
      "topic": "Short 3-5 word label",
      "summary": "Complete technical summary of this one message"
    }
  ]
}

If nothing is safe to compress, return {"messages": []}.

CONVERSATION TO ANALYZE:
${transcript}
`
}

function summaryPrompt(
    state: SessionState,
    mode: "range" | "message",
    transcript: string,
    topic: string,
    focus?: string,
): string {
    const example = plannerOutputFormat(state.idFormat)
    const blockPlaceholderExample = blockPlaceholder(1, state.idFormat)
    const shape =
        mode === "range"
            ? `{
  "summaries": [
    {
      "startId": "${example.split(",")[0].trim()}",
      "endId": "${example.split(",")[1]?.trim() ?? example.split(",")[0].trim()}",
      "summary": "Complete technical summary of the range"
    }
  ]
}`
            : `{
  "summaries": [
    {
      "messageId": "${example.split(",")[0].trim()}",
      "summary": "Complete technical summary of this one message"
    }
  ]
}`

    return `You are the compression planner for DCP (Dynamic Context Pruning). The main agent has already selected the content to compress; your job is to write the summaries. This planning runs on a fast, low-thinking model.

${topic ? `Overall compression topic: "${topic}".` : ""}
${focus?.trim() ? `Additional focus from the main agent: "${focus.trim()}"` : ""}

Rules:
- Write an exhaustive but lean summary for every selection shown below.
- Preserve file paths, function signatures, decisions, constraints, user intent, key findings, and tool outcomes.
- Strip noise, failed attempts that led nowhere, verbose output, and repetition.
- When a selection contains user intent, preserve scope, constraints, priorities, acceptance criteria, and requested outcomes with extra care.
- Use the exact IDs shown in the selection headers.
${mode === "range" ? `- If a selection includes a compressed block section, include that block's placeholder exactly once in the summary, for example \`${blockPlaceholderExample}\`. Do not invent block placeholders.` : ""}

Return ONLY a JSON object with this shape (no prose, no markdown fences):
${shape}

SELECTIONS TO SUMMARIZE:
${transcript}
`
}

function extractJson(text: string): unknown {
    const candidates: string[] = []
    const trimmed = text.trim()
    if (trimmed) {
        candidates.push(trimmed)
    }

    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
    if (fence?.[1]) {
        candidates.push(fence[1].trim())
    }

    const firstBrace = trimmed.indexOf("{")
    const lastBrace = trimmed.lastIndexOf("}")
    if (firstBrace !== -1 && lastBrace > firstBrace) {
        candidates.push(trimmed.slice(firstBrace, lastBrace + 1))
    }

    const firstBracket = trimmed.indexOf("[")
    const lastBracket = trimmed.lastIndexOf("]")
    if (firstBracket !== -1 && lastBracket > firstBracket) {
        candidates.push(trimmed.slice(firstBracket, lastBracket + 1))
    }

    for (const candidate of candidates) {
        const withoutTrailingCommas = candidate.replace(/,\s*([}\]])/g, "$1")
        try {
            return JSON.parse(withoutTrailingCommas)
        } catch {
            // Try the next candidate.
        }
    }

    throw new Error("Compression planner returned invalid JSON")
}

function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : []
}

export function parsePlannerRanges(text: string): PlannerRangeSelection[] {
    const parsed = extractJson(text) as any
    const source = Array.isArray(parsed)
        ? parsed
        : (parsed?.ranges ?? parsed?.summaries ?? parsed?.content ?? [])

    const selections: PlannerRangeSelection[] = []
    for (const value of asArray(source)) {
        if (!value || typeof value !== "object") {
            continue
        }
        const entry = value as Record<string, unknown>
        if (
            typeof entry.startId !== "string" ||
            typeof entry.endId !== "string" ||
            typeof entry.summary !== "string"
        ) {
            continue
        }

        selections.push({
            startId: entry.startId.trim(),
            endId: entry.endId.trim(),
            topic: typeof entry.topic === "string" ? entry.topic : undefined,
            summary: entry.summary,
        })
    }

    return selections
}

export function parsePlannerMessages(text: string): PlannerMessageSelection[] {
    const parsed = extractJson(text) as any
    const source = Array.isArray(parsed)
        ? parsed
        : (parsed?.messages ?? parsed?.summaries ?? parsed?.content ?? [])

    const selections: PlannerMessageSelection[] = []
    for (const value of asArray(source)) {
        if (!value || typeof value !== "object") {
            continue
        }
        const entry = value as Record<string, unknown>
        if (typeof entry.messageId !== "string" || typeof entry.summary !== "string") {
            continue
        }

        selections.push({
            messageId: entry.messageId.trim(),
            topic: typeof entry.topic === "string" ? entry.topic : undefined,
            summary: entry.summary,
        })
    }

    return selections
}

async function runPlanner(ctx: ToolContext, sessionID: string, prompt: string): Promise<string> {
    if (!ctx.planner) {
        throw new Error("Compression planner is not available in this plugin runtime")
    }
    return ctx.planner({ prompt, sessionID, state: ctx.state })
}

function latestUserMessageIndex(messages: WithParts[]): number {
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index]
        if (message && !isIgnoredUserMessage(message) && message.info.role === "user") {
            return index
        }
    }
    return -1
}

export function autoCandidates(ctx: ToolContext, searchContext: SearchContext): WithParts[] {
    const lastUserIndex = latestUserMessageIndex(searchContext.rawMessages)
    const end = lastUserIndex === -1 ? searchContext.rawMessages.length - 1 : lastUserIndex - 1
    if (end < 0) {
        return []
    }

    const candidates: WithParts[] = []
    for (const message of searchContext.rawMessages.slice(0, end + 1)) {
        if (isIgnoredUserMessage(message)) {
            continue
        }
        if (!ctx.state.messageIds.byRawId.has(message.info.id)) {
            continue
        }
        if (
            ctx.config.compress.mode === "message" &&
            (ctx.state.prune.messages.byMessageId.get(message.info.id)?.activeBlockIds.length ??
                0) > 0
        ) {
            continue
        }
        candidates.push(message)
    }

    return candidates
}

function candidateBoundaries(
    ctx: ToolContext,
    candidates: WithParts[],
    searchContext: SearchContext,
): { messages: Set<string>; blocks: Set<string> } {
    const candidateMessageIds = new Set(candidates.map((message) => message.info.id))
    const messages = new Set<string>()
    for (const messageId of candidateMessageIds) {
        const ref = ctx.state.messageIds.byRawId.get(messageId)
        if (ref) {
            messages.add(ref)
        }
    }

    const blocks = new Set<string>()
    for (const block of searchContext.summaryByBlockId.values()) {
        if (candidateMessageIds.has(block.anchorMessageId)) {
            blocks.add(formatBlockRef(block.blockId, ctx.state.idFormat))
        }
    }

    return { messages, blocks }
}

function isCandidateBoundary(
    parsed: NonNullable<ReturnType<typeof parseBoundaryId>>,
    boundaries: { messages: Set<string>; blocks: Set<string> },
): boolean {
    return parsed.kind === "message"
        ? boundaries.messages.has(parsed.ref)
        : boundaries.blocks.has(parsed.ref)
}

function filterAutoRangeSelections(
    selections: PlannerRangeSelection[],
    ctx: ToolContext,
    candidates: WithParts[],
    searchContext: SearchContext,
): CompressRangeEntry[] {
    const boundaries = candidateBoundaries(ctx, candidates, searchContext)
    const filtered: CompressRangeEntry[] = []
    for (const selection of selections) {
        const start = parseBoundaryId(selection.startId, ctx.state.idFormat)
        const end = parseBoundaryId(selection.endId, ctx.state.idFormat)
        if (
            !start ||
            !end ||
            !isCandidateBoundary(start, boundaries) ||
            !isCandidateBoundary(end, boundaries)
        ) {
            continue
        }
        filtered.push({
            startId: start.ref,
            endId: end.ref,
            summary: selection.summary,
        })
    }
    return filtered
}

function filterAutoMessageSelections(
    selections: PlannerMessageSelection[],
    ctx: ToolContext,
    topic: string,
    candidates: WithParts[],
    searchContext: SearchContext,
): CompressMessageEntry[] {
    const boundaries = candidateBoundaries(ctx, candidates, searchContext)
    const filtered: CompressMessageEntry[] = []
    for (const selection of selections) {
        const parsed = parseBoundaryId(selection.messageId, ctx.state.idFormat)
        if (!parsed || parsed.kind !== "message" || !boundaries.messages.has(parsed.ref)) {
            continue
        }
        filtered.push({
            messageId: parsed.ref,
            topic: selection.topic ?? topic,
            summary: selection.summary,
        })
    }
    return filtered
}

export async function planAutoRangeCompression(
    ctx: ToolContext,
    sessionID: string,
    topic: string,
    focus: string | undefined,
    searchContext: SearchContext,
): Promise<CompressRangeEntry[]> {
    const candidates = autoCandidates(ctx, searchContext)
    if (candidates.length === 0) {
        throw new Error("No eligible older messages were found to compress")
    }

    const transcript = renderTranscript(candidates, ctx.state, {
        config: ctx.config,
        includeCompressedBlocks: true,
    })
    const prompt = rangeSelectionPrompt(ctx.state, transcript, topic, focus)
    const response = await runPlanner(ctx, sessionID, prompt)
    const selections = filterAutoRangeSelections(
        parsePlannerRanges(response),
        ctx,
        candidates,
        searchContext,
    )
    if (selections.length === 0) {
        throw new Error("Compression planner selected no ranges to compress")
    }

    return selections
}

export async function planAutoMessageCompression(
    ctx: ToolContext,
    sessionID: string,
    topic: string,
    focus: string | undefined,
    searchContext: SearchContext,
): Promise<CompressMessageEntry[]> {
    const candidates = autoCandidates(ctx, searchContext)
    if (candidates.length === 0) {
        throw new Error("No eligible older messages were found to compress")
    }

    const transcript = renderTranscript(candidates, ctx.state, { config: ctx.config })
    const prompt = messageSelectionPrompt(ctx.state, transcript, topic, focus)
    const response = await runPlanner(ctx, sessionID, prompt)
    const selections = filterAutoMessageSelections(
        parsePlannerMessages(response),
        ctx,
        topic,
        candidates,
        searchContext,
    )
    if (selections.length === 0) {
        throw new Error("Compression planner selected no messages to compress")
    }

    return selections
}

function normalizeBoundaryId(id: string, state: SessionState): string {
    return parseBoundaryId(id, state.idFormat)?.ref ?? id.trim()
}

export async function fillRangeSummaries(
    ctx: ToolContext,
    sessionID: string,
    topic: string,
    focus: string | undefined,
    plans: ResolvedRangeCompression[],
    searchContext: SearchContext,
): Promise<CompressRangeEntry[]> {
    const missing = plans.filter((plan) => !plan.entry.summary?.trim())
    if (missing.length === 0) {
        return plans.map((plan) => plan.entry)
    }

    const selections: string[] = []
    for (const plan of missing) {
        const start = searchContext.rawMessages[plan.selection.startReference.rawIndex]
        const end = searchContext.rawMessages[plan.selection.endReference.rawIndex]
        const rendered: string[] = [`### RANGE ${plan.entry.startId} .. ${plan.entry.endId}`]
        if (start && end) {
            const from = Math.min(
                plan.selection.startReference.rawIndex,
                plan.selection.endReference.rawIndex,
            )
            const to = Math.max(
                plan.selection.startReference.rawIndex,
                plan.selection.endReference.rawIndex,
            )
            const text = renderTranscript(
                searchContext.rawMessages.slice(from, to + 1),
                ctx.state,
                {
                    config: ctx.config,
                    includeCompressedBlocks: true,
                },
            )
            if (text) {
                rendered.push(text)
            }
        }
        selections.push(rendered.join("\n"))
    }

    const prompt = summaryPrompt(ctx.state, "range", selections.join("\n\n"), topic, focus)
    const response = await runPlanner(ctx, sessionID, prompt)
    const summaries = parsePlannerRanges(response)
    const summaryByKey = new Map<string, string>()
    for (const selection of summaries) {
        const start = normalizeBoundaryId(selection.startId, ctx.state)
        const end = normalizeBoundaryId(selection.endId, ctx.state)
        summaryByKey.set(`${start}..${end}`, selection.summary)
    }

    return plans.map((plan) => {
        if (plan.entry.summary?.trim()) {
            return plan.entry
        }

        const key = `${plan.entry.startId}..${plan.entry.endId}`
        const summary = summaryByKey.get(key)
        if (!summary) {
            throw new Error(
                `Compression planner did not return a summary for range ${plan.entry.startId}..${plan.entry.endId}`,
            )
        }
        return {
            ...plan.entry,
            summary,
        }
    })
}

export async function fillMessageSummaries(
    ctx: ToolContext,
    sessionID: string,
    topic: string,
    focus: string | undefined,
    plans: ResolvedMessageCompression[],
    searchContext: SearchContext,
): Promise<CompressMessageEntry[]> {
    const missing = plans.filter((plan) => !plan.entry.summary?.trim())
    if (missing.length === 0) {
        return plans.map((plan) => plan.entry)
    }

    const selections: string[] = []
    for (const plan of missing) {
        const rendered: string[] = [`### MESSAGE ${plan.entry.messageId}`]
        const text = renderTranscript(
            plan.selection.messageIds
                .map((messageId) => searchContext.rawMessagesById.get(messageId))
                .filter((message): message is WithParts => !!message),
            ctx.state,
        )
        if (text) {
            rendered.push(text)
        }
        selections.push(rendered.join("\n"))
    }

    const prompt = summaryPrompt(ctx.state, "message", selections.join("\n\n"), topic, focus)
    const response = await runPlanner(ctx, sessionID, prompt)
    const summaries = parsePlannerMessages(response)
    const summaryById = new Map<string, string>()
    for (const selection of summaries) {
        summaryById.set(normalizeBoundaryId(selection.messageId, ctx.state), selection.summary)
    }

    return plans.map((plan) => {
        if (plan.entry.summary?.trim()) {
            return plan.entry
        }

        const summary = summaryById.get(plan.entry.messageId)
        if (!summary) {
            throw new Error(
                `Compression planner did not return a summary for message ${plan.entry.messageId}`,
            )
        }
        return {
            ...plan.entry,
            summary,
        }
    })
}
