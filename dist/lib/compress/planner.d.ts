import type { PlannerConfig, PluginConfig } from "../config";
import type { SessionState, WithParts } from "../state";
import type { CompressMessageEntry, CompressRangeEntry, ResolvedMessageCompression, ResolvedRangeCompression, SearchContext, ToolContext } from "./types";
export interface ModelRef {
    providerID: string;
    id: string;
    variant?: string;
}
export interface PlannerRangeSelection {
    startId: string;
    endId: string;
    topic?: string;
    summary: string;
}
export interface PlannerMessageSelection {
    messageId: string;
    topic?: string;
    summary: string;
}
export declare function parsePlannerModel(value: PlannerConfig["model"] | undefined): ModelRef | null;
export declare function resolvePlannerModel(config: PluginConfig, state: SessionState, messages?: WithParts[]): ModelRef | null;
export interface CompactionInfo {
    enabled: boolean;
    /** Explicitly configured model, formatted as `providerID/modelID`. */
    model?: string;
    /** Thinking level (model variant) used for compression. */
    variant?: string;
}
export declare function compactionInfo(config: PluginConfig): CompactionInfo;
export declare function dropUnavailableVariant(model: ModelRef, availableVariants: ReadonlySet<string> | undefined): ModelRef;
export declare function isPlannerEnabled(ctx: ToolContext): boolean;
export declare function renderMessage(message: WithParts, state: SessionState, options?: {
    config?: PluginConfig;
}): string | null;
export declare function renderTranscript(messages: WithParts[], state: SessionState, options?: {
    config?: PluginConfig;
    includeCompressedBlocks?: boolean;
}): string;
export declare function parsePlannerRanges(text: string): PlannerRangeSelection[];
export declare function parsePlannerMessages(text: string): PlannerMessageSelection[];
export declare function autoCandidates(ctx: ToolContext, searchContext: SearchContext): WithParts[];
export declare function planAutoRangeCompression(ctx: ToolContext, sessionID: string, topic: string, focus: string | undefined, searchContext: SearchContext): Promise<CompressRangeEntry[]>;
export declare function planAutoMessageCompression(ctx: ToolContext, sessionID: string, topic: string, focus: string | undefined, searchContext: SearchContext): Promise<CompressMessageEntry[]>;
export declare function fillRangeSummaries(ctx: ToolContext, sessionID: string, topic: string, focus: string | undefined, plans: ResolvedRangeCompression[], searchContext: SearchContext): Promise<CompressRangeEntry[]>;
export declare function fillMessageSummaries(ctx: ToolContext, sessionID: string, topic: string, focus: string | undefined, plans: ResolvedMessageCompression[], searchContext: SearchContext): Promise<CompressMessageEntry[]>;
//# sourceMappingURL=planner.d.ts.map