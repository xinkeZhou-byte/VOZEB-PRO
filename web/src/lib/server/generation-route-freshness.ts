import { getFreshAuthSettings, type LogicalModelCapability } from "@/lib/auth/store";
import { generationModelId, toSystemGenerationChannel, type SystemGenerationChannelConfig } from "./generation-channel";
import { resolveLogicalModelCandidates } from "./logical-model-router";

type GenerationConfig = Pick<SystemGenerationChannelConfig, "baseUrl" | "model" | "channelId" | "logicalModel"> & { apiSource?: "system" | "custom"; apiKey: string };

export async function freshGenerationCandidates<T extends GenerationConfig>(config: T, capability: LogicalModelCapability, fallback: T[] = []): Promise<T[]> {
    if (config.apiSource !== "system") return [config, ...fallback];
    const settings = await getFreshAuthSettings();
    const candidates = resolveLogicalModelCandidates(settings, capability, generationModelId(config));
    return candidates.map((candidate) => ({ ...config, ...toSystemGenerationChannel(candidate) }));
}

export function generationRouteIdentity(config: { channelId?: string; baseUrl: string; model: string }) {
    return JSON.stringify([config.channelId || config.baseUrl, config.model]);
}
