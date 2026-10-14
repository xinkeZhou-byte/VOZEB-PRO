import type { LogicalModel, SystemModelChannel } from "@/lib/auth/store";
import { getStoredGenerationTaskRecord } from "./generation-task-store";
import { decryptSecretValue } from "./secret-crypto";
import { SYSTEM_AI_TASK_HEADER } from "./system-ai-billing";

// A saved transport is only available for query/cancel of this user's submitted task.
export async function readSubmittedGenerationRoute(headers: Headers, userId: string, channelId: string, upstreamModel: string) {
    const identity = headers.get(SYSTEM_AI_TASK_HEADER);
    if (!identity) return undefined;
    const match = /^(text|image|video|audio):(.+)$/.exec(identity);
    if (!match) return null;
    const type = match[1] as "text" | "image" | "video" | "audio";
    const record = await getStoredGenerationTaskRecord(type, match[2]);
    if (!record || record.userId !== userId || record.channelId !== channelId || !record.upstreamTaskId || (record.status === "cancelled" && !["cancel_requested", "cancel_polling"].includes(record.executionPhase || ""))) return null;
    const config = record.payload.config as { model: string; logicalModel?: string; upstreamRouteCiphertext?: string };
    const normalize = (value: string) =>
        value
            .trim()
            .replace(/^models\//i, "")
            .toLowerCase();
    if (!config?.model || normalize(config.model) !== normalize(upstreamModel)) return null;
    const channel = config.upstreamRouteCiphertext ? (JSON.parse(decryptSecretValue(config.upstreamRouteCiphertext)) as SystemModelChannel) : undefined;
    if (channel && channel.id !== channelId) return null;
    const logicalModel: LogicalModel = {
        id: config.logicalModel || config.model,
        name: config.logicalModel || config.model,
        capability: type,
        enabled: false,
        bindings: [{ id: record.id, channelId, upstreamModel: config.model, enabled: false, priority: 0 }],
    };
    return { channel, logicalModel, upstreamTaskId: record.upstreamTaskId };
}
