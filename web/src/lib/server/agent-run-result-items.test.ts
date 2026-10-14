import { describe, expect, it } from "vitest";

import { agentTaskResultItems } from "./agent-run-result-items";

describe("agentTaskResultItems", () => {
    it("flattens nested batch responses without losing result order", () => {
        expect(
            agentTaskResultItems({
                results: [{ results: [{ url: "one" }, { url: "two" }] }, { outputs: [{ url: "three" }] }],
            }),
        ).toEqual([{ url: "one" }, { url: "two" }, { url: "three" }]);
    });

    it("retains all successful batch outputs without an arbitrary output cap", () => {
        expect(agentTaskResultItems({ images: Array.from({ length: 20 }, (_, index) => ({ url: String(index) })) })).toHaveLength(20);
    });

    it("handles deep wrappers and cycles without recursive stack growth", () => {
        let nested: Record<string, unknown> = { url: "deep.png" };
        for (let index = 0; index < 20_000; index += 1) nested = { result: nested };
        expect(agentTaskResultItems(nested)).toEqual([{ url: "deep.png" }]);
        const cycle: Record<string, unknown> = {};
        cycle.result = cycle;
        expect(agentTaskResultItems({ results: [cycle, { url: "valid.png" }] })).toEqual([{ url: "valid.png" }]);
    });

    it("normalizes provider wrappers and alternative media list keys", () => {
        expect(agentTaskResultItems({ task: { result: { data: { videos: [{ url: "one.mp4" }, { url: "two.mp4" }] } } } })).toEqual([{ url: "one.mp4" }, { url: "two.mp4" }]);
        expect(agentTaskResultItems({ output: { assets: [{ url: "one.png" }] } })).toEqual([{ url: "one.png" }]);
    });
});
