import type { GenerationDiagnostic } from "@/lib/generation-call-audit";

export class GenerationResultError extends Error {
    constructor(
        public readonly stage: GenerationDiagnostic["stage"],
        error: unknown,
    ) {
        super(error instanceof Error ? error.message : "生成结果保存失败", { cause: error });
        this.name = "GenerationResultError";
        if (error instanceof Error && error.stack) this.stack = `${this.name} (${stage})\n${error.stack}`;
    }
}

export async function resultPersistenceStage<T>(stage: GenerationDiagnostic["stage"], action: () => Promise<T>) {
    try {
        return await action();
    } catch (error) {
        throw error instanceof GenerationResultError ? error : new GenerationResultError(stage, error);
    }
}
