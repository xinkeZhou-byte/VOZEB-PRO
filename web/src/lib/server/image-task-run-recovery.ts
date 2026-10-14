import { registerAgentTaskAssets } from "./agent-run-assets";
import { getAgentRun, reconcileAgentRunResult, type AgentRunChildTask } from "./agent-run-store";
import { listStoredGenerationTaskRecordsByRunIds } from "./generation-task-store";
import type { ImageTask } from "./image-task-store";

// Restore an existing round only. No planner, dispatcher, billing or new messages.
export async function reconcileRecoveredImageRun(task: ImageTask) {
    if (!task.runId || !task.parentTaskId || !task.result) return;
    const run = await getAgentRun(task.runId);
    if (!run || run.userId !== task.userId || run.conversationId !== task.conversationId || run.status === "cancelled" || run.status === "running" || run.status === "planning") return;
    const parent = run.tasks.find((item) => item.type === "image" && (item.id === task.parentTaskId || item.taskId === task.id || item.taskIds?.includes(task.id) || item.childTasks?.some((child) => child.id === task.id)));
    if (!parent || parent.status === "cancelled") return;
    const records = await listStoredGenerationTaskRecordsByRunIds([run.id], [task.userId]);
    const activeTaskIds = new Set(parent.childTasks?.map((child) => child.id) || (parent.taskId ? [parent.taskId] : []));
    const recovered = records
        .filter((item) => item.type === "image" && (item.parentTaskId === parent.id || activeTaskIds.has(item.id) || item.id === task.id) && (item.status === "success" || item.id === task.id))
        .sort((left, right) => Number(activeTaskIds.has(right.id)) - Number(activeTaskIds.has(left.id)) || (right.attemptNo || 1) - (left.attemptNo || 1))
        .map((item) => ({ id: item.id, attempt: parent.childTasks?.find((child) => child.id === item.id)?.attempt || item.attemptNo || 1, result: item.id === task.id ? task.result : (item.payload as ImageTask).result }))
        .filter((item) => Boolean(item.result));
    const assets = await Promise.all(recovered.map((item) => registerAgentTaskAssets(run, parent, item.result, [item.id])));
    const assetsByTask = new Map(recovered.map((output, index) => [output.id, assets[index].map((asset) => asset.id)]));
    return reconcileAgentRunResult(
        run.id,
        (current) => {
            if (current.userId !== task.userId || current.conversationId !== task.conversationId) return null;
            const tasks = current.tasks.map((item) => {
                if (item.id !== parent.id || item.status === "cancelled") return item;
                const children = new Map((item.childTasks || []).map((child) => [child.id, child]));
                for (const output of recovered) children.set(output.id, { ...children.get(output.id), id: output.id, status: "completed", attempt: output.attempt, result: output.result, assetIds: assetsByTask.get(output.id) } as AgentRunChildTask);
                const activeIds = item.childTasks?.length ? item.childTasks.map((child) => child.id) : item.taskId ? [item.taskId] : [];
                const active = activeIds.map((id) => children.get(id));
                const complete = active.length > 0 && active.every((child) => child?.status === "completed");
                const ordered = [
                    ...active.filter((child): child is AgentRunChildTask => Boolean(child?.result)).sort((left, right) => right.attempt - left.attempt),
                    ...Array.from(children.values()).filter((child) => !activeIds.includes(child.id) && child.result),
                ];
                const results = ordered.flatMap((child) => {
                    const result = child.result as NonNullable<ImageTask["result"]>;
                    return result.results?.length ? result.results : [result];
                });
                return {
                    ...item,
                    childTasks: Array.from(children.values()),
                    taskIds: Array.from(new Set([...(item.taskIds || []), ...recovered.map((output) => output.id)])),
                    assetIds: Array.from(new Set([...ordered.flatMap((child) => child.assetIds || []), ...(item.assetIds || [])])),
                    ...(results.length ? { result: { ...results[0], results } } : {}),
                    ...(complete ? { status: "completed" as const, error: undefined } : {}),
                };
            });
            const completed = tasks.every((item) => item.status === "completed");
            return {
                ...current,
                tasks,
                assetIds: Array.from(new Set([...tasks.flatMap((item) => item.assetIds || []), ...current.assetIds])),
                ...(completed ? { status: "completed" as const, executionId: undefined, failure: undefined, failureStage: undefined } : {}),
            };
        },
        { recoveredTaskId: task.id },
    );
}
