import type { PluginConfig } from "../config";
import type { SessionState } from "../state";
import type { CompressMessageToolArgs, ResolvedMessageCompressionsResult, SearchContext } from "./types";
export interface ValidateArgsOptions {
    allowEmptyContent?: boolean;
    allowMissingSummary?: boolean;
}
export declare function validateArgs(args: CompressMessageToolArgs, options?: ValidateArgsOptions): void;
export declare function formatResult(processedCount: number, skippedIssues: string[], skippedCount: number): string;
export declare function formatIssues(skippedIssues: string[], skippedCount: number): string;
export declare function resolveMessages(args: CompressMessageToolArgs, searchContext: SearchContext, state: SessionState, config: PluginConfig): ResolvedMessageCompressionsResult;
//# sourceMappingURL=message-utils.d.ts.map