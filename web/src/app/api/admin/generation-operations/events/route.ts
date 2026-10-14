import { NextResponse } from "next/server";
import { hasAdminPermission } from "@/lib/admin-permissions";
import { getCurrentUser } from "@/lib/auth/session";
import { subscribeGenerationTaskChanges } from "@/lib/server/generation-task-event-signal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 2400;

export async function GET(request: Request) {
    const user = await getCurrentUser(request);
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    if (!hasAdminPermission(user, "generation.read")) return NextResponse.json({ code: 403, data: null, msg: "没有查看生成任务的职责权限" }, { status: 403 });
    const ids = new URL(request.url).searchParams.getAll("record");
    if (!ids.length || ids.length > 100 || ids.some((id) => !/^(?:log|text|image|video|audio|agent|render):[^\r\n]{1,200}$/.test(id))) return NextResponse.json({ code: 400, data: null, msg: "请订阅当前可见记录" }, { status: 400 });
    const keys = new Set(ids);
    const encoder = new TextEncoder();
    let dispose = () => {};
    const body = new ReadableStream({
        start(controller) {
            let closed = false;
            let unsubscribe: (() => void) | undefined;
            const close = () => {
                if (closed) return;
                closed = true;
                unsubscribe?.();
                request.signal.removeEventListener("abort", close);
                try {
                    controller.close();
                } catch {
                    /* Client disconnected. */
                }
            };
            const emit = async () => {
                const current = await getCurrentUser(request);
                if (!current || !hasAdminPermission(current, "generation.read")) {
                    close();
                    return;
                }
                if (!closed) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ code: 0, data: { changed: true }, msg: "" })}\n\n`));
            };
            dispose = close;
            request.signal.addEventListener("abort", close, { once: true });
            if (request.signal.aborted) {
                close();
                return;
            }
            void subscribeGenerationTaskChanges(keys, () => {
                void emit().catch(close);
            })
                .then(async (release) => {
                    if (closed) {
                        release();
                        return;
                    }
                    unsubscribe = release;
                    await emit();
                })
                .catch(close);
        },
        cancel() {
            dispose();
        },
    });
    return new Response(body, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "private, no-cache, no-transform", "X-Accel-Buffering": "no", Connection: "keep-alive" } });
}
