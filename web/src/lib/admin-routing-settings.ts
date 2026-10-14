import type { AuthSettings } from "@/lib/auth/store";

export function adminRoutingSettingsSignature(settings: Pick<AuthSettings, "systemChannels" | "logicalModels" | "defaultModels">) {
    return JSON.stringify([settings.systemChannels, settings.logicalModels, settings.defaultModels]);
}
