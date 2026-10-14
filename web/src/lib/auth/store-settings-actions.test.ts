import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS } from "./store-foundation";

const mocks = vi.hoisted(() => ({
    postgresEnabled: true,
    readAuthDb: vi.fn(),
    readPostgresAuthSettings: vi.fn(),
    updatePostgresAuthSettings: vi.fn(),
}));

vi.mock("@/lib/server/database", () => ({ isPostgresDatabaseEnabled: vi.fn(() => mocks.postgresEnabled) }));
vi.mock("./postgres-auth-settings-service", () => ({ updatePostgresAuthSettings: mocks.updatePostgresAuthSettings }));
vi.mock("./store-repository", () => ({
    mutateAuthDb: vi.fn(),
    readAuthDb: mocks.readAuthDb,
    readPostgresAuthSettings: mocks.readPostgresAuthSettings,
}));

import { getAuthSettings, getFreshAuthSettings, setAuthSettings } from "./store-settings-actions";

describe("auth settings cache", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.postgresEnabled = true;
    });

    it("bypasses a warm PostgreSQL cache and replaces it with the latest settings", async () => {
        const cached = structuredClone(DEFAULT_SETTINGS);
        cached.dataLifecycle.maintenanceBatchSize = 100;
        const fresh = structuredClone(DEFAULT_SETTINGS);
        fresh.dataLifecycle.maintenanceBatchSize = 101;
        mocks.readPostgresAuthSettings.mockResolvedValueOnce(cached).mockResolvedValueOnce(fresh);

        await expect(getAuthSettings()).resolves.toEqual(cached);
        await expect(getAuthSettings()).resolves.toEqual(cached);
        expect(mocks.readPostgresAuthSettings).toHaveBeenCalledTimes(1);

        await expect(getFreshAuthSettings()).resolves.toEqual(fresh);
        await expect(getAuthSettings()).resolves.toEqual(fresh);
        expect(mocks.readPostgresAuthSettings).toHaveBeenCalledTimes(2);
    });

    it("does not let an older in-flight read overwrite a completed save", async () => {
        const a = structuredClone(DEFAULT_SETTINGS);
        const b = { ...structuredClone(DEFAULT_SETTINGS), freeDailyPoints: 123.5 };
        mocks.readPostgresAuthSettings.mockResolvedValueOnce(a);
        await getFreshAuthSettings();
        let finishRead!: (settings: typeof a) => void;
        mocks.readPostgresAuthSettings.mockImplementationOnce(
            () =>
                new Promise((done) => {
                    finishRead = done;
                }),
        );
        const slow = getFreshAuthSettings();
        mocks.updatePostgresAuthSettings.mockResolvedValueOnce(b);
        await setAuthSettings({ freeDailyPoints: b.freeDailyPoints });
        finishRead(a);
        await expect(slow).resolves.toEqual(b);
        await expect(getAuthSettings()).resolves.toEqual(b);
    });
});
