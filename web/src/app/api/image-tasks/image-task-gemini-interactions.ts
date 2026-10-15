import type { ImageTask } from "@/lib/server/image-task-store";
import { buildImageReferencePromptText } from "@/lib/image-reference-prompt";
import { GenerationSubmissionSafeFailure, GenerationSubmissionUncertainError } from "@/lib/server/generation-submission-error";
import { dedupeImageResults } from "@/lib/image-result-dedupe";
import {
    imagePointsIdempotencyKey,
    imageReferenceToDataUrl,
    imageRequestAspectRatio,
    imageSubmissionFetch,
    imageSubmissionResponseError,
    normalizeApiBaseUrl,
    parseChargedImageResponse,
    parseImageSubmissionJson,
    readFetchError,
    taskHeaders,
    withImageOutputInstructions,
    withSystemPrompt,
} from "./image-task-support";

type ImageContent = { type: string; data?: string; mime_type?: string };
type InteractionResponse = {
    error?: { message?: string };
    output_image?: ImageContent;
    steps?: Array<{ type: string; content?: ImageContent[] }>;
};

export async function runGeminiInteractionImageTask(task: ImageTask, origin: string, cookie: string) {
    const config = task.config;
    const maskInstruction = task.mask ? "\n\n最后一张图片是编辑蒙版：透明区域需要重新生成，白色不透明区域必须保持原图。不要把蒙版当作画面内容。" : "";
    const prompt = withSystemPrompt(config, withImageOutputInstructions(config, buildImageReferencePromptText(task.prompt, task.references) + maskInstruction));
    const references = task.mask ? [...task.references, task.mask] : task.references;
    const images = await Promise.all(
        references.map(async (reference, index) => {
            const dataUrl = await imageReferenceToDataUrl(reference, reference.name || `reference-${index + 1}.png`, origin, cookie);
            const header = dataUrl.match(/^data:(image\/[^;,]+);base64,/);
            if (!header || dataUrl.length === header[0].length) throw new GenerationSubmissionSafeFailure("Gemini 参考图无法读取为内联图片");
            return { type: "image", mime_type: header[1], data: dataUrl.slice(header[0].length) };
        }),
    );
    const aspectRatio = imageRequestAspectRatio(config.size || "auto");
    const imageSize = config.resolution && config.resolution !== "auto" ? config.resolution : undefined;
    const headers = taskHeaders(config, cookie, imagePointsIdempotencyKey(task));
    headers.set("content-type", "application/json");
    const response = await imageSubmissionFetch(config, `${normalizeApiBaseUrl(config.baseUrl, "gemini", origin)}/interactions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
            model: config.model.replace(/^models\//, ""),
            input: [{ type: "text", text: prompt }, ...images],
            response_format: { type: "image", delivery: "inline", ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}), ...(imageSize ? { image_size: imageSize } : {}) },
        }),
        cache: "no-store",
    });
    if (!response.ok) throw imageSubmissionResponseError(response.status, await readFetchError(response, "Gemini 图片生成失败"));
    const payload = await parseImageSubmissionJson<InteractionResponse>(task, response);
    return parseChargedImageResponse(task, response, async () => {
        if (payload.error?.message) throw new GenerationSubmissionSafeFailure(payload.error.message);
        const blocks = payload.steps?.filter((step) => step.type === "model_output").flatMap((step) => step.content || []) || [];
        if (payload.output_image) blocks.push({ ...payload.output_image, type: "image" });
        const results = dedupeImageResults(
            blocks.filter((block) => block.type === "image" && block.data && (!block.mime_type || block.mime_type.startsWith("image/"))).map((block) => ({ dataUrl: `data:${block.mime_type || "image/png"};base64,${block.data}` })),
        );
        if (!results.length) throw new GenerationSubmissionUncertainError("Gemini Interactions 没有返回图片，创建结果待确认");
        return { ...results[0], results };
    });
}
