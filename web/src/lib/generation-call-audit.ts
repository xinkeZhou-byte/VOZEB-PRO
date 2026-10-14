export type GenerationChannelSnapshot = {
    logicalModelId: string;
    upstreamModel: string;
    channelId?: string;
    channelName?: string;
    capturedAt: number;
};

export type GenerationDiagnostic = {
    stage: "response_parse" | "checkpoint" | "media_read" | "image_process" | "file_save" | "asset_register" | "task_update";
    occurredAt: number;
    attemptNo: number;
    supplierRequestId?: string;
    upstreamTaskId?: string;
    message: string;
    stack?: string;
};

export type GenerationRecoveryEvent = {
    recoveredAt: number;
    attemptNo: number;
    supplierRequestId?: string;
    source: "checkpoint" | "admin";
    previousError?: string;
};

export type GenerationCallAudit = {
    taskId: string;
    role: "planning" | "generation";
    capability: "text" | "image" | "video" | "audio";
    channelSnapshot?: GenerationChannelSnapshot;
    attempts: import("@/lib/server/generation-attempt").GenerationAttempt[];
    diagnostics?: GenerationDiagnostic[];
    recoveryEvents?: GenerationRecoveryEvent[];
};
