import type { SessionState, WithParts } from "../state";
/** Timestamp of the assistant response whose usage is the current provider count. */
export declare function lastUsageCreated(messages: WithParts[]): number | undefined;
/**
 * Net tokens removed by compression blocks that are still active.
 * When `since` is set, only blocks created after that timestamp are counted, i.e.
 * the savings that the current provider usage cannot reflect yet.
 */
export declare function activeCompressionSavings(state: SessionState, since?: number): number;
/**
 * Whether a compression block was applied after the last provider usage report.
 * The reported usage is then stale until the next assistant response, so another
 * background plan must not be started from it.
 */
export declare function compressionSinceUsage(state: SessionState, messages: WithParts[]): boolean;
/**
 * Estimate of the context the next request will use. The last provider usage is
 * authoritative, minus compression that was applied after that response.
 */
export declare function effectiveContextTokens(contextTotal: number, state: SessionState, messages: WithParts[]): number;
//# sourceMappingURL=estimate.d.ts.map