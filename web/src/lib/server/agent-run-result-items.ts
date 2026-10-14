const RESULT_LIST_KEYS = ["results", "images", "videos", "outputs", "items", "assets"] as const;
const RESULT_WRAPPER_KEYS = ["data", "result", "output", "task"] as const;

export function agentTaskResultItems(value: unknown) {
    const root = resultRecord(value);
    if (!root) return [{}];
    const items: Record<string, unknown>[] = [];

    const pending = [root];
    const visited = new WeakSet<object>();
    while (pending.length) {
        const record = pending.pop()!;
        if (visited.has(record)) continue;
        visited.add(record);
        const nested = RESULT_LIST_KEYS.map((key) => record[key]).find(Array.isArray);
        const records = Array.isArray(nested) ? nested.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
        if (records.length) {
            for (let index = records.length - 1; index >= 0; index -= 1) pending.push(records[index]);
            continue;
        }
        const wrapper = RESULT_WRAPPER_KEYS.map((key) => resultRecord(record[key])).find((item): item is Record<string, unknown> => Boolean(item));
        if (wrapper) {
            pending.push(wrapper);
            continue;
        }
        items.push(record);
    }
    return items.length ? items : [root];
}

function resultRecord(value: unknown) {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
