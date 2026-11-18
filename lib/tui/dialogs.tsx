/** @jsxImportSource @opentui/solid */

import type { analyzeContextTokens } from "../commands/context"
import type { CompactionInfo } from "../compress/planner"
import type { BackgroundCompressionSnapshot } from "../compress/precompute"
import { formatTokenCount } from "../ui/utils"
import { formatDuration, formatRatio } from "./format"
import { ActionRow, Card, DcpFrame, Metric, Progress, PromptRow, StatusPill } from "./ui"
import type { StatsReport, ViewApi } from "./types"

export function StatusDialog(props: {
    api: ViewApi
    title: string
    eyebrow: string
    message: string
}) {
    return (
        <DcpFrame api={props.api} title={props.title} eyebrow={props.eyebrow}>
            <box paddingTop={1} paddingBottom={1}>
                <text fg={props.api.theme.current.textMuted}>{props.message}</text>
            </box>
        </DcpFrame>
    )
}

export function ContextDialog(props: {
    api: ViewApi
    breakdown: ReturnType<typeof analyzeContextTokens>
    onBack: () => void
}) {
    const theme = props.api.theme.current
    const breakdown = props.breakdown
    const total = Math.max(0, breakdown.total)
    const activePruned = breakdown.prunedToolCount + breakdown.prunedMessageCount

    return (
        <DcpFrame api={props.api} title="Context" eyebrow="DCP" onBack={props.onBack}>
            <Card theme={theme} title="Current">
                <Metric
                    theme={theme}
                    label="Total in context"
                    value={`~${formatTokenCount(total)}`}
                    hint="tokens"
                />
                <Metric
                    theme={theme}
                    label="Tools in context"
                    value={`${breakdown.toolsInContextCount}`}
                />
                <Metric theme={theme} label="Active pruned targets" value={`${activePruned}`} />
                <Metric
                    theme={theme}
                    label="Tokens pruned"
                    value={`~${formatTokenCount(breakdown.prunedTokens)}`}
                    hint="tokens"
                />
            </Card>
            <Card theme={theme} title="Breakdown">
                <Progress
                    theme={theme}
                    label="System"
                    value={breakdown.system}
                    total={total}
                    color="primary"
                    detail={`~${formatTokenCount(breakdown.system)} tokens`}
                />
                <Progress
                    theme={theme}
                    label="User"
                    value={breakdown.user}
                    total={total}
                    color="primary"
                    detail={`~${formatTokenCount(breakdown.user)} tokens`}
                />
                <Progress
                    theme={theme}
                    label="Assistant"
                    value={breakdown.assistant}
                    total={total}
                    color="primary"
                    detail={`~${formatTokenCount(breakdown.assistant)} tokens`}
                />
                <Progress
                    theme={theme}
                    label={`Tools (${breakdown.toolsInContextCount})`}
                    value={breakdown.tools}
                    total={total}
                    color="primary"
                    detail={`~${formatTokenCount(breakdown.tools)} tokens`}
                />
            </Card>
        </DcpFrame>
    )
}

export function StatsDialog(props: { api: ViewApi; report: StatsReport; onBack: () => void }) {
    const theme = props.api.theme.current
    const ratio = formatRatio(props.report.sessionTokens, props.report.sessionSummaryTokens)
    return (
        <DcpFrame api={props.api} title="Stats" eyebrow="DCP" onBack={props.onBack}>
            <Card theme={theme} title="Session">
                <Metric
                    theme={theme}
                    label="Tokens saved"
                    value={`~${formatTokenCount(props.report.sessionTokens)}`}
                    hint="tokens"
                />
                <Metric
                    theme={theme}
                    label="Summary size"
                    value={`~${formatTokenCount(props.report.sessionSummaryTokens)}`}
                    hint="tokens"
                />
                <Metric theme={theme} label="Compression ratio" value={ratio} />
                <Metric
                    theme={theme}
                    label="Compression time"
                    value={formatDuration(props.report.sessionDurationMs)}
                />
                <Metric theme={theme} label="Tools pruned" value={`${props.report.sessionTools}`} />
                <Metric
                    theme={theme}
                    label="Messages pruned"
                    value={`${props.report.sessionMessages}`}
                />
            </Card>
            <Card theme={theme} title="All time">
                <Metric
                    theme={theme}
                    label="Tokens saved"
                    value={`~${formatTokenCount(props.report.allTime.totalTokens)}`}
                    hint="tokens"
                />
                <Metric
                    theme={theme}
                    label="Tools pruned"
                    value={`${props.report.allTime.totalTools}`}
                />
                <Metric
                    theme={theme}
                    label="Messages pruned"
                    value={`${props.report.allTime.totalMessages}`}
                />
                <Metric
                    theme={theme}
                    label="Sessions with DCP history"
                    value={`${props.report.allTime.sessionCount}`}
                />
            </Card>
        </DcpFrame>
    )
}

export function PanelDialog(props: {
    api: ViewApi
    manualMode: boolean
    canCompress: boolean
    blockedReason?: string
    compaction?: CompactionInfo
    background?: BackgroundCompressionSnapshot
    onContext: () => void
    onStats: () => void
    onManual: (enabled: boolean) => void
}) {
    const theme = props.api.theme.current
    const canCompress = props.canCompress
    return (
        <DcpFrame api={props.api} eyebrow="DCP">
            <Card theme={theme} title="Views">
                <box flexDirection="column" gap={1}>
                    <ActionRow
                        theme={theme}
                        title="Context"
                        detail="Token usage"
                        onClick={props.onContext}
                    />
                    <ActionRow
                        theme={theme}
                        title="Stats"
                        detail="Savings"
                        onClick={props.onStats}
                    />
                </box>
            </Card>
            <Card theme={theme} title="Prompt">
                {canCompress ? (
                    <PromptRow
                        theme={theme}
                        command="/dcp-compress [focus]"
                        description="Ask the model to compress"
                        accent="primary"
                    />
                ) : (
                    <text fg={theme.textMuted}>
                        {props.blockedReason ?? "Compression is denied by permissions."}
                    </text>
                )}
            </Card>
            <Card theme={theme} title="Compaction">
                <StatusPill
                    theme={theme}
                    label="Model"
                    value={compactionValue(props.compaction)}
                    accent={props.compaction?.enabled ? "accent" : "warning"}
                />
                {props.background ? (
                    <StatusPill
                        theme={theme}
                        label="Background"
                        value={backgroundValue(props.background)}
                        accent={
                            props.background.status === "failed"
                                ? "warning"
                                : props.background.status === "idle"
                                  ? "textMuted"
                                  : "success"
                        }
                    />
                ) : null}
                {props.background?.startsAt !== undefined ? (
                    <StatusPill
                        theme={theme}
                        label="Starts at"
                        value={`~${formatTokenCount(props.background.startsAt, true)} tokens`}
                        accent="textMuted"
                    />
                ) : null}
            </Card>
            <Card theme={theme} title="Session State">
                <ManualModeToggle
                    api={props.api}
                    enabled={props.manualMode}
                    onToggle={props.onManual}
                />
                <StatusPill
                    theme={theme}
                    label="Compression command"
                    value={canCompress ? "enabled" : "disabled"}
                    accent={canCompress ? "success" : "warning"}
                />
            </Card>
        </DcpFrame>
    )
}

function ManualModeToggle(props: {
    api: ViewApi
    enabled: boolean
    onToggle: (enabled: boolean) => void
}) {
    const theme = props.api.theme.current
    const enabled = props.enabled
    const track = enabled ? theme.success : theme.error
    return (
        <box flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1}>
            <box width={22}>
                <text fg={theme.primary}>
                    <b>Manual mode</b>
                </text>
            </box>
            <box
                backgroundColor={track}
                paddingLeft={1}
                paddingRight={1}
                onMouseUp={() => props.onToggle(!enabled)}
            >
                <text fg={theme.background}>{enabled ? "   ■" : "■   "}</text>
            </box>
        </box>
    )
}

function compactionValue(info: CompactionInfo | undefined): string {
    if (!info) return "unavailable"
    if (!info.enabled) return "disabled"
    const variant = info.variant ?? "low"
    return info.model ? `${info.model} · ${variant}` : `${variant} (current model)`
}

function backgroundValue(info: BackgroundCompressionSnapshot): string {
    if (info.status === "idle") return "not started"
    if (info.status === "running") return "planning"
    if (info.status === "ready") return "plan ready"
    return info.failures ? `failed (${info.failures}×)` : "failed"
}
