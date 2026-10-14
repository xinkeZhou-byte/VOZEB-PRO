import type { AuthSettings } from "@/lib/auth/store";

export async function revealAdminChannelApiKey(channelId: string) {
    const response = await fetch(`/api/admin/settings/channels/${encodeURIComponent(channelId)}/api-key`, { method: "POST", cache: "no-store" });
    const payload = (await response.json().catch(() => null)) as { apiKey?: string; error?: string } | null;
    if (!response.ok || !payload?.apiKey) throw new Error(payload?.error || "读取 API Key 失败");
    return payload.apiKey;
}

export async function readAdminSettings() {
    const response = await fetch("/api/admin/settings", { cache: "no-store" });
    const payload = (await response.json()) as { settings?: AuthSettings; error?: string };
    if (!response.ok || !payload.settings) throw new Error(payload.error || "设置读取失败");
    return payload.settings;
}
