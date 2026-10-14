import { getDatabaseProvider, subscribePostgresNotification } from "@/lib/server/database";

export const GENERATION_TASK_NOTIFY_CHANNEL = "vozeb_pro_generation_events";
export type GenerationTaskChange = { id: string; type: string; runId?: string; logId?: string };
const localListeners = new Set<(change: GenerationTaskChange) => void>();

export function notifyGenerationTaskChange(change: GenerationTaskChange) {
    for (const listener of localListeners) listener(change);
}

export async function subscribeGenerationTaskChanges(keys: Set<string>, listener: () => void) {
    const accept = (change: GenerationTaskChange) => {
        if (keys.has(`${change.type}:${change.id}`) || (change.runId && keys.has(`agent:${change.runId}`)) || (change.logId && keys.has(`log:${change.logId}`)) || keys.has(`log:${change.type}-task:${change.id}`)) listener();
    };
    if (getDatabaseProvider() === "postgres")
        return subscribePostgresNotification(GENERATION_TASK_NOTIFY_CHANNEL, (payload) => {
            try {
                accept(JSON.parse(payload) as GenerationTaskChange);
            } catch {
                /* Ignore unrelated or malformed notifications. */
            }
        });
    localListeners.add(accept);
    return () => {
        localListeners.delete(accept);
    };
}
