export function resolveImageTaskOptions(config: { quality?: unknown; resolution?: unknown; size?: unknown; outputBackground?: unknown; outputMode?: unknown }, defaults: { imageQuality: string; imageSize: string }) {
    const resolution = text(config.resolution);
    if (resolution && !/^(?:auto|1k|2k|4k)$/i.test(resolution)) throw new Error("图片分辨率必须为智能、1K、2K 或 4K");
    return {
        quality: text(config.quality) || defaults.imageQuality,
        ...(resolution ? { resolution: resolution.toLowerCase() === "auto" ? "auto" : resolution.toUpperCase() } : {}),
        size: text(config.size) || defaults.imageSize,
        ...(config.outputBackground === "transparent" ? { outputBackground: "transparent" as const } : {}),
        ...(config.outputMode === "layers" ? { outputMode: "layers" as const } : {}),
    };
}

export function resolveImageGenerationCount(value: unknown) {
    const count = Number(value);
    return Math.max(1, Number.isSafeInteger(count) && count > 0 ? Math.floor(count) : 1);
}

function text(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}
