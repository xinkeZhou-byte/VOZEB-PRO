import type { AdminGenerationOperationsPayload } from "@/lib/admin-generation-operations";

export function generationChangesEventUrl(records: string[]) {
    const query = new URLSearchParams();
    for (const record of records) query.append("record", record);
    return `/api/admin/generation-operations/events?${query}`;
}

export async function getGenerationOperations(query: URLSearchParams) {
    const response = await fetch(`/api/admin/generation-operations?${query}`, { cache: "no-store" });
    const payload = (await response.json()) as { data?: AdminGenerationOperationsPayload; msg?: string };
    if (!response.ok || !payload.data) throw new Error(payload.msg || "任务数据加载失败");
    return payload.data;
}
