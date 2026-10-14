import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { Client } from "pg";

process.loadEnvFile(".env.local");
const source = new URL(process.env.DATABASE_URL || process.env.POSTGRES_URL || "");
if (!["127.0.0.1", "localhost", "[::1]"].includes(source.hostname)) throw new Error("浏览器回归只允许本机隔离 PostgreSQL");
const database = `vozeb_browser_${randomUUID().replaceAll("-", "")}`;
const client = new Client({ connectionString: source.toString() });
await client.connect();
try {
    await client.query(`CREATE DATABASE "${database}"`);
} finally {
    await client.end();
}
source.pathname = `/${database}`;
const directory = resolve("../output/playwright", database);
await mkdir(directory, { recursive: true });
const reservations = [];
try {
    for (let index = 0; index < 3; index += 1) {
        const server = createServer();
        await new Promise((done, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", done);
        });
        reservations.push(server);
    }
    const [app, protocol, payment] = reservations.map((server) => server.address().port);
    const env = {
        ...process.env,
        VOZEB_PRO_E2E_DATABASE_URL: source.toString(),
        VOZEB_PRO_E2E_PORT: String(app),
        VOZEB_PRO_PROTOCOL_FIXTURE_PORT: String(protocol),
        VOZEB_PRO_PAYMENT_FIXTURE_PORT: String(payment),
        VOZEB_PRO_INTERNAL_ORIGIN: `http://127.0.0.1:${app}`,
        VOZEB_PRO_WORKER_API_ORIGIN: `http://127.0.0.1:${app}`,
        NEXT_PUBLIC_SITE_URL: `http://127.0.0.1:${app}`,
        PLAYWRIGHT_JSON_OUTPUT_NAME: resolve(directory, "tests.json"),
        TEMP: directory,
        TMP: directory,
    };
    const prepareCode = await run("scripts/prepare-e2e.mjs", [], env);
    if (prepareCode !== 0) throw new Error(`浏览器回归准备失败：${prepareCode}`);
    await Promise.all(reservations.map((server) => new Promise((done) => server.close(done))));
    const files = ["e2e/generation-recovery.spec.ts", "e2e/core.spec.ts", "e2e/canvas.spec.ts", "e2e/responsive-workspaces.spec.ts"];
    const grep =
        "saved routes|both admin details|administrator supplements|saved image history|text tasks return|image task persists|unified creative (?:page|video mode|Agent)|Canvas Agent persists local|Drama Agent persists|video request replay|audio task stores|canvas keeps editing, selection|creative workspaces remain usable|fresh deployments|public session omits|initialization rejects";
    console.log(`隔离浏览器数据库：${database}；独立端口：${app}/${protocol}/${payment}`);
    const exitCode = await run("node_modules/@playwright/test/cli.js", ["test", ...files, "--workers=1", "--reporter=list,json", `--output=${resolve(directory, "artifacts")}`, "--grep", grep, ...process.argv.slice(2)], env);
    await writeFile(resolve(directory, "run.json"), JSON.stringify({ database, ports: { app, protocol, payment }, directory, exitCode, productionChanged: false }, null, 2));
    console.log(`浏览器证据：${directory}`);
    process.exitCode = exitCode;
} finally {
    for (const server of reservations) if (server.listening) server.close();
}

function run(entry, args, env) {
    return new Promise((done, reject) => {
        const child = spawn(process.execPath, [entry, ...args], { env, stdio: "inherit" });
        child.on("error", reject);
        child.on("exit", (code) => done(code ?? 1));
    });
}
