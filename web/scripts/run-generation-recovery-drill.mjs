import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { Client } from "pg";

// Never accept a production host or an existing business database as the drill target.
process.loadEnvFile(".env.local");
const source = new URL(process.env.DATABASE_URL || process.env.POSTGRES_URL || "");
if (!["127.0.0.1", "localhost", "[::1]"].includes(source.hostname)) throw new Error("恢复演练只允许本机 PostgreSQL");
const database = `vozeb_recovery_${randomUUID().replaceAll("-", "")}`;
const client = new Client({ connectionString: source.toString() });
await client.connect();
try {
    await client.query(`CREATE DATABASE "${database}"`);
} finally {
    await client.end();
}
source.pathname = `/${database}`;
const directory = resolve("../.tmp/generation-recovery", database);
await mkdir(directory, { recursive: true });
const report = resolve(directory, "tests.json");
const env = {
    ...process.env,
    DATABASE_URL: source.toString(),
    VOZEB_PRO_DATABASE_PROVIDER: "postgres",
    VOZEB_PRO_RUN_RECOVERY_DRILL: "1",
    VOZEB_PRO_DATA_DIR: resolve(directory, "data"),
    VOZEB_PRO_RECOVERY_EVIDENCE_DIR: directory,
    VOZEB_PRO_RECOVERY_MANIFEST: resolve("../docs/recovery/image-results-manifest.json"),
    VOZEB_PRO_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    VOZEB_PRO_WORKER_TOKEN: "local-recovery-fixture-worker-token-32chars",
    VOZEB_PRO_ALLOW_PRIVATE_UPSTREAMS: "1",
    VOZEB_PRO_PRIVATE_UPSTREAM_HOSTS: "127.0.0.1",
    TEMP: directory,
    TMP: directory,
};
console.log(`隔离恢复演练数据库：${database}`);
const code = await new Promise((done, reject) => {
    const child = spawn(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "src/lib/server/generation-recovery.postgres.test.ts", "--no-file-parallelism", "--reporter=default", "--reporter=json", `--outputFile=${report}`], {
        stdio: "inherit",
        env,
    });
    child.on("error", reject);
    child.on("exit", done);
});
await writeFile(resolve(directory, "drill.json"), JSON.stringify({ database, directory, report, exitCode: code, productionChanged: false }, null, 2));
console.log(`演练证据：${directory}`);
process.exitCode = code ?? 1;
