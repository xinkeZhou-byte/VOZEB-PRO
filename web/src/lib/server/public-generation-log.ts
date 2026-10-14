import type { StoredGenerationLog } from "./generation-log-types";

export function publicGenerationLog(log: StoredGenerationLog): StoredGenerationLog {
    const snapshot = log.requestSnapshot;
    return {
        id: log.id,
        userId: log.userId,
        username: log.username,
        displayName: log.displayName,
        conversationId: log.conversationId,
        kind: log.kind,
        source: log.source,
        status: log.status,
        title: log.title,
        prompt: log.prompt,
        model: log.model,
        summary: log.summary,
        durationMs: log.durationMs,
        count: log.count,
        successCount: log.successCount,
        failCount: log.failCount,
        assets: log.assets,
        taskId: log.taskId,
        error: log.error,
        createdAt: log.createdAt,
        updatedAt: log.updatedAt,
        completedAt: log.completedAt,
        requestSnapshot: snapshot ? { version: 1, userPrompt: snapshot.userPrompt, parameters: snapshot.parameters, references: snapshot.references, slots: snapshot.slots } : undefined,
    };
}
