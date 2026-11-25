import type { NotificationEntry } from "./pipeline";
import type { ResolvedMessageCompression, ResolvedRangeCompression, SearchContext, ToolContext } from "./types";
export interface CompressionToolMeta {
    messageID?: string;
    callID?: string;
}
export interface AppliedCompression {
    notifications: NotificationEntry[];
    totalCompressedMessages: number;
}
export declare function applyResolvedRangeCompression(ctx: ToolContext, searchContext: SearchContext, topic: string, plans: ResolvedRangeCompression[], meta: CompressionToolMeta): Promise<AppliedCompression>;
export declare function applyResolvedMessageCompression(ctx: ToolContext, searchContext: SearchContext, topic: string, plans: ResolvedMessageCompression[], meta: CompressionToolMeta): Promise<AppliedCompression>;
//# sourceMappingURL=apply.d.ts.map