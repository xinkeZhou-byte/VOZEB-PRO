import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Page, type TestInfo, type Locator } from "@playwright/test";
import { e2eSettingsPatch, E2E_PROTOCOL_ORIGIN, pollTask, protocolFixtureState, resetProtocolFixture } from "./support";
import { openCreativeHistory } from "./responsive-helpers";

test.describe.configure({ mode: "serial" });
test.beforeEach(async ({ request }) => {
    const saved = await request.patch("/api/admin/settings", { data: e2eSettingsPatch() });
    expect(saved.ok(), await saved.text()).toBe(true);
    await resetProtocolFixture(request);
});
test.afterEach(async ({ request }) => {
    const saved = await request.patch("/api/admin/settings", { data: e2eSettingsPatch() });
    expect(saved.ok(), await saved.text()).toBe(true);
});

test("saved routes apply immediately and synchronize another tab without replacing its draft", async ({ page, context, request }, info) => {
    await page.goto("/admin?section=channels");
    const other = await context.newPage();
    await other.goto("/admin?section=channels");
    const channelSwitch = (target: Page) => target.getByRole("switch", { name: /E2E 主渠道.*启用状态/ });
    await expect(channelSwitch(other)).toBeChecked();
    await page
        .getByRole("button", { name: /^查\s*看$/ })
        .first()
        .click();
    const drawer = page.getByRole("dialog", { name: "E2E 主渠道", exact: true });
    await drawer.getByRole("tab", { name: "渠道配置", exact: true }).click();
    await drawer.getByRole("switch").first().click();
    await drawer.locator(".ant-drawer-close").click();
    await expect(page.getByText("有未保存更改，保存后新调用立即使用新路由")).toBeVisible();
    await expect(channelSwitch(other)).toBeChecked();
    await page.getByRole("button", { name: "保存模型渠道配置" }).click();
    await expect(page.getByText("模型渠道配置已保存", { exact: true })).toBeVisible();
    await expect(channelSwitch(other)).not.toBeChecked();
    const persisted = await request.get("/api/admin/settings");
    expect((await persisted.json()).settings.systemChannels.find((channel: { id: string }) => channel.id === "e2e-primary").enabled).toBe(false);
    const created = await request.post("/api/image-tasks", { data: { config: { model: "e2e-image", size: "64x64" }, prompt: `路由立即生效 ${randomUUID()}` } });
    expect(created.ok(), await created.text()).toBe(true);
    const id = (await created.json()).task.id;
    expect(await pollTask(request, `/api/image-tasks/${id}`)).toMatchObject({ status: "success" });
    const state = await protocolFixtureState(request);
    expect(state.requests.filter((item) => item.method === "POST" && item.path.endsWith("/images/generations"))).toMatchObject([{ authorization: "Bearer e2e-backup-secret" }]);
    await page.reload();
    await expect(channelSwitch(page)).not.toBeChecked();

    // A second tab's local edits survive a save broadcast from the first tab.
    await other
        .getByRole("button", { name: /^查\s*看$/ })
        .first()
        .click();
    const otherDrawer = other.getByRole("dialog");
    await otherDrawer.getByRole("tab", { name: "渠道配置", exact: true }).click();
    const name = otherDrawer.getByPlaceholder("青岩智影、123NHH、自建接口");
    await name.fill("未保存渠道草稿");
    const savedAgain = page.waitForResponse((response) => response.url().endsWith("/api/admin/settings") && response.request().method() === "PATCH");
    await page.getByRole("button", { name: "保存模型渠道配置" }).click();
    expect((await savedAgain).ok()).toBe(true);
    await expect(name).toHaveValue("未保存渠道草稿");
    await otherDrawer.locator(".ant-drawer-close").click();
    await expect(other.getByText("有未保存更改，保存后新调用立即使用新路由")).toBeVisible();
    await captureLayout(page, info, "saved-channel-routing");
    await other.close();
});

test("both admin details show planner and generation channels and reconnect to task changes", async ({ page, context, request }, info) => {
    await page.addInitScript(() => localStorage.setItem("vozeb-pro:theme_store", JSON.stringify({ state: { theme: "dark" }, version: 0 })));
    const created = await request.post("/api/agent/runs", { data: { clientRequestId: randomUUID(), surface: "chat", prompt: "生成一张蓝色图片", preferences: { mode: "image", image: { size: "64x64" } } } });
    expect(created.ok(), await created.text()).toBe(true);
    const runId = (await created.json()).data.run.id;
    await expect.poll(async () => (await (await request.get(`/api/agent/runs/${runId}`)).json()).data.run.status, { timeout: 60_000 }).toBe("completed");
    const publicRun = await (await request.get(`/api/agent/runs/${runId}`)).json();
    expect(JSON.stringify(publicRun)).not.toMatch(/channelSnapshot|upstreamRouteCiphertext|e2e-primary-secret|E2E 主渠道/);
    await page.goto("/admin?section=generationOperations");
    await page.getByRole("searchbox", { name: "搜索生成任务" }).fill(runId);
    await page.getByRole("searchbox", { name: "搜索生成任务" }).press("Enter");
    await page.getByRole("button", { name: "查看生成任务详情" }).first().click();
    const detail = page.getByRole("dialog", { name: "生成任务详情", exact: true });
    await expect(detail.getByText("Agent 规划模型", { exact: true })).toBeVisible();
    await expect(detail.getByText("图片生成子任务", { exact: true })).toBeVisible();
    await expect(detail.getByText("渠道名称：E2E 主渠道", { exact: true }).first()).toBeVisible();
    await captureLayout(page, info, "operation-channel-details", detail);
    await detail.getByRole("button", { name: "Close", exact: true }).click();
    await page.goto("/admin?section=logs");
    await page
        .getByRole("button", { name: /^详\s*情$/ })
        .first()
        .click();
    const logDetail = page.getByRole("dialog", { name: "生成日志详情", exact: true });
    await expect(logDetail.getByText("Agent 规划模型", { exact: true })).toBeVisible();
    await expect(logDetail.getByText("图片生成子任务", { exact: true })).toBeVisible();
    await expect(logDetail.getByText("实际上游模型：e2e-image", { exact: true })).toBeVisible();
    await captureLayout(page, info, "log-channel-details", logDetail);
    await logDetail.getByRole("button", { name: "Close", exact: true }).click();

    const videoResponse = await request.post("/api/video-generation-tasks", { data: { config: { model: "e2e-video-slow" }, prompt: "SSE 重连任务" } });
    expect(videoResponse.ok(), await videoResponse.text()).toBe(true);
    const videoId = (await videoResponse.json()).task.id;
    await page.goto("/admin?section=generationOperations");
    await page.getByRole("searchbox", { name: "搜索生成任务" }).fill(videoId);
    await page.getByRole("searchbox", { name: "搜索生成任务" }).press("Enter");
    await page.getByRole("button", { name: "查看生成任务详情" }).first().click();
    await expect(detail.getByText("实际上游模型：e2e-video-slow", { exact: true })).toBeVisible();
    await context.setOffline(true);
    const cancelled = await request.patch(`/api/video-tasks/${videoId}`, { data: { status: "cancelled" } });
    expect(cancelled.ok(), await cancelled.text()).toBe(true);
    await context.setOffline(false);
    await expect(detail).toContainText("已取消", { timeout: 30_000 });
    await expect(detail.getByText("渠道名称：E2E 主渠道", { exact: true })).toBeVisible();
    await captureLayout(page, info, "sse-reconnected-details", detail);
});

test("administrator supplements a failed image and both open details refresh without generation", async ({ page, context, request }, info) => {
    const settings = e2eSettingsPatch();
    const model = "e2e-image-fail";
    for (const channel of settings.systemChannels) {
        channel.models = [...channel.models, model];
        channel.advancedConfig.modelCapabilities[model] = "image";
        channel.advancedConfig.modelConfigs[model] = channel.advancedConfig.modelConfigs["e2e-image"];
    }
    const saved = await request.patch("/api/admin/settings", { data: settings });
    expect(saved.ok(), await saved.text()).toBe(true);
    const prompt = `失败图片补录 ${randomUUID()}`;
    const created = await request.post("/api/image-tasks", { data: { config: { model, size: "64x64" }, prompt } });
    expect(created.ok(), await created.text()).toBe(true);
    const id = (await created.json()).task.id;
    expect(await pollTask(request, `/api/image-tasks/${id}`)).toMatchObject({ status: "error" });
    const before = (await protocolFixtureState(request)).requests.filter((item) => item.method === "POST").length;
    await page.goto("/admin?section=generationOperations");
    await page.getByRole("searchbox", { name: "搜索生成任务" }).fill(id);
    await page.getByRole("searchbox", { name: "搜索生成任务" }).press("Enter");
    await page.getByRole("button", { name: "接管待确认任务" }).first().click();
    const review = page.getByRole("dialog", { name: "接管待确认任务", exact: true });
    await expect(review.getByRole("button", { name: "录入任务 ID" })).toBeDisabled();
    await review.getByPlaceholder("粘贴上游成品 URL 或站内媒体地址").fill(`${E2E_PROTOCOL_ORIGIN}/media/fixture.png`);
    await captureLayout(page, info, "supplement-failed-image", review);
    await review.getByRole("button", { name: "确认并继续" }).click();
    await expect(review).toHaveCount(0);
    await page.getByRole("button", { name: "查看生成任务详情" }).first().click();
    const detail = page.getByRole("dialog", { name: "生成任务详情", exact: true });
    const logs = await context.newPage();
    await logs.goto("/admin?section=logs");
    await logs.getByPlaceholder("搜索日志").fill(prompt);
    await logs
        .getByRole("button", { name: /^详\s*情$/ })
        .first()
        .click();
    const logDetail = logs.getByRole("dialog", { name: "生成日志详情", exact: true });
    expect(await pollTask(request, `/api/image-tasks/${id}`)).toMatchObject({ status: "success" });
    await expect(detail).toContainText("管理员补录");
    await expect(logDetail).toContainText("管理员补录");
    await expect(logDetail.locator('img[src*="/api/generation-log-assets/"]').first()).toBeVisible();
    expect((await protocolFixtureState(request)).requests.filter((item) => item.method === "POST")).toHaveLength(before);
    await captureLayout(logs, info, "supplemented-log-detail", logDetail);
    await logs.close();
});

test("saved image history restores its result and supplies an actual image-to-video reference", async ({ page, request }, info) => {
    await page.goto("/create", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".creative-composer")).toHaveAttribute("data-ready", "true", { timeout: 45_000 });
    await page.getByRole("button", { name: "当前创作类型：Agent 模式" }).click();
    await page
        .locator(".ant-popover")
        .filter({ hasText: "创作类型" })
        .last()
        .getByRole("button", { name: /图片生成/ })
        .click();
    const prompt = `历史结果引用 ${randomUUID().slice(0, 8)}`;
    const imageRun = await submitCreativePrompt(page, request, prompt);
    const image = page.getByTestId("creative-media-result").getByTestId("creative-primary-result").getByRole("img");
    await expect(image).toHaveAttribute("src", /\/api\/generation-log-assets\/permanent\/.+\.png/);
    const imageUrl = (await image.getAttribute("src"))!;
    const original = await request.get(imageUrl.split("?")[0]);
    expect(original.ok(), await original.text()).toBe(true);
    const imageBytes = (await original.body()).byteLength;
    const conversation = (await (await request.get(`/api/creative/conversations/${imageRun.conversationId}`)).json()).data.conversation;

    await page.getByTestId("creative-page-tools").getByRole("button", { name: "新建对话", exact: true }).click();
    await expect(image).toHaveCount(0);
    const history = await openCreativeHistory(page);
    await history.getByText(conversation.title, { exact: true }).click();
    if ((page.viewportSize()?.width || 0) >= 1024) await history.getByRole("button", { name: "关闭创作历史" }).click();
    await expect(image).toHaveAttribute("src", imageUrl);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator(".creative-composer")).toHaveAttribute("data-ready", "true", { timeout: 45_000 });
    await expect(image).toHaveAttribute("src", imageUrl);
    const actions = page.locator('[aria-label="本轮创作操作"]').first();
    const assetId = await actions.getAttribute("data-active-asset-id");
    expect(assetId).toBeTruthy();
    await actions.getByRole("button", { name: "更多本轮创作操作" }).click();
    await page.getByRole("menuitem", { name: "引用结果", exact: true }).click();
    await expect(page.locator(".creative-composer").getByRole("img")).toBeVisible();
    await page.getByRole("button", { name: /^当前创作类型：/ }).click();
    await page
        .locator(".ant-popover")
        .filter({ hasText: "创作类型" })
        .last()
        .getByRole("button", { name: /视频生成/ })
        .click();
    const videoRun = await submitCreativePrompt(page, request, "让这张画面缓慢移动", [assetId!]);
    expect(videoRun.conversationId).toBe(imageRun.conversationId);
    const video = page.getByTestId("creative-video-result").locator("video");
    await expect(video).toHaveAttribute("src", /\/api\/reference-assets\/permanent\/.+\.mp4/);
    const state = await protocolFixtureState(request);
    const videos = state.requests.filter((item) => item.method === "POST" && item.path.endsWith("/videos"));
    expect(videos).toHaveLength(1);
    expect(videos[0].contentType).toContain("multipart/form-data");
    expect(videos[0].inputReferenceBytes).toBe(imageBytes);
    expect(state.requests.filter((item) => item.method === "POST" && item.path.endsWith("/images/generations"))).toHaveLength(1);
    await captureLayout(page, info, "history-image-to-video");
    await info.attach("reference-evidence", {
        body: JSON.stringify({ conversationId: imageRun.conversationId, imageRunId: imageRun.id, videoRunId: videoRun.id, assetId, imageBytes, upstreamReferenceBytes: videos[0].inputReferenceBytes }),
        contentType: "application/json",
    });
});

async function submitCreativePrompt(page: Page, request: APIRequestContext, prompt: string, assetIds: string[] = []) {
    await page.getByRole("textbox", { name: "输入你的创作想法、脚本或画面要求" }).fill(prompt);
    const created = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/agent/runs");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const response = await created;
    expect(response.ok(), await response.text()).toBe(true);
    expect(response.request().postDataJSON().assetIds).toEqual(assetIds);
    const run = (await response.json()).data.run as { id: string; conversationId: string };
    await expect.poll(async () => (await (await request.get(`/api/agent/runs/${run.id}`)).json()).data.run.status, { timeout: 60_000 }).toBe("completed");
    return run;
}

async function captureLayout(page: Page, info: TestInfo, name: string, dialog?: Locator) {
    const bounds = await page.evaluate(() => ({ viewport: window.innerWidth, root: document.documentElement.scrollWidth }));
    expect(bounds.root).toBeLessThanOrEqual(bounds.viewport + 1);
    if (dialog) {
        const box = await dialog.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(bounds.viewport + 1);
        const overflow = await dialog.evaluate((node) => ({ client: node.clientWidth, scroll: node.scrollWidth }));
        expect(overflow.scroll).toBeLessThanOrEqual(overflow.client + 1);
    }
    await info.attach(name, { body: await page.screenshot(), contentType: "image/png" });
}
