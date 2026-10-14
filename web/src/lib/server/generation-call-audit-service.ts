import type { GenerationCallAudit, GenerationChannelSnapshot, GenerationDiagnostic, GenerationRecoveryEvent } from "@/lib/generation-call-audit";
import type { GenerationAttempt } from "./generation-attempt";
import type { StoredGenerationTaskRecord } from "./generation-task-store";
import { sanitizeGenerationDiagnostic } from "./generation-diagnostics";

export function channelSnapshot(value: unknown): GenerationChannelSnapshot | undefined {
    const source = object(value);
    if (!text(source.logicalModelId) || !text(source.upstreamModel) || !Number(source.capturedAt)) return undefined;
    return { logicalModelId: text(source.logicalModelId), upstreamModel: text(source.upstreamModel), capturedAt: Number(source.capturedAt), channelId: text(source.channelId) || undefined, channelName: text(source.channelName) || undefined };
}

export function generationAttempts(value: unknown): GenerationAttempt[] {
    return (Array.isArray(value) ? value : []).map((item) => {
        const attempt = object(item);
        return {
            attemptNo: Number(attempt.attemptNo) || 0,
            channelId: text(attempt.channelId) || undefined,
            model: text(attempt.model),
            status: (attempt.status === "succeeded" || attempt.status === "failed" ? attempt.status : "running") as GenerationAttempt["status"],
            startedAt: Number(attempt.startedAt) || 0,
            completedAt: Number(attempt.completedAt) || undefined,
            pointsCost: Number.isFinite(attempt.pointsCost) ? Number(attempt.pointsCost) : undefined,
            error: attempt.error ? sanitizeGenerationDiagnostic(text(attempt.error)) : undefined,
            channelSnapshot: channelSnapshot(attempt.channelSnapshot),
            supplierRequestId: text(attempt.supplierRequestId) || undefined,
            failureOrigin: attempt.failureOrigin === "local" || attempt.failureOrigin === "upstream" ? attempt.failureOrigin : undefined,
        };
    });
}

export function normalizeGenerationCallAudits(value: unknown): GenerationCallAudit[] {
    return (Array.isArray(value) ? value : []).flatMap((item) => {
        const source = object(item);
        const capability = source.capability;
        if (!text(source.taskId) || !["text", "image", "video", "audio"].includes(String(capability))) return [];
        const diagnostics = (Array.isArray(source.diagnostics) ? source.diagnostics : []).flatMap((value): GenerationDiagnostic[] => {
            const diagnostic = object(value);
            const stage = diagnostic.stage as GenerationDiagnostic["stage"];
            if (!["response_parse", "checkpoint", "media_read", "image_process", "file_save", "asset_register", "task_update"].includes(stage)) return [];
            return [
                {
                    stage,
                    occurredAt: Number(diagnostic.occurredAt) || 0,
                    attemptNo: Number(diagnostic.attemptNo) || 1,
                    message: sanitizeGenerationDiagnostic(text(diagnostic.message)),
                    stack: diagnostic.stack ? sanitizeGenerationDiagnostic(text(diagnostic.stack)) : undefined,
                    supplierRequestId: text(diagnostic.supplierRequestId) || undefined,
                    upstreamTaskId: text(diagnostic.upstreamTaskId) || undefined,
                },
            ];
        });
        const recoveryEvents = (Array.isArray(source.recoveryEvents) ? source.recoveryEvents : []).map((value): GenerationRecoveryEvent => {
            const event = object(value);
            return {
                recoveredAt: Number(event.recoveredAt) || 0,
                attemptNo: Number(event.attemptNo) || 1,
                source: event.source === "admin" ? "admin" : "checkpoint",
                supplierRequestId: text(event.supplierRequestId) || undefined,
                previousError: event.previousError ? sanitizeGenerationDiagnostic(text(event.previousError)) : undefined,
            };
        });
        return [
            {
                taskId: text(source.taskId),
                role: source.role === "planning" ? "planning" : "generation",
                capability: capability as GenerationCallAudit["capability"],
                channelSnapshot: channelSnapshot(source.channelSnapshot),
                attempts: generationAttempts(source.attempts),
                diagnostics,
                recoveryEvents,
            },
        ];
    });
}

export function generationTaskCallAudits(record: StoredGenerationTaskRecord): GenerationCallAudit[] {
    const config = object(record.payload.config);
    if (record.type === "agent") {
        const planner = object(record.payload.plannerAudit);
        if (planner.mode !== "model") return [];
        const snapshot = channelSnapshot({ ...planner, capturedAt: planner.capturedAt });
        if (Array.isArray(planner.attempts) && planner.attempts.length) return [{ taskId: record.id, role: "planning", capability: "text", channelSnapshot: snapshot, attempts: generationAttempts(planner.attempts) }];
        return [
            {
                taskId: record.id,
                role: "planning",
                capability: "text",
                channelSnapshot: snapshot,
                attempts: [
                    {
                        attemptNo: 1,
                        channelId: text(planner.channelId) || undefined,
                        model: text(planner.logicalModelId),
                        channelSnapshot: snapshot,
                        startedAt: Number(planner.capturedAt) || record.createdAt,
                        completedAt: Number(planner.capturedAt) ? Number(planner.capturedAt) + (Number(planner.elapsedMs) || 0) : undefined,
                        status: "succeeded",
                        pointsCost: Number(planner.pointsCost) || 0,
                    },
                ],
            },
        ];
    }
    if (record.type === "render") return [];
    return normalizeGenerationCallAudits([
        {
            taskId: record.id,
            role: "generation",
            capability: record.type,
            channelSnapshot: Array.isArray(record.payload.attempts) && record.payload.attempts.length ? config.channelSnapshot : undefined,
            attempts: record.payload.attempts,
            diagnostics: record.payload.diagnostics,
            recoveryEvents: record.payload.recoveryEvents,
        },
    ]);
}

function object(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function text(value: unknown) {
    return typeof value === "string" ? value : "";
}
