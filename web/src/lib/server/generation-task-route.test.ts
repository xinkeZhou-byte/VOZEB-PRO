import { beforeEach, describe, expect, it, vi } from "vitest";
import { encryptSecretValue } from "./secret-crypto";
import { systemAiTaskHeaders } from "./system-ai-billing";
const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("./generation-task-store", () => ({ getStoredGenerationTaskRecord: mocks.get }));
import { readSubmittedGenerationRoute } from "./generation-task-route";

describe("submitted task transport ownership", () => {
    const headers = new Headers(systemAiTaskHeaders("image", "local-task"));
    const channel = { id: "A", baseUrl: "https://original.test", apiKey: "original-secret", apiFormat: "openai", models: ["vendor"], name: "Original", enabled: true };
    beforeEach(() => {
        mocks.get.mockResolvedValue({
            id: "local-task",
            type: "image",
            userId: "owner",
            channelId: "A",
            status: "running",
            upstreamTaskId: "original-upstream",
            executionPhase: "polling",
            payload: { config: { model: "vendor", logicalModel: "logical", upstreamRouteCiphertext: encryptSecretValue(JSON.stringify(channel)) } },
        });
    });
    it("reads only the original transport and creates a disabled binding so it cannot authorize creation", async () => {
        const route = await readSubmittedGenerationRoute(headers, "owner", "A", "models/VENDOR");
        expect(route).toMatchObject({ channel, upstreamTaskId: "original-upstream", logicalModel: { id: "logical", enabled: false, bindings: [{ enabled: false }] } });
        expect(mocks.get).toHaveBeenCalledWith("image", "local-task");
    });
    it("rejects another owner, model, channel, missing identity, or completed cancellation", async () => {
        expect(await readSubmittedGenerationRoute(headers, "other", "A", "vendor")).toBeNull();
        expect(await readSubmittedGenerationRoute(headers, "owner", "B", "vendor")).toBeNull();
        expect(await readSubmittedGenerationRoute(headers, "owner", "A", "forged-model")).toBeNull();
        mocks.get.mockResolvedValueOnce(null);
        expect(await readSubmittedGenerationRoute(headers, "owner", "A", "vendor")).toBeNull();
        const cancelled = await mocks.get();
        mocks.get.mockResolvedValueOnce({ ...cancelled, status: "cancelled", executionPhase: "completed" });
        expect(await readSubmittedGenerationRoute(headers, "owner", "A", "vendor")).toBeNull();
        expect(await readSubmittedGenerationRoute(new Headers(), "owner", "A", "vendor")).toBeUndefined();
    });
});
