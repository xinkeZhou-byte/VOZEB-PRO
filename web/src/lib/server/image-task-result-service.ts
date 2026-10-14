import type { ImageTaskMediaResult, ImageTaskResult } from "@/app/api/image-tasks/image-task-types";
import { directRemoteImageResult, imageReferenceToDataUrl, inlineRemoteImageResult, resolveProxiedMediaSource } from "@/app/api/image-tasks/image-task-support";
import { resolveResultSize } from "@/app/api/image-tasks/image-task-size";
import { dedupeImageResults } from "@/lib/image-result-dedupe";
import { generationModelId, systemGenerationChannelId } from "@/lib/server/generation-channel";
import { generationMediaProxyHeaders } from "@/lib/server/generation-media-authorization";
import { deleteLocalAsset, normalizeAssets } from "@/lib/server/generation-log-repository";
import { validateImageLayerOutputs } from "@/lib/server/image-layer-output";
import type { ImageTask, StoredImageTaskMediaResult } from "@/lib/server/image-task-store";
import { assertTransparentImageOutput } from "@/lib/server/image-transparent-output";
import { recordPreparedCheckpointOutput } from "@/lib/server/image-result-checkpoint";
import { imageResultStage } from "@/lib/server/generation-diagnostics";
import { mutateImageTask } from "@/lib/server/image-task-store";
import { getLocalMediaRegistration } from "@/lib/server/local-media-registry";

export class ImageOutputValidationError extends Error {}

export async function prepareImageTaskResults(task: ImageTask, result: ImageTaskResult, origin: string, authContext: string): Promise<StoredImageTaskMediaResult[]> {
    if (task.resultCheckpoint) return prepareCheckpointResults(task, origin, authContext);
    return prepareResults(task, result, origin, authContext);
}

async function prepareResults(task: ImageTask, result: ImageTaskResult, origin: string, authContext: string, storageKeys?: string[]): Promise<StoredImageTaskMediaResult[]> {
    const preserveLayers = task.config.outputMode === "layers";
    const settled = await Promise.allSettled(imageTaskMediaResults(result, preserveLayers).map((item) => normalizeSafeImageResult(task, item, origin, authContext)));
    const normalized = settled.flatMap((item) => (item.status === "fulfilled" && item.value?.dataUrl ? [item.value] : []));
    let safeResults = preserveLayers ? normalized : dedupeImageResults(normalized);

    if (preserveLayers) {
        const rejected = firstRejected(settled);
        if (rejected) throw new ImageOutputValidationError(`上游分层验收失败：${errorMessage(rejected, "上游分层图片无法读取")}，请为该模型配置真实分层接口`);
    }
    if (!safeResults.length) throw firstRejected(settled) || new Error("上游返回的图片文件无效或保存失败");

    if (task.config.outputBackground === "transparent") {
        const validated = await Promise.allSettled(safeResults.map(async (item) => (await assertTransparentImageOutput(item.dataUrl), item)));
        safeResults = validated.flatMap((item) => (item.status === "fulfilled" ? [item.value] : []));
        if (!safeResults.length) throw new ImageOutputValidationError(errorMessage(firstRejected(validated), "上游没有生成有效透明图层"));
    }

    if (preserveLayers) {
        if (task.kind !== "edit" || task.references.length !== 1) throw new ImageOutputValidationError("上游分层验收失败：电商分层需要且只能使用一张源图，请为该模型配置真实分层接口");
        try {
            const source = await imageReferenceToDataUrl(task.references[0], task.references[0].name || "source.png", origin, authContext);
            const validated = await validateImageLayerOutputs(
                source,
                safeResults.map((item) => item.dataUrl),
            );
            safeResults = validated.map((output, index) => ({ ...safeResults[index], ...output, remoteUrl: undefined }));
        } catch (error) {
            throw new ImageOutputValidationError(`上游分层验收失败：${errorMessage(error, "上游分层结果无法验证")}，请为该模型配置真实分层接口`);
        }
    }

    return persistPreparedResults(task, safeResults, preserveLayers, storageKeys);
}

async function prepareCheckpointResults(task: ImageTask, origin: string, authContext: string) {
    const checkpoint = task.resultCheckpoint!;
    const readOutput = async (output: (typeof checkpoint.outputs)[number]) => {
        const registered = task.config.outputMode === "layers" ? output.prepared || (await registeredCheckpointResult(task, output.preparedStorageKey)) : undefined;
        const source = registered?.serverUrl || (output.privateMediaKey ? `/api/reference-assets/${output.privateMediaKey}` : output.sourceUrl || "");
        const dataUrl =
            source.startsWith("/api/reference-assets/") || source.startsWith("/api/generation-log-assets/") ? await imageResultStage(task, "media_read", () => imageReferenceToDataUrl({ dataUrl: source }, "upstream.png", origin, authContext)) : source;
        return { dataUrl, remoteUrl: output.remoteUrl };
    };
    if (task.config.outputMode === "layers") {
        if (checkpoint.outputs.every((output) => output.prepared)) return checkpoint.outputs.map((output) => output.prepared!);
        const inputs = await Promise.all(checkpoint.outputs.map(readOutput));
        const prepared = await imageResultStage(task, "image_process", () =>
            prepareResults(
                { ...task, resultCheckpoint: undefined },
                { ...inputs[0], results: inputs },
                origin,
                authContext,
                checkpoint.outputs.map((output) => output.preparedStorageKey),
            ),
        );
        await Promise.all(prepared.map((item, ordinal) => recordPreparedCheckpointOutput(task, ordinal, item)));
        return prepared;
    }
    const settled = await Promise.allSettled(
        checkpoint.outputs.map(async (output) => {
            if (output.prepared) return output.prepared;
            const registered = await registeredCheckpointResult(task, output.preparedStorageKey);
            if (registered) {
                await imageResultStage(task, "task_update", () => recordPreparedCheckpointOutput(task, output.ordinal, registered));
                return registered;
            }
            const input = await readOutput(output);
            const [prepared] = await imageResultStage(task, "image_process", () => prepareResults({ ...task, resultCheckpoint: undefined }, input, origin, authContext, [output.preparedStorageKey]));
            await imageResultStage(task, "task_update", () => recordPreparedCheckpointOutput(task, output.ordinal, prepared));
            return prepared;
        }),
    );
    const prepared = settled.flatMap((item) => (item.status === "fulfilled" ? [item.value] : []));
    if (prepared.length) await imageResultStage(task, "task_update", () => mutateImageTask(task.id, (current) => (current.status === "cancelled" ? null : { ...current, result: { ...prepared[0], results: prepared } })));
    const rejected = firstRejected(settled);
    if (rejected) throw rejected;
    if (!prepared.length) throw new Error("上游返回的图片文件无效或保存失败");
    return prepared;
}

export function persistedImageTaskResults(task: ImageTask): StoredImageTaskMediaResult[] {
    const values = task.result?.results?.length ? task.result.results : task.result ? [task.result] : [];
    if (!values.length || values.some((item) => !isStableServerResult(item))) return [];
    return values;
}

export function deletePreparedImageTaskResults(results: StoredImageTaskMediaResult[]) {
    return Promise.allSettled(results.map((item) => deleteLocalAsset(item.serverUrl || item.dataUrl)));
}

async function persistPreparedResults(task: ImageTask, results: ImageTaskMediaResult[], requireAll: boolean, storageKeys?: string[]) {
    const targetSize = task.config.outputMode === "layers" ? undefined : resolveResultSize(task.config.quality, task.config.size || "auto");
    const settled = await Promise.allSettled(
        results.map(async (item, index) => {
            const existing = storageKeys?.[index] ? await registeredCheckpointResult(task, storageKeys[index]) : null;
            if (existing) return [{ type: "image" as const, ...existing, width: item.width, height: item.height, url: existing.serverUrl! }];
            return normalizeAssets([{ type: "image", url: item.dataUrl, remoteUrl: item.remoteUrl, targetSize }], {
                ownerUserId: task.userId,
                source: task.source,
                conversationId: task.conversationId,
                runId: task.runId,
                taskId: task.id,
                storageKey: storageKeys?.[index],
                originalName: `${task.title || task.prompt.slice(0, 80) || "图片生成"}-${index + 1}`,
            });
        }),
    );
    const stored = settled
        .flatMap((item) => (item.status === "fulfilled" ? item.value : []))
        .map((asset) => ({
            dataUrl: asset.serverUrl || asset.url,
            remoteUrl: asset.remoteUrl,
            serverUrl: asset.serverUrl,
            width: asset.width,
            height: asset.height,
            bytes: asset.bytes,
            mimeType: asset.mimeType,
        }));
    if (requireAll && stored.length !== results.length) {
        throw firstRejected(settled) || new Error("上游分层图片保存失败");
    }
    if (!stored.length) throw firstRejected(settled) || new Error("生成图片保存到服务器失败");
    return stored;
}

async function registeredCheckpointResult(task: ImageTask, key: string): Promise<StoredImageTaskMediaResult | null> {
    const registration = await getLocalMediaRegistration(key);
    if (!registration || registration.ownerUserId !== task.userId || registration.taskId !== task.id || registration.scope !== "generation" || registration.type !== "image") return null;
    const serverUrl = `/api/generation-log-assets/${key.split("/").map(encodeURIComponent).join("/")}`;
    return { dataUrl: serverUrl, serverUrl, bytes: registration.bytes, mimeType: registration.mimeType };
}

function imageTaskMediaResults(result: ImageTaskResult, preserveDuplicates: boolean): ImageTaskMediaResult[] {
    const values = result.results?.length ? result.results : result.dataUrl || result.remoteUrl ? [{ dataUrl: result.dataUrl, remoteUrl: result.remoteUrl }] : [];
    return preserveDuplicates ? values : dedupeImageResults(values);
}

async function normalizeSafeImageResult(task: ImageTask, result: ImageTaskMediaResult, origin: string, authContext: string): Promise<ImageTaskMediaResult> {
    const remoteUrl = typeof result.remoteUrl === "string" ? result.remoteUrl : undefined;
    const proxiedMedia = resolveProxiedMediaSource(result.dataUrl || "", origin);
    const proxiedRemoteUrl = proxiedMedia.remoteUrl;
    const channelId = task.config.channelId || systemGenerationChannelId(task.config.baseUrl);
    const mediaHeaders = proxiedRemoteUrl && channelId ? generationMediaProxyHeaders({ userId: task.userId, taskType: "image", taskId: task.id, channelId, upstreamModel: generationModelId(task.config), url: proxiedRemoteUrl }) : undefined;
    const inlineResult = proxiedMedia.proxyUrl ? await inlineRemoteImageResult(result.dataUrl, origin, authContext, remoteUrl, mediaHeaders) : null;
    if (proxiedMedia.proxyUrl && !inlineResult?.dataUrl?.startsWith("data:image/")) throw new Error("上游图片无法通过授权媒体路径读取");
    if (task.config.outputMode === "layers") {
        const readable = inlineResult || (await inlineRemoteImageResult(result.dataUrl || remoteUrl || "", origin, authContext, remoteUrl, mediaHeaders));
        if (!readable?.dataUrl?.startsWith("data:image/")) throw new Error("上游分层图片无法读取并验收");
        return readable;
    }
    return inlineResult || directRemoteImageResult(remoteUrl) || (await inlineRemoteImageResult(result.dataUrl, origin, authContext, remoteUrl, mediaHeaders));
}

function isStableServerResult(result: StoredImageTaskMediaResult) {
    const value = result.serverUrl || result.dataUrl;
    return value.startsWith("/api/generation-log-assets/") || value.startsWith("/api/reference-assets/");
}

function firstRejected(results: PromiseSettledResult<unknown>[]) {
    return results.find((item): item is PromiseRejectedResult => item.status === "rejected")?.reason;
}

function errorMessage(error: unknown, fallback: string) {
    return error instanceof Error ? error.message : fallback;
}
