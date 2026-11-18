/** @jsxImportSource @opentui/solid */
import type { Plugin } from "@opencode/plugin/tui"
import { createSignal, onCleanup, Show } from "solid-js"
import { ContextDialog, PanelDialog, StatsDialog, StatusDialog } from "../tui/dialogs"
import type { ViewApi } from "../tui/types"
import { formatTokenCount } from "../ui/utils"
import { rpc } from "./rpc"
import { panelTheme } from "./theme"

export async function setup(ctx: Plugin.Context) {
    const client = ctx.client.rpc(rpc)
    const options = () => ({ location: ctx.location ?? ctx.data.location.default() })
    // The server publishes `dcp` while it activates this plugin, so a status call
    // made during startup can arrive before registration. Do not fail the whole TUI
    // plugin on that race: keep the panel available and re-check when it is opened.
    try {
        if (!(await client.status({}, options())).enabled) return
    } catch (cause) {
        if (!unavailable(cause)) throw cause
    }
    const api: ViewApi = {
        renderer: ctx.renderer,
        theme: {
            get current() {
                return panelTheme(ctx.theme)
            },
        },
        ui: { dialog: { clear: () => ctx.ui.dialog.clear() } },
    }
    type Snapshot = Awaited<ReturnType<typeof client.snapshot>>

    // The panel re-reads the snapshot while it is open so background planning, applying
    // and manual mode changes are visible without closing and reopening the dialog.
    function LivePanel(props: { sessionID: string; initial: Snapshot; back: () => void }) {
        const [data, setData] = createSignal(props.initial)
        let active = true
        const timer = setInterval(async () => {
            try {
                const next = await client.snapshot({ sessionID: props.sessionID }, options())
                if (active) setData(next)
            } catch {
                // The server may restart while the dialog is open; keep the last value.
            }
        }, 1000)
        onCleanup(() => {
            active = false
            clearInterval(timer)
        })
        return (
            <PanelDialog
                api={api}
                manualMode={data().manualMode}
                canCompress={data().canCompress}
                blockedReason={data().blockedReason}
                compaction={data().compaction}
                background={data().background}
                onContext={() => {
                    void open("context")
                }}
                onStats={() => {
                    void open("stats")
                }}
                onManual={(enabled) => {
                    void client
                        .manual({ sessionID: props.sessionID, enabled }, options())
                        .then(props.back)
                        .catch(error)
                }}
            />
        )
    }

    // The built-in sidebar Context row only changes when the provider reports usage on
    // the next assistant message. This row shows DCP's own live view of the context so
    // an applied background compression is visible immediately.
    function LiveSidebar(props: { sessionID: string }) {
        const [data, setData] = createSignal<Snapshot>()
        let active = true
        const timer = setInterval(async () => {
            try {
                const next = await client.snapshot({ sessionID: props.sessionID }, options())
                if (active) setData(next)
            } catch {
                // Keep the last value while the server is restarting.
            }
        }, 2000)
        onCleanup(() => {
            active = false
            clearInterval(timer)
        })
        const theme = api.theme.current
        return (
            <Show when={data()}>
                {(value: () => Snapshot) => (
                    <box>
                        <text fg={theme.text}>
                            <b>DCP</b>
                        </text>
                        <Show when={value().pendingUsageRefresh}>
                            <text fg={theme.textMuted}>
                                context: ~{formatTokenCount(value().effectiveTokens)}
                            </text>
                        </Show>
                        <text fg={theme.textMuted}>background: {value().background.status}</text>
                        <text fg={theme.textMuted}>
                            {formatTokenCount(value().savedTokens, true)} saved
                        </text>
                    </box>
                )}
            </Show>
        )
    }
    function show(render: Parameters<typeof ctx.ui.dialog.show>[0]) {
        ctx.ui.dialog.set({ size: "xlarge" })
        ctx.ui.dialog.show(render)
    }
    async function open(page: "panel" | "context" | "stats" = "panel") {
        const route = ctx.ui.router.current()
        if (route.type !== "session") {
            show(() => (
                <StatusDialog
                    api={api}
                    title="DCP"
                    eyebrow="No session"
                    message="Open a session first."
                />
            ))
            return
        }
        const sessionID = route.sessionID
        try {
            if (!(await client.status({}, options())).enabled) {
                show(() => (
                    <StatusDialog
                        api={api}
                        title="DCP"
                        eyebrow="Disabled"
                        message="DCP commands are disabled for this project."
                    />
                ))
                return
            }
            const data = await client.snapshot({ sessionID }, options())
            const back = () => {
                void open()
            }
            if (page === "context")
                show(() => <ContextDialog api={api} breakdown={data.context} onBack={back} />)
            else if (page === "stats")
                show(() => <StatsDialog api={api} report={data.stats} onBack={back} />)
            else show(() => <LivePanel sessionID={sessionID} initial={data} back={back} />)
        } catch (cause) {
            error(cause)
        }
    }
    function error(cause: unknown) {
        const message =
            cause instanceof Error
                ? cause.message
                : typeof cause === "object" && cause && "message" in cause
                  ? String(cause.message)
                  : String(cause)
        show(() => <StatusDialog api={api} title="DCP" eyebrow="DCP Error" message={message} />)
    }
    ctx.ui.slot({
        append: "app",
        render() {
            ctx.keymap.layer(() => ({
                mode: "global",
                commands: [
                    {
                        id: "dcp.panel",
                        title: "DCP",
                        description: "Open DCP panel",
                        group: "DCP",
                        palette: true,
                        slash: { name: "dcp", arguments: true },
                        run: async (input) => {
                            if (!input?.trim()) return open()
                            const route = ctx.ui.router.current()
                            if (route.type !== "session") return open()
                            try {
                                await ctx.client.session.command({
                                    sessionID: route.sessionID,
                                    name: "dcp",
                                    text: input,
                                })
                            } catch (cause) {
                                error(cause)
                            }
                        },
                    },
                ],
            }))
            return null
        },
    })
    ctx.ui.slot({
        append: "sidebar.content",
        render: (props) => <LiveSidebar sessionID={props.sessionID} />,
    })
}

// RPC calls reject with plain `{ type, message }` objects; `rpc.unavailable` means the
// server has not published the domain yet (plugin still activating) or never will.
function unavailable(cause: unknown): boolean {
    return (
        typeof cause === "object" &&
        cause !== null &&
        "type" in cause &&
        cause.type === "rpc.unavailable"
    )
}
