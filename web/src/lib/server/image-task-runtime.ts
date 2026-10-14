import { runCustomImageTask, pollCustomImageTask } from "@/app/api/image-tasks/image-task-custom";
import { runGeminiImageTask } from "@/app/api/image-tasks/image-task-gemini";
import { runOpenAiImageTask } from "@/app/api/image-tasks/image-task-openai";
import { imageUnits, ImageQueryContractError, ImageUpstreamTerminalError, pollOpenAiImageTask } from "@/app/api/image-tasks/image-task-support";
import type { ImageTaskRunResult } from "@/app/api/image-tasks/image-task-types";
import { stableMediaUrl, writeImageGenerationLog } from "@/app/api/image-tasks/image-task-runner";
import { getAuthSettings, refundUserPoints } from "@/lib/auth/store";
import { registerGenerationTaskAssetsForUser } from "@/lib/server/creative-runtime-service";
import { reconcileRecoveredImageRun } from "@/lib/server/image-task-run-recovery";
import { finishGenerationAttempt, startGenerationAttempt } from "@/lib/server/generation-attempt";
import { generationModelId } from "@/lib/server/generation-channel";
import { refundImageTask } from "@/lib/server/image-task-refund";
import { ImageOutputValidationError, persistedImageTaskResults, prepareImageTaskResults } from "@/lib/server/image-task-result-service";
import { captureImageResultCheckpoint, hasImageResultCheckpoint, IMAGE_CHECKPOINT_RESULT_URL } from "@/lib/server/image-result-checkpoint";
import { imageResultStage } from "@/lib/server/generation-diagnostics";
import { scheduleGenerationTask } from "@/lib/server/generation-task-scheduler";
import { GenerationSubmissionSafeFailure, generationSubmissionUncertainError } from "@/lib/server/generation-submission-error";
import { getImageTask, transitionImageTask, updateImageTask, type ImageTask, type StoredImageTaskMediaResult } from "@/lib/server/image-task-store";
import { maintenanceWorkerContext } from "@/lib/server/maintenance-auth";
import { resolveModelRequestTimeoutMs } from "@/lib/server/model-request-policy";
import { freshGenerationCandidates } from "@/lib/server/generation-route-freshness";

export type ImageUpstreamStep =
    | { state: "pending"; upstream: NonNullable<ImageTask["upstream"]>; status: string }
    | { state: "needs_review"; reason: string; status: string }
    | { state: "result_ready"; resultUrl: string; status: string }
    | { state: "completed" }
    | { state: "failed"; error: string; status: string; retryReason?: "upstream_failed" };

export async function createImageTaskUpstreamStep(task: ImageTask, origin: string, publicOrigin: string, cookie = "", workerUserId = ""): Promise<ImageUpstreamStep> {
    const current = await getImageTask(task.id);
    if (!current || current.status === "cancelled") return { state: "failed", error: "任务已取消", status: "cancelled" };
    const running = current.status === "pending" ? await transitionImageTask(current, ["pending"], { status: "running" }) : current;
    if (!running) return { state: "failed", error: "图片任务状态已变化", status: "conflict" };
    if (hasImageResultCheckpoint(running)) return readyImageStep(running, IMAGE_CHECKPOINT_RESULT_URL);
    const prepared = persistedImageTaskResults(running);
    if (prepared.length) return readyImageStep(running, prepared[0].serverUrl || prepared[0].dataUrl);
    if (running.upstream?.id) return queryImageTaskUpstreamStep(running, origin, cookie, workerUserId);

    const authContext = cookie || maintenanceWorkerContext(workerUserId || task.userId);
    const candidates = await freshGenerationCandidates(running.config, "image", running.candidateConfigs);
    const config = candidates[0];
    if (!config) return { state: "failed", error: "逻辑模型没有可用的已保存渠道", status: "no_saved_route" };
    let attempts = running.attempts || [];
    const started = startGenerationAttempt(attempts, { channelId: config.channelId, model: generationModelId(config), capability: "image", channelSnapshot: config.channelSnapshot });
    attempts = started.attempts;
    const candidate = { ...running, config, attempts, attemptNo: started.attempt.attemptNo, upstream: undefined, billing: undefined };
    await updateImageTask(task.id, { config, attempts, attemptNo: candidate.attemptNo, upstream: undefined, billing: undefined });
    const submissionStartedAt = Date.now();
    await scheduleGenerationTask("image", task.id, {
        executionPhase: "submitting",
        submittedAt: submissionStartedAt,
        nextPollAt: submissionStartedAt + resolveModelRequestTimeoutMs(config, "image"),
        channelId: config.channelId,
        provider: config.advancedConfig?.protocol || config.apiFormat,
        lastUpstreamStatus: "submitting",
    });
    try {
        const result = usesDeclarativeImageProtocol(config.advancedConfig?.protocol)
            ? await runCustomImageTask(candidate, origin, publicOrigin, authContext, true)
            : config.apiFormat === "gemini"
              ? await runGeminiImageTask(candidate, origin, authContext)
              : await runOpenAiImageTask(candidate, origin, publicOrigin, authContext, true);
        return await handleImageProviderResult(candidate, result, origin, authContext);
    } catch (error) {
        if (error instanceof ImageUpstreamTerminalError) return { state: "failed", error: error.message || "图片生成失败", status: "failed", retryReason: "upstream_failed" };
        if (!(error instanceof GenerationSubmissionSafeFailure)) throw generationSubmissionUncertainError(error, "图片任务创建结果未知");
        attempts = finishGenerationAttempt(attempts, candidate.attemptNo, { status: "failed", error: error.message });
        await refundImageCandidate(candidate);
        await updateImageTask(task.id, { attempts, attemptNo: candidate.attemptNo, upstream: undefined, billing: undefined });
        return { state: "failed", error: error.message, status: "failed" };
    }
}

export async function queryImageTaskUpstreamStep(task: ImageTask, origin: string, cookie = "", workerUserId = ""): Promise<ImageUpstreamStep> {
    if (hasImageResultCheckpoint(task)) return readyImageStep(task, IMAGE_CHECKPOINT_RESULT_URL);
    const prepared = persistedImageTaskResults(task);
    if (prepared.length) return readyImageStep(task, prepared[0].serverUrl || prepared[0].dataUrl);
    const upstream = task.upstream;
    if (!upstream?.id) return { state: "failed", error: "图片任务缺少上游任务 ID", status: "missing_upstream_id" };
    const authContext = cookie || maintenanceWorkerContext(workerUserId || task.userId);
    try {
        const result = usesDeclarativeImageProtocol(task.config.advancedConfig?.protocol)
            ? await pollCustomImageTask(task, upstream.id, upstream.mediaBaseUrl, upstream.pollBaseUrl, authContext, true)
            : await pollOpenAiImageTask(task.config, upstream.id, upstream.mediaBaseUrl, upstream.pollBaseUrl, authContext, upstream.explicitPollUrl || "", true, task.id);
        return await handleImageProviderResult(task, { ...result, pointsCost: task.billing?.pointsCost, pointsRecordId: task.billing?.pointsRecordId }, origin, authContext);
    } catch (error) {
        if (error instanceof ImageQueryContractError) return { state: "needs_review", reason: error.message, status: "query_contract_invalid" };
        if (error instanceof ImageUpstreamTerminalError) return { state: "failed", error: error.message, status: "failed", retryReason: "upstream_failed" };
        if (error instanceof GenerationSubmissionSafeFailure) return { state: "failed", error: error.message, status: "failed" };
        throw error;
    }
}

export async function prepareImageTaskAutomaticRetry(task: ImageTask, error: string) {
    const current = (await getImageTask(task.id)) || task;
    if (current.status !== "pending" && current.status !== "running") return null;
    const attemptNo = current.attemptNo || current.attempts?.at(-1)?.attemptNo || 1;
    if (attemptNo >= 2) return null;
    const attempts = finishGenerationAttempt(current.attempts || [], attemptNo, {
        status: "failed",
        error,
        pointsCost: current.billing?.pointsCost,
        pointsRecordId: current.billing?.pointsRecordId,
    });
    await refundImageCandidate(current);
    const candidates = await freshGenerationCandidates(current.config, "image", current.candidateConfigs);
    const nextConfig = candidates.find((candidate) => candidate.channelId !== current.config.channelId) || candidates[0] || current.config;
    return updateImageTask(current.id, {
        config: nextConfig,
        candidateConfigs: [],
        attempts,
        attemptNo,
        upstream: undefined,
        billing: undefined,
        retryable: false,
    });
}

export async function queryCancelledImageTaskUpstreamStep(task: ImageTask, origin: string, cookie = "", workerUserId = "") {
    const upstream = task.upstream;
    if (!upstream?.id) return { state: "terminal" as const, status: "missing_upstream_id" };
    const authContext = cookie || maintenanceWorkerContext(workerUserId || task.userId);
    try {
        const result = usesDeclarativeImageProtocol(task.config.advancedConfig?.protocol)
            ? await pollCustomImageTask(task, upstream.id, upstream.mediaBaseUrl, upstream.pollBaseUrl, authContext, true)
            : await pollOpenAiImageTask(task.config, upstream.id, upstream.mediaBaseUrl, upstream.pollBaseUrl, authContext, upstream.explicitPollUrl || "", true, task.id);
        return result.pending ? { state: "pending" as const, status: "processing" } : { state: "terminal" as const, status: "completed" };
    } catch (error) {
        if (error instanceof ImageUpstreamTerminalError || error instanceof GenerationSubmissionSafeFailure) return { state: "terminal" as const, status: "failed" };
        throw error;
    }
}

export async function persistImageTaskResult(task: ImageTask, origin: string, resultUrl: string, cookie = "", workerUserId = "") {
    const authContext = cookie || maintenanceWorkerContext(workerUserId || task.userId);
    const current = await getImageTask(task.id);
    if (!current) return null;
    if (current.status === "cancelled") return current;
    if (current.resultCheckpoint?.finalizedAt && current.status === "success") return current;
    if (current.resultCheckpoint) {
        let results: StoredImageTaskMediaResult[];
        try {
            results = await prepareImageTaskResults(current, { dataUrl: "" }, origin, authContext);
        } catch (error) {
            if (error instanceof ImageOutputValidationError) return markImageTaskFailed(current, error.message);
            throw error;
        }
        return completeImageResult((await getImageTask(task.id)) || current, results);
    }
    let results = persistedImageTaskResults(current);
    if (results.length) return completeImageResult(current, results);

    const inlineDataUrl = resultUrl === "inline://image-task-result" ? current.result?.dataUrl || "" : resultUrl;
    const remoteUrl = resultUrl === "inline://image-task-result" ? current.result?.remoteUrl : /^https?:\/\//i.test(resultUrl) ? resultUrl : undefined;
    if (!inlineDataUrl && !remoteUrl) throw new GenerationSubmissionSafeFailure("图片任务缺少可持久化结果");
    const legacyResults = current.result?.results?.length ? current.result.results : [{ dataUrl: inlineDataUrl, remoteUrl }];
    const normalizedResults = legacyResults.map((item, index) => (index === 0 ? { ...item, dataUrl: inlineDataUrl || item.dataUrl, remoteUrl: remoteUrl || item.remoteUrl } : item));
    try {
        results = await imageResultStage(current, "image_process", () => prepareImageTaskResults(current, { ...normalizedResults[0], results: normalizedResults }, origin, authContext));
    } catch (error) {
        if (error instanceof ImageOutputValidationError) return markImageTaskFailed(current, error.message);
        throw error;
    }
    await imageResultStage(current, "task_update", () => updateImageTask(current.id, { result: { ...results[0], results } }));
    return completeImageResult(current, results);
}

export async function markImageTaskFailed(task: ImageTask, error: string, failureOrigin: "upstream" | "local" = "upstream") {
    const current = (await getImageTask(task.id)) || task;
    if (current.status === "success" || current.status === "cancelled") return current;
    const attempts = finishGenerationAttempt(current.attempts || [], current.attemptNo || current.attempts?.at(-1)?.attemptNo || 1, {
        status: "failed",
        error,
        failureOrigin,
        pointsCost: current.billing?.pointsCost,
        pointsRecordId: current.billing?.pointsRecordId,
    });
    const failed = await transitionImageTask(current, ["pending", "running"], { status: "error", error: error.slice(0, 500), retryable: true, billing: current.billing });
    if (!failed) {
        const latest = await getImageTask(current.id);
        if (latest?.status === "error" || latest?.status === "cancelled") return refundImageTask(latest);
        return latest;
    }
    await updateImageTask(current.id, { attempts, candidateConfigs: [], attemptNo: attempts.at(-1)?.attemptNo });
    const refunded = await refundImageTask(failed);
    await writeImageGenerationLog({ ...refunded, retryable: true }, "failed", "", Date.now() - current.createdAt, error).catch((logError) => console.error("Image generation failure log write failed", logError));
    return refunded;
}

async function handleImageProviderResult(task: ImageTask, result: ImageTaskRunResult, origin: string, authContext: string): Promise<ImageUpstreamStep> {
    const billing = result.pointsRecordId ? { pointsCost: result.pointsCost ?? 0, pointsRecordId: result.pointsRecordId, refunded: false } : undefined;
    if (billing) await updateImageTask(task.id, { billing });
    if (result.needsReview) {
        const submittedAt = Date.now();
        await updateImageTask(task.id, { upstream: result.needsReview.upstream, billing });
        await scheduleGenerationTask("image", task.id, {
            executionPhase: "needs_review",
            upstreamTaskId: result.needsReview.upstream.id,
            channelId: task.config.channelId,
            provider: task.config.advancedConfig?.protocol || task.config.apiFormat,
            queryPath: result.needsReview.upstream.explicitPollUrl || task.config.advancedConfig?.queryPath,
            submittedAt,
            nextPollAt: undefined,
            lastUpstreamStatus: "query_contract_missing",
            resultPayload: { reviewReason: result.needsReview.reason.slice(0, 500) },
        });
        return { state: "needs_review", reason: result.needsReview.reason, status: "query_contract_missing" };
    }
    if (result.pending) {
        const submittedAt = Date.now();
        await updateImageTask(task.id, { upstream: result.pending, billing });
        await scheduleGenerationTask("image", task.id, {
            executionPhase: "submitted",
            upstreamTaskId: result.pending.id,
            channelId: task.config.channelId,
            provider: task.config.advancedConfig?.protocol || task.config.apiFormat,
            queryPath: result.pending.explicitPollUrl || task.config.advancedConfig?.queryPath,
            submittedAt,
            nextPollAt: submittedAt,
            lastUpstreamStatus: "submitted",
        });
        return { state: "pending", upstream: result.pending, status: "submitted" };
    }
    const latest = (await getImageTask(task.id)) || task;
    if (latest.status === "cancelled") return { state: "failed", error: "任务已取消", status: "cancelled" };
    const attempts = finishGenerationAttempt(latest.attempts || [], latest.attemptNo || 1, { status: "succeeded", supplierRequestId: result.supplierRequestId, pointsCost: billing?.pointsCost, pointsRecordId: billing?.pointsRecordId });
    try {
        await updateImageTask(task.id, { attempts });
        await captureImageResultCheckpoint({ ...latest, attempts }, result, "upstream", result.supplierRequestId);
    } catch (error) {
        return { state: "needs_review", reason: "上游已返回产物，本地保存尚未完成，请检查状态继续保存", status: "local_result_error" };
    }
    return readyImageStep(task, IMAGE_CHECKPOINT_RESULT_URL);
}

async function readyImageStep(task: ImageTask, resultUrl: string): Promise<ImageUpstreamStep> {
    if (!stableMediaUrl(resultUrl)) return { state: "failed", error: "上游返回的图片文件无效或保存失败", status: "failed" };
    await persistReadyImageSchedule(task, resultUrl);
    return { state: "result_ready", resultUrl, status: "completed" };
}

function persistReadyImageSchedule(task: ImageTask, resultUrl: string) {
    const submittedAt = Date.now();
    return scheduleGenerationTask("image", task.id, {
        executionPhase: "result_ready",
        channelId: task.config.channelId,
        provider: task.config.advancedConfig?.protocol || task.config.apiFormat,
        submittedAt,
        nextPollAt: submittedAt,
        lastUpstreamStatus: "completed",
        resultPayload: { url: resultUrl },
    });
}

async function refundImageCandidate(task: ImageTask) {
    const current = await getImageTask(task.id);
    const billing = current?.billing;
    if (!billing?.pointsRecordId || billing.refunded) return;
    const settings = await getAuthSettings();
    await refundUserPoints(
        task.userId,
        generationModelId(task.config),
        billing.pointsCost,
        "image",
        imageUnits(task.config.quality, settings.generationPointMultipliers.imageQuality),
        `image-task:${task.id}:attempt:${task.attemptNo || 1}:refund`,
        billing.pointsRecordId,
    );
}

async function completeImageResult(task: ImageTask, safeResults: StoredImageTaskMediaResult[]) {
    const beforePersistence = await getImageTask(task.id);
    if (!beforePersistence || beforePersistence.status === "cancelled") {
        if (beforePersistence?.status === "cancelled") await refundImageTask(beforePersistence);
        return beforePersistence;
    }
    task = beforePersistence;
    const current = await getImageTask(task.id);
    if (!current || current.status === "cancelled") {
        if (current?.status === "cancelled") await refundImageTask(current);
        return current;
    }
    const completed = { ...current, result: { ...safeResults[0], results: safeResults } };
    const logged = await imageResultStage(current, "task_update", () => writeImageGenerationLog(completed, "success", safeResults, Date.now() - completed.createdAt));
    const loggedAssets = logged?.assets?.length ? logged.assets : logged?.asset ? [logged.asset] : [];
    const finalResults = loggedAssets.length
        ? loggedAssets.map((asset) => ({ dataUrl: asset.serverUrl || asset.url, remoteUrl: asset.remoteUrl, serverUrl: asset.serverUrl, width: asset.width, height: asset.height, bytes: asset.bytes, mimeType: asset.mimeType }))
        : safeResults;
    const finalResult = finalResults[0];
    const attempts =
        completed.resultCheckpoint?.source === "admin"
            ? completed.attempts || []
            : finishGenerationAttempt(completed.attempts || [], completed.attemptNo || completed.attempts?.at(-1)?.attemptNo || 1, {
                  status: "succeeded",
                  pointsCost: completed.billing?.pointsCost,
                  pointsRecordId: completed.billing?.pointsRecordId,
              });
    const assets = finalResults.flatMap((item) => {
        const url = item.serverUrl || item.remoteUrl || stableMediaUrl(item.dataUrl);
        return url ? [{ type: "image" as const, url, mimeType: item.mimeType, width: item.width, height: item.height, bytes: item.bytes }] : [];
    });
    if (assets.length)
        await imageResultStage(current, "asset_register", () =>
            registerGenerationTaskAssetsForUser(completed.userId, {
                ...completed,
                taskId: completed.id,
                title: completed.title || completed.prompt.slice(0, 80),
                assets,
            }),
        );
    const recoveryEvents = [...(current.recoveryEvents || [])];
    if (current.resultCheckpoint?.source === "admin" || current.diagnostics?.length) await imageResultStage(current, "task_update", () => reconcileRecoveredImageRun({ ...completed, result: { ...finalResult, results: finalResults } }));
    if (current.resultCheckpoint && (current.resultCheckpoint.source === "admin" || current.diagnostics?.length))
        recoveryEvents.push({
            recoveredAt: Date.now(),
            attemptNo: current.resultCheckpoint.attemptNo,
            supplierRequestId: current.resultCheckpoint.supplierRequestId,
            source: current.resultCheckpoint.source === "admin" ? "admin" : "checkpoint",
            previousError: current.error || current.diagnostics?.at(-1)?.message,
        });
    const finalized = await imageResultStage(current, "task_update", () =>
        transitionImageTask(current, ["pending", "running"], {
            status: "success",
            result: { ...finalResult, results: finalResults },
            error: undefined,
            retryable: false,
            attempts,
            config: { ...completed.config, apiKey: "system" },
            ...(current.resultCheckpoint ? { resultCheckpoint: { ...current.resultCheckpoint, finalizedAt: Date.now() } } : {}),
            recoveryEvents,
        }),
    );
    if (finalized) await updateImageTask(task.id, { candidateConfigs: [] });
    return finalized || getImageTask(task.id);
}

function usesDeclarativeImageProtocol(protocol: NonNullable<ImageTask["config"]["advancedConfig"]>["protocol"] | undefined) {
    return protocol === "custom" || protocol === "stable-diffusion" || protocol === "yumeng";
}
