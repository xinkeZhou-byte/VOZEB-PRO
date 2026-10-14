import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
import { initializePostgresSchema, createPostgresRepositories, postgresQuery } from "./database";
import { createStoredGenerationTask } from "./generation-task-store";
import { getImageTask, mutateImageTask, transitionImageTask, type ImageTask } from "./image-task-store";
import { captureImageResultCheckpoint, IMAGE_CHECKPOINT_RESULT_URL } from "./image-result-checkpoint";
import { persistImageTaskResult } from "./image-task-runtime";
import { reviewGenerationTask } from "./generation-task-review-service";
import { createCreativeRunBundle, listCreativeMessages, mutateCreativeRun } from "./creative-runtime-store";
import { getAgentRun, type AgentRun } from "./agent-run-store";
import { consumePoints, refundPoints } from "./points-wallet-service";
import { getChannelRuntimeHealth } from "./channel-runtime-health";
import { subscribeGenerationTaskChanges } from "./generation-task-event-signal";
import { GET as readReferenceMedia } from "@/app/api/reference-assets/[...path]/route";
import { GET as readGenerationMedia } from "@/app/api/generation-log-assets/[...path]/route";
import { GET as queryProxy, POST as createProxy } from "@/app/api/ai/system/[channelId]/[...path]/route";
import { getAuthSettings, getFreshAuthSettings, setAuthSettings } from "../auth/store-settings-actions";
import { emptyAdvancedConfig } from "../channel-protocol-registry";
import { toSystemGenerationChannel } from "./generation-channel";
import { resolveLogicalModelCandidates } from "./logical-model-router";
import { createImageTaskUpstreamStep, queryImageTaskUpstreamStep } from "./image-task-runtime";
import { scheduleGenerationTask } from "./generation-task-scheduler";
import { generationTaskCallAudits } from "./generation-call-audit-service";
import { getStoredGenerationTaskRecord } from "./generation-task-store";

type Output = { supplierRequestId: string; taskId: string; runId: string; conversationId: string; agentAttempt: number; points: number; width: number; height: number; path: string };
const drill = process.env.VOZEB_PRO_RUN_RECOVERY_DRILL === "1" ? describe : describe.skip;
drill("isolated PostgreSQL generation result recovery", () => {
    const userId = `recovery-user-${randomUUID()}`;
    const requests = new Map<string, number>();
    const media = new Map<string, Buffer>();
    const unavailable = new Set<string>();
    let origin = "";
    let outputs: Output[];
    const server = createServer(async (request, response) => {
        const path = request.url || "/";
        requests.set(path, (requests.get(path) || 0) + 1);
        if (path.startsWith("/api/ai/system/")) {
            const parts = path.replace("/api/ai/system/", "").split("/");
            const headers = new Headers();
            for (const [key, value] of Object.entries(request.headers)) if (typeof value === "string") headers.set(key, value);
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const body = Buffer.concat(chunks);
            const result = await (request.method === "POST" ? createProxy : queryProxy)(new Request(`${origin}${path}`, { method: request.method, headers, ...(body.length ? { body } : {}) }), {
                params: Promise.resolve({ channelId: parts[0], path: parts.slice(1) }),
            });
            response.writeHead(result.status, Object.fromEntries(result.headers));
            response.end(Buffer.from(await result.arrayBuffer()));
            return;
        }
        if (/^\/[AB]\/v1\/images\/(?:generations|jobs\/original-upstream)$/.test(path)) {
            response.setHeader("content-type", "application/json");
            response.setHeader("x-request-id", `fixture-${path[1]}`);
            response.end(JSON.stringify({ status: "completed", data: [{ url: `${origin}/one.png` }] }));
            return;
        }
        if (path.startsWith("/api/reference-assets/") || path.startsWith("/api/generation-log-assets/")) {
            const headers = new Headers();
            for (const [key, value] of Object.entries(request.headers)) if (typeof value === "string") headers.set(key, value);
            const handler = path.startsWith("/api/reference-assets/") ? readReferenceMedia : readGenerationMedia;
            const result = await handler(new Request(`${origin}${path}`, { headers }), {
                params: Promise.resolve({
                    path: new URL(`${origin}${path}`).pathname
                        .replace(/^\/api\/(?:reference-assets|generation-log-assets)\//, "")
                        .split("/")
                        .map(decodeURIComponent),
                }),
            });
            response.writeHead(result.status, Object.fromEntries(result.headers));
            response.end(Buffer.from(await result.arrayBuffer()));
            return;
        }
        const bytes = media.get(path);
        if (!bytes || unavailable.has(path)) {
            response.writeHead(410);
            response.end("fixture media unavailable");
            return;
        }
        response.setHeader("content-type", "image/png");
        response.end(bytes);
    });
    beforeAll(async () => {
        if (!/\/vozeb_recovery_[a-f0-9]+(?:\?|$)/.test(process.env.DATABASE_URL || "")) throw new Error("必须通过隔离恢复演练脚本运行");
        await initializePostgresSchema();
        const now = new Date().toISOString();
        await createPostgresRepositories().users.createWithNextAccountId({
            id: userId,
            username: `recovery_${randomUUID().slice(0, 8)}`,
            displayName: "恢复演练",
            bio: "",
            role: "user",
            adminPermissions: [],
            status: "active",
            planId: "free",
            pointsBalance: 1000,
            passwordHash: "fixture-not-a-password",
            createdAt: now,
            updatedAt: now,
        });
        outputs = JSON.parse(await readFile(process.env.VOZEB_PRO_RECOVERY_MANIFEST!, "utf8")).outputs;
        for (const output of outputs) media.set(`/${output.supplierRequestId}.png`, await readFile(resolve("..", output.path)));
        media.set(
            "/one.png",
            await sharp({ create: { width: 24, height: 16, channels: 4, background: "red" } })
                .png()
                .toBuffer(),
        );
        media.set(
            "/two.png",
            await sharp({ create: { width: 16, height: 24, channels: 4, background: "blue" } })
                .png()
                .toBuffer(),
        );
        await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
        origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
        if (server.listening)
            await new Promise<void>((done) => {
                server.closeAllConnections();
                server.close(() => done());
            });
    });

    it("restores the three verified PNGs to their existing round and keeps refunds and prior failures", async () => {
        for (const runId of [...new Set(outputs.map((output) => output.runId))]) {
            const group = outputs.filter((output) => output.runId === runId);
            const current = group.toSorted((a, b) => b.agentAttempt - a.agentAttempt)[0];
            const run = runFixture(runId, current.conversationId, current.taskId, current.agentAttempt);
            await createCreativeRunBundle(userId, { run, prompt: "恢复原轮次", title: "恢复演练", assetIds: [], ttlMs: 86400000 });
            await mutateCreativeRun<AgentRun>(runId, 86400000, (item) => ({ run: { ...item, status: "failed", failure: "Maximum call stack size exceeded" } }));
        }
        for (const output of outputs) {
            const charge = await consumePoints({ userId, amount: output.points, usageKind: "image", units: 1, model: "fixture-image", description: "恢复演练原扣费", idempotencyKey: `charge:${output.taskId}` });
            await refundPoints({ userId, sourceIdempotencyKey: `charge:${output.taskId}`, usageKind: "image", units: 1, description: "恢复演练原退款", idempotencyKey: `refund:${output.taskId}` });
            const task = taskFixture(output.taskId, {
                status: "error",
                runId: output.runId,
                conversationId: output.conversationId,
                parentTaskId: "fixture-parent",
                attemptNo: output.agentAttempt,
                billing: { pointsCost: output.points, pointsRecordId: charge.record.id, refunded: true },
            });
            await createStoredGenerationTask("image", task, 86400000);
        }
        const before = await ledger();
        const restored: unknown[] = [];
        for (const output of outputs) {
            const input = { action: "provide_result" as const, result: `${origin}/${output.supplierRequestId}.png`, supplierRequestId: output.supplierRequestId };
            await Promise.all([reviewGenerationTask("image", output.taskId, input), reviewGenerationTask("image", output.taskId, input)]);
            const task = (await getImageTask(output.taskId))!;
            await persistImageTaskResult(task, origin, IMAGE_CHECKPOINT_RESULT_URL);
            const saved = (await getImageTask(output.taskId))!;
            expect(saved).toMatchObject({ status: "success", billing: { refunded: true }, attempts: [{ status: "failed", error: "Maximum call stack size exceeded" }], recoveryEvents: [{ source: "admin", supplierRequestId: output.supplierRequestId }] });
            expect(saved.error).toBeUndefined();
            expect(saved.result).toMatchObject({ width: output.width, height: output.height });
            expect(await reviewGenerationTask("image", output.taskId, input)).toMatchObject({ existingResult: true });
            await persistImageTaskResult(saved, origin, IMAGE_CHECKPOINT_RESULT_URL);
            const key = decodeURIComponent(saved.result!.serverUrl!.replace("/api/generation-log-assets/", ""));
            const metadata = await sharp(await readFile(resolve(process.env.VOZEB_PRO_DATA_DIR!, "generation-assets", key))).metadata();
            expect(metadata).toMatchObject({ width: output.width, height: output.height, format: "png" });
            restored.push({ taskId: output.taskId, supplierRequestId: output.supplierRequestId, result: saved.result, refunded: saved.billing?.refunded });
        }
        expect(await ledger()).toEqual(before);
        expect((await postgresQuery("SELECT id FROM creative_assets WHERE user_id=$1", [userId])).rows).toHaveLength(outputs.length);
        for (const runId of [...new Set(outputs.map((output) => output.runId))]) {
            const run = (await getAgentRun(runId))!;
            expect(run.status).toBe("completed");
            const messages = await listCreativeMessages(run.conversationId, 0, 20);
            expect(messages).toHaveLength(2);
            expect(messages[1]).toMatchObject({ id: run.assistantMessageId, status: "completed" });
            const active = outputs.filter((item) => item.runId === runId).toSorted((a, b) => b.agentAttempt - a.agentAttempt)[0];
            expect(run.tasks[0].result).toMatchObject({ serverUrl: (await getImageTask(active.taskId))!.result!.serverUrl });
        }
        expect([...requests.keys()].some((path) => /generations|completions/.test(path))).toBe(false);
        await writeFile(resolve(process.env.VOZEB_PRO_RECOVERY_EVIDENCE_DIR!, "restored-results.json"), JSON.stringify({ restored, ledgerBefore: before, ledgerAfter: await ledger(), upstreamCreatesDuringRecovery: 0 }, null, 2));
    }, 120000);

    it("keeps partial results and reuses a registered file after a checkpoint-update interruption", async () => {
        const task = taskFixture(randomUUID(), { status: "running", error: undefined });
        await createStoredGenerationTask("image", task, 86400000);
        await captureImageResultCheckpoint(task, { dataUrl: "", results: [{ dataUrl: `${origin}/one.png` }, { dataUrl: `${origin}/two.png` }] });
        unavailable.add("/two.png");
        await expect(persistImageTaskResult((await getImageTask(task.id))!, origin, IMAGE_CHECKPOINT_RESULT_URL)).rejects.toThrow();
        let saved = (await getImageTask(task.id))!;
        expect(saved.result?.results).toHaveLength(1);
        expect(saved.resultCheckpoint!.outputs[0].prepared).toBeTruthy();
        expect(getChannelRuntimeHealth("fixture-channel", "image").consecutiveFailures).toBe(0);
        const firstReads = requests.get("/one.png");
        // A process can die after registry commit and before checkpoint commit.
        await mutateImageTask(task.id, (current) => ({ ...current, resultCheckpoint: { ...current.resultCheckpoint!, outputs: current.resultCheckpoint!.outputs.map((item) => ({ ...item, prepared: undefined })) } }));
        unavailable.add("/one.png");
        unavailable.delete("/two.png");
        await persistImageTaskResult((await getImageTask(task.id))!, origin, IMAGE_CHECKPOINT_RESULT_URL);
        saved = (await getImageTask(task.id))!;
        expect(saved.status).toBe("success");
        expect(saved.result?.results).toHaveLength(2);
        expect(requests.get("/one.png")).toBe(firstReads);
        expect((await postgresQuery("SELECT storage_key FROM local_media_assets WHERE task_id=$1 AND scope='generation'", [task.id])).rows).toHaveLength(2);
        unavailable.clear();
    });

    it("checkpoints Base64 privately and recovers without an upstream task ID", async () => {
        const task = taskFixture(randomUUID(), { status: "running", error: undefined });
        await createStoredGenerationTask("image", task, 86400000);
        const raw = `data:image/png;base64,${media.get("/one.png")!.toString("base64")}`;
        const alternative = `data:image/png;base64,${media.get("/two.png")!.toString("base64")}`;
        const checkpoints = await Promise.all([captureImageResultCheckpoint(task, { dataUrl: raw }, "upstream", "source-one"), captureImageResultCheckpoint(task, { dataUrl: alternative }, "upstream", "source-two")]);
        expect(checkpoints[0].outputs).toEqual(checkpoints[1].outputs);
        expect(JSON.stringify(checkpoints)).not.toContain("base64");
        const original = checkpoints[0].supplierRequestId === "source-one" ? media.get("/one.png") : media.get("/two.png");
        expect(await readFile(resolve(process.env.VOZEB_PRO_DATA_DIR!, "reference-assets", checkpoints[0].outputs[0].privateMediaKey!))).toEqual(original);
        await persistImageTaskResult((await getImageTask(task.id))!, origin, IMAGE_CHECKPOINT_RESULT_URL);
        const saved = (await getImageTask(task.id))!;
        expect(saved.status).toBe("success");
        expect(saved.upstream).toBeUndefined();
        expect((await postgresQuery("SELECT storage_key FROM local_media_assets WHERE task_id=$1", [task.id])).rows).toHaveLength(2);
    });

    it("merges parallel child recoveries without losing an already completed result slot", async () => {
        const runId = `agent-${randomUUID()}`;
        const conversationId = `conversation-${randomUUID()}`;
        const ids = [randomUUID(), randomUUID(), randomUUID()];
        const run = runFixture(runId, conversationId, ids[0], 1);
        run.tasks[0].count = ids.length;
        run.tasks[0].childTasks = ids.map((id) => ({ id, status: "failed", attempt: 1, error: "local save failed" }));
        await createCreativeRunBundle(userId, { run, prompt: run.prompt, title: "并发恢复", assetIds: [], ttlMs: 86400000 });
        await mutateCreativeRun<AgentRun>(runId, 86400000, (current) => ({ run: { ...current, status: "failed" } }));
        for (const id of ids) await createStoredGenerationTask("image", taskFixture(id, { status: "error", runId, conversationId, parentTaskId: "fixture-parent" }), 86400000);
        const restore = async (id: string) => {
            await reviewGenerationTask("image", id, { action: "provide_result", result: `${origin}/one.png` });
            await persistImageTaskResult((await getImageTask(id))!, origin, IMAGE_CHECKPOINT_RESULT_URL);
        };
        await restore(ids[0]);
        const existingUrl = (await getImageTask(ids[0]))!.result!.serverUrl;
        await Promise.all(ids.slice(1).map(restore));
        const saved = (await getAgentRun(runId))!;
        expect(saved.status).toBe("completed");
        expect(saved.tasks[0].childTasks).toHaveLength(ids.length);
        expect(saved.tasks[0].childTasks?.every((child) => child.status === "completed")).toBe(true);
        const results = (saved.tasks[0].result as { results: Array<{ serverUrl: string }> }).results;
        expect(results).toHaveLength(ids.length);
        expect(results.some((result) => result.serverUrl === existingUrl)).toBe(true);
        expect(saved.tasks[0].assetIds).toHaveLength(ids.length);
        expect((await listCreativeMessages(conversationId, 0, 20)).map((message) => message.id)).toEqual([run.inputMessageId, run.assistantMessageId]);
        expect((await postgresQuery("SELECT id FROM creative_assets WHERE source_run_id=$1", [runId])).rows).toHaveLength(ids.length);
    });

    it("reuses registered layer files when their upstream URLs expire before checkpoint commit", async () => {
        const source = Buffer.from([255, 0, 0, 255, 0, 0, 255, 255]);
        const foreground = Buffer.from([255, 0, 0, 255, 0, 0, 0, 0]);
        const background = Buffer.from([0, 0, 255, 255, 0, 0, 255, 255]);
        const png = (data: Buffer) =>
            sharp(data, { raw: { width: 2, height: 1, channels: 4 } })
                .png()
                .toBuffer();
        media.set("/layer-foreground.png", await png(foreground));
        media.set("/layer-background.png", await png(background));
        const task = taskFixture(randomUUID(), { status: "running", kind: "edit", config: { ...taskFixture("config").config, outputMode: "layers" }, references: [{ dataUrl: `data:image/png;base64,${(await png(source)).toString("base64")}` }] });
        await createStoredGenerationTask("image", task, 86400000);
        await captureImageResultCheckpoint(task, { dataUrl: "", results: [{ dataUrl: `${origin}/layer-foreground.png` }, { dataUrl: `${origin}/layer-background.png` }] });
        const { prepareImageTaskResults } = await import("./image-task-result-service");
        await prepareImageTaskResults((await getImageTask(task.id))!, { dataUrl: "" }, origin, "");
        await mutateImageTask(task.id, (current) => ({ ...current, resultCheckpoint: { ...current.resultCheckpoint!, outputs: current.resultCheckpoint!.outputs.map((output) => ({ ...output, prepared: undefined })) } }));
        unavailable.add("/layer-foreground.png");
        unavailable.add("/layer-background.png");
        const reads = new Map(requests);
        await persistImageTaskResult((await getImageTask(task.id))!, origin, IMAGE_CHECKPOINT_RESULT_URL);
        const saved = (await getImageTask(task.id))!;
        expect(saved.status).toBe("success");
        expect(saved.result?.results).toHaveLength(2);
        expect(saved.result?.results?.every((result) => result.width === 2 && result.height === 1)).toBe(true);
        expect(requests.get("/layer-foreground.png")).toBe(reads.get("/layer-foreground.png"));
        expect(requests.get("/layer-background.png")).toBe(reads.get("/layer-background.png"));
        expect((await postgresQuery("SELECT storage_key FROM local_media_assets WHERE task_id=$1 AND scope='generation'", [task.id])).rows).toHaveLength(2);
        unavailable.clear();
    });

    it("rejects cancelled and deleted tasks and clears explicit undefined fields in PostgreSQL", async () => {
        const task = taskFixture(randomUUID());
        await createStoredGenerationTask("image", task, 86400000);
        await transitionImageTask(task, ["pending"], { status: "cancelled", error: undefined });
        expect((await getImageTask(task.id))!.error).toBeUndefined();
        await expect(reviewGenerationTask("image", task.id, { action: "provide_result", result: `${origin}/one.png` })).rejects.toMatchObject({ status: 409 });
        await expect(reviewGenerationTask("image", randomUUID(), { action: "provide_result", result: `${origin}/one.png` })).rejects.toMatchObject({ status: 404 });
    });

    it("notifies visible records after commit and supports a new subscription snapshot", async () => {
        const task = taskFixture(randomUUID());
        await createStoredGenerationTask("image", task, 86400000);
        let release = () => {};
        const changed = new Promise<void>(async (done, reject) => {
            try {
                release = await subscribeGenerationTaskChanges(new Set([`image:${task.id}`]), done);
            } catch (error) {
                reject(error);
            }
        });
        // LISTEN must be established before writing; use another subscription as a ready barrier.
        const stop = await subscribeGenerationTaskChanges(new Set([`image:${task.id}`]), () => {});
        await mutateImageTask(task.id, (current) => ({ ...current, title: "渠道已更新" }));
        await changed;
        release();
        stop();
        const saved = await getImageTask(task.id);
        expect(saved?.title).toBe("渠道已更新");
    });

    it("uses the saved B route immediately for queued and explicit attempts across a process boundary, while querying submitted A", async () => {
        const channels = ["A", "B"].map((id) => ({
            id,
            name: `Channel ${id}`,
            enabled: true,
            apiFormat: "openai" as const,
            baseUrl: `${origin}/${id}/v1`,
            apiKey: "fixture-key",
            models: ["fixture-image"],
            advancedConfig: { ...emptyAdvancedConfig(), protocol: "openai" as const, queryPath: "/images/jobs/{task_id}" },
        }));
        const logical = {
            id: "fixture-logical-image",
            name: "Fixture image",
            capability: "image" as const,
            enabled: true,
            bindings: channels.map((channel, index) => ({ id: `binding-${channel.id}`, channelId: channel.id, upstreamModel: "fixture-image", enabled: true, priority: index + 1 })),
        };
        await setAuthSettings({ systemChannels: channels, logicalModels: [logical], defaultModels: { textModel: "", imageModel: logical.id, videoModel: "", audioModel: "" } });
        const a = toSystemGenerationChannel(resolveLogicalModelCandidates(await getAuthSettings(), "image", logical.id)[0]);
        expect(a.channelId).toBe("A");
        const queued = taskFixture(randomUUID(), { config: a, error: undefined, attempts: [] });
        const retry = taskFixture(randomUUID(), { config: a, error: undefined, attempts: [{ attemptNo: 1, model: logical.id, channelId: "A", status: "failed", startedAt: Date.now() }] });
        const submitted = taskFixture(randomUUID(), { config: a, error: undefined, status: "running", upstream: { id: "original-upstream", pollBaseUrl: `${origin}/api/ai/system/A`, mediaBaseUrl: `${origin}/api/ai/system/A` } });
        for (const task of [queued, retry, submitted]) await createStoredGenerationTask("image", task, 86400000);
        await scheduleGenerationTask("image", submitted.id, { executionPhase: "submitted", upstreamTaskId: "original-upstream", channelId: "A" });
        const updated = [{ ...logical, bindings: logical.bindings.map((binding) => ({ ...binding, priority: binding.channelId === "B" ? 1 : 2 })) }];
        await new Promise<void>((done, reject) => {
            const code =
                "import {Client} from 'pg';const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();await c.query(\"UPDATE vozeb_pro_app_settings SET logical_models=$1::jsonb WHERE id='default'\",[process.env.RECOVERY_FIXTURE_ROUTES]);await c.end();";
            const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, RECOVERY_FIXTURE_ROUTES: JSON.stringify(updated) }, stdio: ["ignore", "ignore", "pipe"] });
            child.on("error", reject);
            child.on("exit", (exitCode) => (exitCode === 0 ? done() : reject(new Error(`fixture settings writer exited ${exitCode}`))));
        });
        for (const task of [queued, retry]) {
            expect(await createImageTaskUpstreamStep(task, origin, origin)).toMatchObject({ state: "result_ready" });
            const saved = (await getImageTask(task.id))!;
            expect(saved.config.channelId).toBe("B");
            expect(saved.attempts!.at(-1)?.channelSnapshot).toMatchObject({ channelId: "B", channelName: "Channel B", logicalModelId: logical.id });
        }
        expect(requests.get("/B/v1/images/generations")).toBe(2);
        expect(requests.get("/A/v1/images/generations")).toBeUndefined();
        expect(await queryImageTaskUpstreamStep((await getImageTask(submitted.id))!, origin)).toMatchObject({ state: "result_ready" });
        expect(requests.get("/A/v1/images/jobs/original-upstream")).toBe(1);
        const current = await getFreshAuthSettings();
        await setAuthSettings({
            systemChannels: current.systemChannels.map((channel) => (channel.id === "A" ? { ...channel, baseUrl: `${origin}/changed/v1`, apiKey: "changed-key", advancedConfig: { ...channel.advancedConfig!, queryPath: "/changed/{task_id}" } } : channel)),
            logicalModels: [],
        });
        for (const deleted of [false, true]) {
            if (deleted) await setAuthSettings({ systemChannels: [] });
            const original = await mutateImageTask(submitted.id, (task) => ({ ...task, resultCheckpoint: undefined, result: undefined }));
            expect(await queryImageTaskUpstreamStep(original!, origin)).toMatchObject({ state: "result_ready" });
        }
        expect(requests.get("/A/v1/images/jobs/original-upstream")).toBe(3);
        expect(requests.get("/changed/v1/changed/original-upstream")).toBeUndefined();
        await setAuthSettings({ systemChannels: current.systemChannels.filter((channel) => channel.id !== "B") });
        const audit = generationTaskCallAudits((await getStoredGenerationTaskRecord("image", queued.id))!);
        expect(audit[0].attempts.at(-1)?.channelSnapshot).toMatchObject({ channelId: "B", channelName: "Channel B" });
    }, 30000);

    async function ledger() {
        return (await postgresQuery("SELECT id, type, amount, source_record_id FROM point_records WHERE user_id=$1 ORDER BY id", [userId])).rows;
    }
    function taskFixture(id: string, patch: Partial<ImageTask> = {}): ImageTask {
        const now = Date.now();
        return {
            id,
            userId,
            username: "fixture",
            displayName: "恢复演练",
            kind: "generation",
            source: "agent",
            status: "pending",
            createdAt: now,
            updatedAt: now,
            config: { apiSource: "custom", apiFormat: "openai", baseUrl: origin, apiKey: "fixture-key", model: "fixture-image", channelId: "fixture-channel", size: "auto" },
            prompt: "恢复原有图片",
            references: [],
            error: "Maximum call stack size exceeded",
            attempts: [{ attemptNo: 1, model: "fixture-image", status: "failed", startedAt: now, completedAt: now, error: "Maximum call stack size exceeded" }],
            ...patch,
        };
    }
    function runFixture(id: string, conversationId: string, activeTaskId: string, attempt: number): AgentRun {
        const now = Date.now();
        return {
            id,
            userId,
            conversationId,
            clientRequestId: `fixture:${id}`,
            surface: "chat",
            inputMessageId: `input:${id}`,
            assistantMessageId: `assistant:${id}`,
            prompt: "恢复原轮次",
            referencedAssetIds: [],
            assetIds: [],
            status: "planning",
            reviewed: false,
            tasks: [
                {
                    id: "fixture-parent",
                    title: "原图片",
                    type: "image",
                    prompt: "原请求",
                    count: 1,
                    dependencies: [],
                    status: "failed",
                    attempts: attempt,
                    taskId: activeTaskId,
                    childTasks: [{ id: activeTaskId, status: "failed", attempt, error: "Maximum call stack size exceeded" }],
                },
            ],
            createdAt: now,
            updatedAt: now,
        };
    }
});
