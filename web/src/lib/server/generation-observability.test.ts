import { beforeEach, describe, expect, it, vi } from "vitest";
import { generationTaskCallAudits, normalizeGenerationCallAudits } from "./generation-call-audit-service";
import { publicGenerationLog } from "./public-generation-log";
import { sanitizeGenerationDiagnostic } from "./generation-diagnostics";
import type { StoredGenerationTaskRecord } from "./generation-task-store";
import type { StoredGenerationLog } from "./generation-log-types";

const mocks = vi.hoisted(() => ({
    user: { role: "admin", status: "active", adminPermissions: ["generation.read"] } as { role: string; status: string; adminPermissions: string[] } | null,
    changed: undefined as (() => void) | undefined,
    release: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: async () => mocks.user }));
vi.mock("./generation-task-event-signal", () => ({
    subscribeGenerationTaskChanges: async (_keys: Set<string>, changed: () => void) => {
        mocks.changed = changed;
        return mocks.release;
    },
}));
import { GET } from "@/app/api/admin/generation-operations/events/route";

describe("private generation channel observability", () => {
    const snapshot = { logicalModelId: "image", upstreamModel: "vendor-image", channelId: "historic-channel", channelName: "Original name", capturedAt: 100 };
    it("preserves each attempt snapshot and never attributes an unsubmitted configuration as a call", () => {
        const record = { id: "image-one", type: "image", payload: { config: { channelSnapshot: snapshot }, attempts: [] } } as unknown as StoredGenerationTaskRecord;
        expect(generationTaskCallAudits(record)[0].channelSnapshot).toBeUndefined();
        record.payload.attempts = [
            { attemptNo: 1, model: "image", channelSnapshot: snapshot, startedAt: 100, completedAt: 200, status: "failed", error: "upstream failed" },
            { attemptNo: 2, model: "image", channelSnapshot: { ...snapshot, channelId: "replacement", channelName: "Replacement", capturedAt: 300 }, startedAt: 300, status: "running" },
        ];
        const audit = generationTaskCallAudits(record)[0];
        expect(audit.attempts.map((attempt) => attempt.channelSnapshot?.channelName)).toEqual(["Original name", "Replacement"]);
        expect(normalizeGenerationCallAudits([{ taskId: "legacy", capability: "image", attempts: [{ model: "image", channelId: "historic-channel" }] }])[0].attempts[0].channelSnapshot).toBeUndefined();
    });
    it("records unsuccessful planner candidates separately from media tasks", () => {
        const record = {
            id: "agent-one",
            type: "agent",
            payload: { plannerAudit: { mode: "model", attempts: [{ attemptNo: 1, model: "planner", channelSnapshot: { ...snapshot, logicalModelId: "planner" }, status: "failed", error: "timeout", startedAt: 100 }] } },
        } as unknown as StoredGenerationTaskRecord;
        expect(generationTaskCallAudits(record)).toMatchObject([{ role: "planning", capability: "text", attempts: [{ status: "failed", startedAt: 100, channelSnapshot: { channelName: "Original name" } }] }]);
    });
    it("removes private audit from public logs and sanitizes stack credentials and media", () => {
        const log = {
            id: "log",
            model: "image",
            assets: [],
            requestSnapshot: { version: 1, parameters: {}, references: [], slots: [], callAudit: [{ taskId: "image-one", role: "generation", capability: "image", channelSnapshot: snapshot, attempts: [] }] },
        } as unknown as StoredGenerationLog;
        expect(JSON.stringify(publicGenerationLog(log))).not.toMatch(/callAudit|Original name|historic-channel/);
        const sanitized = sanitizeGenerationDiagnostic("apiKey=fixture-secret Bearer auth-secret https://supplier.test/output?token=unsafe data:image/png;base64,unsafe", ["fixture-secret"]);
        expect(sanitized).not.toMatch(/fixture-secret|auth-secret|supplier\.test|base64|unsafe/);
    });
});

describe("generation changes SSE authorization and reconnect", () => {
    beforeEach(() => {
        mocks.user = { role: "admin", status: "active", adminPermissions: ["generation.read"] };
        mocks.changed = undefined;
        mocks.release.mockClear();
    });
    it("requires generation.read and rejects unbounded or invalid subscriptions", async () => {
        const url = "http://local/api/admin/generation-operations/events?record=image:one";
        mocks.user = null;
        expect((await GET(new Request(url))).status).toBe(401);
        mocks.user = { role: "admin", status: "active", adminPermissions: ["users.read"] };
        expect((await GET(new Request(url))).status).toBe(403);
        mocks.user.adminPermissions = ["generation.read"];
        expect((await GET(new Request("http://local/api/admin/generation-operations/events"))).status).toBe(400);
        expect((await GET(new Request(`${url}&record=unsupported:one`))).status).toBe(400);
    });
    it("sends a snapshot signal on each connection, releases subscriptions, and closes after permission revocation", async () => {
        const request = () => new Request("http://local/api/admin/generation-operations/events?record=image:one");
        const initial = await GET(request());
        const reader = initial.body!.getReader();
        expect(new TextDecoder().decode((await reader.read()).value)).toContain('"changed":true');
        await reader.cancel();
        expect(mocks.release).toHaveBeenCalledTimes(1);
        const reconnect = await GET(request());
        const next = reconnect.body!.getReader();
        expect(new TextDecoder().decode((await next.read()).value)).toContain('"changed":true');
        mocks.user = { role: "admin", status: "active", adminPermissions: [] };
        mocks.changed!();
        expect((await next.read()).done).toBe(true);
        expect(mocks.release).toHaveBeenCalledTimes(2);
    });
});
