"use client";

import { useEffect, useRef } from "react";
import { generationChangesEventUrl } from "@/services/api/generation-operations";
import { PUBLIC_SETTINGS_CHANGED_EVENT } from "@/stores/use-public-session-store";

export function useAdminGenerationChanges(records: string[], refresh: () => unknown) {
    const refreshRef = useRef(refresh);
    useEffect(() => {
        refreshRef.current = refresh;
    }, [refresh]);
    const keys = [...new Set(records)].sort().join("\n");
    useEffect(() => {
        if (!keys) return;
        let closed = false;
        let active = false;
        let pending = false;
        const reload = async () => {
            pending = true;
            if (active) return;
            active = true;
            try {
                while (pending && !closed) {
                    pending = false;
                    await refreshRef.current();
                }
            } finally {
                active = false;
            }
        };
        const changed = () => {
            void reload();
        };
        const source = new EventSource(generationChangesEventUrl(keys.split("\n")));
        source.onmessage = changed;
        window.addEventListener(PUBLIC_SETTINGS_CHANGED_EVENT, changed);
        return () => {
            closed = true;
            source.close();
            window.removeEventListener(PUBLIC_SETTINGS_CHANGED_EVENT, changed);
        };
    }, [keys]);
}
