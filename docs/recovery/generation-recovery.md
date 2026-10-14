# 本地结果恢复与渠道验收

本轮代码在 `Z:\Projects\VOZEB-PRO` 开发。服务器保持只读，没有部署、重启、写生产数据或调用真实收费渠道。三张 PNG 的恢复仅在新建的本机隔离 PostgreSQL 数据库中演练。

## 结果恢复契约

- 上游返回图片后先保存 `resultCheckpoint`：URL 保留来源，Base64 保存为私有临时媒体，任务 JSON 不保存完整 Base64。
- 文件保存、媒体登记和检查点使用稳定存储键。中断后只补齐缺失步骤；已经登记的同任务媒体不再下载，同批成功图片不会被后续失败删除。
- 响应解析、检查点、媒体读取、图片处理、文件保存、资产登记和任务更新记录脱敏诊断。供应商请求 ID 用于对账，可查询上游任务 ID 用于查询，两者不能混用。
- 上游成功后的本地保存异常进入原结果恢复流程，不计入上游失败或渠道冷却；原成功调用、失败证据与恢复事件分别保留。
- 恢复保持原任务、会话、Run 和助手消息，不调用规划器、不重新生成、不追加用户消息、不补扣积分、不再次退款。取消或删除的任务拒绝恢复。
- 当前生效尝试作为主结果，之前尝试的成功产物作为附加结果保留。缺少可验证的原父任务或原助手消息时，不猜测关联或创建替代业务记录。

## 管理员查看渠道

后台“调用记录”的详情和“生成运维”的任务详情均展示实际调用的逻辑模型、上游模型、渠道名称/ID、调用时间、状态与失败原因。Agent 规划和每个生成子任务分别展示。

这些字段来自调用时的快照，渠道后续改名或删除不会改写历史；历史没有记录的字段显示“未记录”。诊断、渠道审计和加密路由仅保留在服务端及管理员允许的响应中，公共任务、素材和对话接口继续使用显式白名单。

配置的生效边界是显式保存成功。未保存草稿不影响运行时路由。新的提交、排队但未提交的任务、允许发起的新尝试和长运行 Agent 的后续任务读取最新持久化配置，仍遵循已有优先级与健康选路规则。已经提交的任务使用原加密传输快照查询或取消同一个上游任务；配置切换不会重新生成。

保存后通过 `BroadcastChannel("vozeb-pro-settings")` 同步当前浏览器其他标签页；其他标签的未保存草稿继续保留。后台详情通过 `/api/admin/generation-operations/events?record=image:任务ID` 等可见记录订阅更新，要求当前管理员拥有 `generation.read`。首次连接和断线重连都重新读取快照。PostgreSQL 使用事务提交后的 `vozeb_pro_generation_events` 通知；文件 Provider 只支持同进程通知，不能替代 PostgreSQL 跨进程同步。

## 用户检查已有结果

在原结果的“检查状态”入口继续原任务，或以原用户会话提交：

```http
POST /api/image-tasks/{taskId}
Content-Type: application/json

{"action":"recover"}
```

存在检查点时直接继续保存，不要求上游任务 ID。没有检查点时，仅对已保存的真实上游任务身份执行查询。仍在处理或本地保存暂时失败时可再次检查，不重建任务或开启无限自动查询。

## 管理员补录已核验图片

后台“生成运维”搜索原图片任务，打开“接管待确认任务”，粘贴已核验的成品 URL 或站内媒体地址并确认。失败图片只开放补录结果，不开放伪造上游任务 ID 或再次确认失败。

操作要求当前管理员 Session 具有 `generation.manage`，沿用媒体归属校验、安全出站读取和审计。可通过相同接口同时登记供应商请求 ID：

```http
POST /api/admin/generation-operations/image/{taskId}/review
Content-Type: application/json

{
  "action": "provide_result",
  "result": "https://verified-supplier.example/result.png",
  "supplierRequestId": "已核验的供应商请求ID"
}
```

成功响应的 `executionPhase: "result_ready"` 表示原任务已经排队继续保存，需在详情确认最终成功。已有成功结果时重复请求返回 `existingResult: true`；已有检查点时复用原产物，不替换为新输入。取消任务返回 409，缺失或删除任务返回 404。不要把供应商请求 ID 填入“上游任务 ID”。

生产操作前仍须核对原任务用户、会话、Run、父任务、原助手消息、原扣费/退款流水和核验过的产物；本轮没有授权执行生产恢复。

## 三次请求演练清单

清单保存在 [image-results-manifest.json](./image-results-manifest.json)，不硬编码进业务代码。

| 供应商请求 ID                      | 原图片任务 ID                          | 原尝试 | 原 PNG      |
| ---------------------------------- | -------------------------------------- | ------ | ----------- |
| `fd7ea6e35db0440f5d4c6982f3596af5` | `745ea41a-d8a5-493f-9d63-d552dceadcf7` | 1      | 3840 × 2160 |
| `67bc14fa82a31c9907fa785df419ea2d` | `e5e38872-47c3-49fa-8892-2145a8d94748` | 2      | 3840 × 2160 |
| `66b6f51de29fab54aed6e3e17bd9c7c5` | `23705d2e-7359-47b5-adb0-4c651e34254a` | 1      | 2480 × 3312 |

前两次属于 `agent-aBRMuyjY6lbV6GQWmEiJl` / `conversation-2G_X5cRpilQM8UZjKJz6x`，第二次尝试为主结果；第三次属于 `agent-Wn9rGFlzgr-RASzIrTz32` / `conversation-57QIJO4pot3KqL1Qo_j3C`。

本地原退款分别为 15、15、22.5 积分，演练前后账本一致。供应商三次生成各记账 0.10 美元，供应商侧退款未确认；本地积分退款不能证明供应商退款。

演练沿用这些稳定任务/Run/会话 ID，但 Run、父任务和消息是最小隔离夹具，并非完整生产快照。前两次原事件确认父任务为 `direct-model-task-1`；演练父任务使用 `fixture-parent`。第三次完整原 Run、父任务和助手消息快照仍缺失，不能据演练宣布生产对话已恢复。

## 复现演练与证据

以下是后续获准恢复自动验证时的复现命令。本轮遵循当前“仅 UI 走查”的指令，不再执行单元、协议、数据库测试、类型检查或 Lint。在 `web` 目录执行：

```powershell
$env:TEMP = 'Z:\Projects\VOZEB-PRO\.tmp'
$env:TMP = $env:TEMP
node scripts/run-generation-recovery-drill.mjs
pnpm test:protocols
node scripts/run-generation-browser-regression.mjs
```

两个演练脚本只接受本机 PostgreSQL，并自动创建独立随机数据库；不会使用已有业务数据库作为写入目标。协议和浏览器请求只使用本地 TCP fixture、固定测试凭据和独立端口。测试数据库与产物保留供核对，不自动删除其他数据库或业务目录。

已通过的恢复证据位于 `.tmp/generation-recovery/vozeb_recovery_77a27197654b4074bb6740e557945685/`：

- `tests.json`：8 项恢复、通知和路由演练全部通过。
- `restored-results.json`：三张真实 PNG 落盘信息、恢复前后账本、恢复期间上游创建数为 0。
- `drill.json`：隔离数据库和证据目录，不包含连接密码。

URL、Base64、多图部分失败、文件登记与检查点提交间中断、并发重复补录、取消/删除拒绝、跨进程 A 切换 B，以及旧 A 配置修改/删除后的原任务查询均有自动化证据。浏览器证据由脚本写入 `output/playwright/vozeb_browser_*/`，以成功运行的 `run.json` 和 `tests.json` 为准。

此前已执行的 Web 全量报告 `.tmp/generation-plan-full-tests.json` 为 2662 项通过、0 项失败、17 项按环境跳过；`.tmp/generation-plan-protocols.log` 为 8 个文件、126 项通过，类型检查、Lint 和生产构建也已通过。这些是当前仅 UI 走查指令之前的证据，不表示收尾重新执行了质量门禁。

浏览器证据分批保留，不合并宣称全套通过：

- `output/playwright/vozeb_browser_c5f0af770c6b4e6dbae883dedf138f98/`：23 项通过、3 项补录图片预览失败。预览已修正为优先使用站内保存媒体。
- `output/playwright/vozeb_browser_539ec1806548474181ee50736653ce76/`：6 项通过，覆盖 setup 和桌面、390px、430px 的补录预览；新增历史引用检查有 3 项失败，原因是本地规划夹具未传引用资产 ID。夹具已修正，自动断言未重跑。
- `output/playwright/generation-ui-walkthrough/`：调用记录浅色、生成运维深色的桌面、390px、430px 截图。两处规划与生成调用均可读，无横向溢出。后续通过 UI 打开历史图片、刷新、引用并发起一次独立的本地视频请求，结果成功落盘且可播放；新播放器 `readyState=4`、固有尺寸 `320×180`、时长 5 秒，三宽度的实际布局保存在 `history-reference-layout.json`。旧夹具视频只有文件头，历史条目仍显示加载失败，不作为真实视频故障证据。

复用隔离数据库时，上游夹具重启曾复用 `fixture-video-1`，与已完成历史任务触发渠道/上游身份唯一约束；原暂停记录作为演练证据保留。独立运行的夹具现使用随机实例命名空间，避免重启后任务 ID 冲突；直接导入的协议夹具仍保留顺序 ID 契约。此次修正未重新运行自动测试。

本机 Playwright 浏览器版本不齐时，将 `PLAYWRIGHT_BROWSERS_PATH` 设置为项目内 `.tmp/playwright-browsers` 再安装当前锁定版本的 Chromium。Windows Standalone 目录链接曾出现 `EPERM`；本轮只修正本机生成目录中的错误目录链接，没有修改发布代码。独立 Linux/Docker 产物仍须按部署流程验收。

## 原始堆栈故障的证据边界

目前确认供应商已返回三张真实产物，本地失败文案为 `Maximum call stack size exceeded`。历史日志没有完整异常堆栈、触发函数、逐阶段检查点或完整第三次 Run 快照，尚未复现原始触发路径。

本轮增加阶段堆栈诊断、保存检查点与原身份恢复，并把结果遍历改为迭代遍历以处理深层/循环引用和完整多结果；这些硬化不能证明原故障发生在结果遍历函数。交付只能说明恢复与可观测性已实现，不能宣称原堆栈溢出根因已修复。
