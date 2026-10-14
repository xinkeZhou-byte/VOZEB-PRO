import type { GenerationDiagnostic } from "@/lib/generation-call-audit";
import { mutateImageTask, type ImageTask } from "./image-task-store";
import { GenerationResultError } from "./generation-result-error";

export function sanitizeGenerationDiagnostic(value: string, secrets: string[] = []) {
    let text = value;
    for (const secret of secrets.filter((item) => item && item !== "system")) text = text.replaceAll(secret, "[redacted]");
    return text
        .replace(/data:[^\s"'<>]+/gi, "[private media]")
        .replace(/https?:\/\/[^\s"'<>]+/gi, "[upstream URL]")
        .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [redacted]")
        .replace(/((?:authorization|api[_-]?key|password|secret|token|cookie)["']?\s*[:=]\s*["']?)[^\s,"'<>}]+/gi, "$1[redacted]")
        .replace(/\bsk-[A-Za-z0-9_-]+/g, "[redacted]");
}

export async function recordImageTaskDiagnostic(task: ImageTask, stage: GenerationDiagnostic["stage"], error: unknown) {
    const diagnostic: GenerationDiagnostic = {
        stage: error instanceof GenerationResultError ? error.stage : stage,
        occurredAt: Date.now(),
        attemptNo: task.attemptNo || 1,
        supplierRequestId: task.attempts?.at(-1)?.supplierRequestId,
        upstreamTaskId: task.upstream?.id,
        message: sanitizeGenerationDiagnostic(error instanceof Error ? error.message : "结果处理失败", [task.config.apiKey]),
        stack: error instanceof Error && error.stack ? sanitizeGenerationDiagnostic(error.stack, [task.config.apiKey]) : undefined,
    };
    await mutateImageTask(task.id, (current) => ({ ...current, diagnostics: [...(current.diagnostics || []), diagnostic] }));
    console.warn("Image result processing interrupted", { taskId: task.id, ...diagnostic });
    return diagnostic;
}

export async function imageResultStage<T>(task: ImageTask, stage: GenerationDiagnostic["stage"], action: () => Promise<T>) {
    try {
        return await action();
    } catch (error) {
        await recordImageTaskDiagnostic(task, stage, error).catch(() => undefined);
        throw error;
    }
}
