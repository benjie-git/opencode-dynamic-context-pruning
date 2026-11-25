import type { PluginConfig } from "../config";
import type { CompressionMode, WithParts } from "../state";
import type { CompressMessageEntry, CompressRangeEntry, SearchContext, ToolContext } from "./types";
export interface BackgroundCompressionPlan {
    sessionID: string;
    mode: CompressionMode;
    topic: string;
    modelKey?: string;
    firstMessageId?: string;
    lastMessageId?: string;
    createdAt: number;
    status: "running" | "ready" | "failed";
    entries?: CompressRangeEntry[] | CompressMessageEntry[];
    error?: string;
    failures: number;
    retryAt?: number;
}
export interface StartBackgroundCompressionInput {
    ctx: ToolContext;
    sessionID: string;
    messages: WithParts[];
    searchContext: SearchContext;
    modelKey?: string;
    currentTokens: number;
    /** Called in the background as soon as the plan is ready, so it can be applied while idle. */
    onReady?: () => void;
}
export declare function backgroundCompressionEnabled(config: PluginConfig): boolean;
/**
 * Records that compression will be needed soon. The planner is started from the
 * session's idle hook instead, so it cannot compete with the step's model request.
 */
export declare function markBackgroundCompressionDue(input: StartBackgroundCompressionInput): void;
export declare function takeDueBackgroundCompression(sessionID: string): StartBackgroundCompressionInput | undefined;
export declare function clearBackgroundCompressionDue(sessionID: string): void;
export interface BackgroundCompressionSnapshot {
    status: "idle" | "running" | "ready" | "failed";
    failures?: number;
    error?: string;
    /** Token count at which background planning starts for this session. */
    startsAt?: number;
    /** Current provider-reported context usage. */
    currentTokens?: number;
}
export declare function backgroundCompressionStatus(sessionID: string): BackgroundCompressionSnapshot;
export declare function startBackgroundCompression(input: StartBackgroundCompressionInput): boolean;
export declare function takeBackgroundCompressionPlan(sessionID: string): BackgroundCompressionPlan | undefined;
export declare function discardBackgroundCompressionPlan(sessionID: string): void;
export declare function isBackgroundCompressionPlanCurrent(plan: BackgroundCompressionPlan, messages: WithParts[], modelKey: string | undefined): boolean;
//# sourceMappingURL=precompute.d.ts.map