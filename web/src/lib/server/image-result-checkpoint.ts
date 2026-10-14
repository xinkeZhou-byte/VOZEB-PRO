import type { ImageTaskResult } from "@/app/api/image-tasks/image-task-types";
import { dedupeImageResults } from "@/lib/image-result-dedupe";
import { mediaFileExtension } from "@/lib/media-file";
import { imageResultStage } from "./generation-diagnostics";
import { createDatedMediaPath } from "./local-media-storage";
import { getLocalMediaRegistration } from "./local-media-registry";
import { writeReferenceImageDataUrl } from "./reference-asset-store";
import { mutateImageTask, type ImageTask, type ImageResultCheckpoint, type StoredImageTaskMediaResult } from "./image-task-store";

export const IMAGE_CHECKPOINT_RESULT_URL = "checkpoint://image-task-result";

export function hasImageResultCheckpoint(task: ImageTask) {
    return Boolean(task.resultCheckpoint?.outputs.some((item) => item.sourceUrl || item.privateMediaKey));
}

export async function captureImageResultCheckpoint(task: ImageTask, result: ImageTaskResult, source: ImageResultCheckpoint["source"] = "upstream", supplierRequestId?: string) {
    const values = result.results?.length ? result.results : result.dataUrl || result.remoteUrl ? [result] : [];
    const outputs = task.config.outputMode === "layers" ? values : dedupeImageResults(values);
    if (!outputs.length) throw new Error("上游未返回可保存的图片产物");
    const proposed: ImageResultCheckpoint = {
        attemptNo: task.attemptNo || 1,
        capturedAt: Date.now(),
        supplierRequestId,
        source,
        outputs: outputs.map((item, ordinal) => {
            const url = item.dataUrl || item.remoteUrl || "";
            const extension = mediaFileExtension(item.mimeType, url, "png");
            return {
                ordinal,
                sourceUrl: url.startsWith("data:") ? undefined : url,
                remoteUrl: item.remoteUrl,
                privateMediaKey: url.startsWith("data:") ? createDatedMediaPath("temporary", "image", extension) : undefined,
                preparedStorageKey: createDatedMediaPath("permanent", "image", extension),
            };
        }),
    };
    return imageResultStage(task, "checkpoint", async () => {
        const saved = await mutateImageTask(task.id, (current) => (current.status === "cancelled" ? null : { ...current, resultCheckpoint: current.resultCheckpoint?.attemptNo === proposed.attemptNo ? current.resultCheckpoint : proposed }));
        if (!saved) throw new Error("图片任务已取消或删除");
        const checkpoint = saved.resultCheckpoint!;
        for (const output of checkpoint.outputs) {
            const raw = outputs[output.ordinal]?.dataUrl || "";
            if (output.privateMediaKey && output.privateMediaKey === proposed.outputs[output.ordinal]?.privateMediaKey && raw.startsWith("data:")) {
                await writeReferenceImageDataUrl(raw, { ownerUserId: task.userId, source: task.source, taskId: task.id, conversationId: task.conversationId, runId: task.runId, storageKey: output.privateMediaKey, originalName: "上游原始产物" });
            } else if (output.sourceUrl?.startsWith("/api/reference-assets/") || output.sourceUrl?.startsWith("/api/generation-log-assets/")) {
                const key = decodeURIComponent(output.sourceUrl.replace(/^\/api\/(?:reference-assets|generation-log-assets)\//, "").split("?")[0]);
                const registration = await getLocalMediaRegistration(key);
                if (!registration || registration.ownerUserId !== task.userId) throw new Error("结果媒体不属于原任务用户");
            }
        }
        return checkpoint;
    });
}

export function recordPreparedCheckpointOutput(task: ImageTask, ordinal: number, prepared: StoredImageTaskMediaResult) {
    return mutateImageTask(task.id, (current) => {
        const checkpoint = current.resultCheckpoint;
        if (!checkpoint || checkpoint.attemptNo !== (task.attemptNo || 1) || current.status === "cancelled") return null;
        return { ...current, resultCheckpoint: { ...checkpoint, outputs: checkpoint.outputs.map((item) => (item.ordinal === ordinal ? { ...item, prepared } : item)) } };
    });
}
