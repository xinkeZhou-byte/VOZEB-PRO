import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { readJsonBody } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { getPublicUsersByIds } from "@/lib/auth/store";
import { deleteGenerationLogs, listGenerationLogs } from "@/lib/server/generation-log-store";
import { hasAdminPermission } from "@/lib/admin-permissions";
import { getStoredGenerationTaskRecordsByIds, listStoredGenerationTaskRecordsByRunIds, listStoredGenerationTaskRecordsByLogIds } from "@/lib/server/generation-task-store";
import { generationTaskCallAudits } from "@/lib/server/generation-call-audit-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    if (!hasAdminPermission(currentUser, "generation.read")) return NextResponse.json({ error: "当前管理员没有查看生成记录的职责权限" }, { status: 403 });

    const params = request.nextUrl.searchParams;
    const result = await listGenerationLogs({
        page: Number(params.get("page")) || 1,
        pageSize: Number(params.get("pageSize")) || 20,
        keyword: params.get("keyword") || "",
        kind: params.get("kind") || "",
        source: params.get("source") || "",
        status: params.get("status") || "",
        userId: params.get("userId") || "",
        start: params.get("start") || "",
        end: params.get("end") || "",
    });

    const users = await getPublicUsersByIds(result.items.map((item) => item.userId));
    const accountIdByUserId = new Map(users.map((user) => [user.id, user.accountId]));
    const taskIds = result.items.flatMap((log) => [log.taskId || "", ...(log.requestSnapshot?.slots.map((slot) => slot.serverTaskId || slot.taskId || "") || []), ...(log.requestSnapshot?.callAudit?.map((call) => call.taskId) || [])]);
    const [linkedTasks, pendingTasks] = await Promise.all([getStoredGenerationTaskRecordsByIds(taskIds), listStoredGenerationTaskRecordsByLogIds(result.items.map((log) => log.id))]);
    const tasks = [...new Map([...linkedTasks, ...pendingTasks].map((task) => [task.id, task])).values()];
    const runIds = [...new Set(tasks.flatMap((task) => (task.runId ? [task.runId] : [])))];
    const planners = await getStoredGenerationTaskRecordsByIds(runIds);
    const childTasks = await listStoredGenerationTaskRecordsByRunIds(runIds);
    const logs = result.items.map((item) => {
        const calls = new Map((item.requestSnapshot?.callAudit || []).map((call) => [call.taskId, call]));
        const ownTasks = tasks.filter(
            (task) => task.userId === item.userId && (task.id === item.taskId || task.payload.generationLogId === item.id || item.requestSnapshot?.slots.some((slot) => (slot.serverTaskId || slot.taskId) === task.id) || calls.has(task.id)),
        );
        const relatedRunIds = new Set(ownTasks.map((task) => task.runId));
        for (const task of [...ownTasks, ...planners.filter((task) => relatedRunIds.has(task.id)), ...childTasks.filter((task) => relatedRunIds.has(task.runId))]) for (const call of generationTaskCallAudits(task)) calls.set(call.taskId, call);
        return { ...item, accountId: accountIdByUserId.get(item.userId), requestSnapshot: { version: 1 as const, parameters: {}, references: [], slots: [], ...item.requestSnapshot, callAudit: [...calls.values()] } };
    });
    return NextResponse.json({ logs, total: result.total, page: result.page, pageSize: result.pageSize });
}

export async function DELETE(request: Request) {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    if (!hasAdminPermission(currentUser, "generation.manage")) return NextResponse.json({ error: "当前管理员没有管理生成记录的职责权限" }, { status: 403 });

    const body = await readJsonBody<{ ids?: unknown }>(request);
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    const result = await deleteGenerationLogs(ids);
    return NextResponse.json(result);
}
