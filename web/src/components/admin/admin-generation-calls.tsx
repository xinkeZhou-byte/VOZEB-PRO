"use client";

import type { GenerationCallAudit } from "@/lib/generation-call-audit";

export function AdminGenerationCalls({ calls }: { calls?: GenerationCallAudit[] }) {
    if (!calls?.length) return <div className="text-xs text-[var(--muted-foreground)]">调用渠道未记录</div>;
    return (
        <div className="min-w-0 space-y-3" aria-label="实际调用渠道">
            {calls.map((call) => (
                <section key={`${call.role}:${call.taskId}`} className="min-w-0 rounded-lg border border-[var(--border)] p-3 text-xs">
                    <div className="mb-2 font-medium">{call.role === "planning" ? "Agent 规划模型" : `${{ text: "文本", image: "图片", video: "视频", audio: "音频" }[call.capability]}生成子任务`}</div>
                    <div className="break-all text-[var(--muted-foreground)]">任务 {call.taskId}</div>
                    {(call.attempts.length ? call.attempts : [{ attemptNo: 0, status: "running" as const, startedAt: call.channelSnapshot?.capturedAt || 0, model: "", channelSnapshot: call.channelSnapshot }]).map((attempt) => {
                        const snapshot = attempt.channelSnapshot;
                        return (
                            <div key={attempt.attemptNo} className="mt-3 grid min-w-0 gap-x-4 gap-y-1 break-all sm:grid-cols-2">
                                <div>逻辑模型：{snapshot?.logicalModelId || "未记录"}</div>
                                <div>实际上游模型：{snapshot?.upstreamModel || "未记录"}</div>
                                <div>渠道名称：{snapshot?.channelName || "未记录"}</div>
                                <div>渠道 ID：{snapshot?.channelId || ("channelId" in attempt ? attempt.channelId : undefined) || "未记录"}</div>
                                <div>调用时间：{attempt.startedAt ? new Date(attempt.startedAt).toLocaleString("zh-CN", { hour12: false }) : "未记录"}</div>
                                <div>
                                    第 {attempt.attemptNo || "—"} 次 · {{ running: "调用中", succeeded: "上游成功", failed: "调用失败" }[attempt.status]}
                                </div>
                                {"error" in attempt && attempt.error ? <div className="sm:col-span-2">失败原因：{attempt.error}</div> : null}
                                {"supplierRequestId" in attempt && attempt.supplierRequestId ? <div className="sm:col-span-2">供应商请求 ID：{attempt.supplierRequestId}</div> : null}
                            </div>
                        );
                    })}
                    {call.diagnostics?.map((entry, index) => (
                        <details key={`${entry.occurredAt}:${index}`} className="mt-2 min-w-0">
                            <summary className="cursor-pointer break-words rounded p-1 focus-visible:outline-2">
                                本地处理：{entry.stage} · {entry.message}
                            </summary>
                            <pre className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap break-all rounded bg-[var(--muted)] p-2">{entry.stack || "未记录堆栈"}</pre>
                        </details>
                    ))}
                    {call.recoveryEvents?.map((event, index) => (
                        <div key={`${event.recoveredAt}:${index}`} className="mt-2 break-all text-[var(--muted-foreground)]">
                            已恢复：{new Date(event.recoveredAt).toLocaleString("zh-CN", { hour12: false })} · {event.source === "admin" ? "管理员补录" : "结果检查点"}
                            {event.supplierRequestId ? ` · 供应商请求 ${event.supplierRequestId}` : ""}
                            {event.previousError ? ` · 原错误：${event.previousError}` : ""}
                        </div>
                    ))}
                </section>
            ))}
        </div>
    );
}
