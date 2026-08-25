// Autogrowing socket list for H3PromptPackBridge / H3ReferencePackBridge.
//
// Both nodes declare a generous FIXED set of prompt_N/ref_N sockets on the
// Python side (INPUT_TYPES has to be static), but showing all of them at
// once would be a wall of empty sockets. This extension collapses each node
// to just its connected sockets plus exactly one free one - connect the
// free socket and the next one appears; disconnect a socket anywhere and
// the list compacts (later sockets rename down, cables intact) so removing
// shot 2 does not leave a hole that silently shifts every later shot's
// numbering.
//
// Same idea as the Motion-Context Extender pack's own prompt/reference
// bridge nodes - reimplemented here for this pack's own two node names.

import { app } from "../../scripts/app.js";

const CONFIGS = [
    { target: "H3PromptPackBridge", prefix: "prompt_", max: 64, type: "STRING" },
    { target: "H3ReferencePackBridge", prefix: "ref_", max: 9, type: "IMAGE" },
];

function slotIndex(input, prefix, max) {
    const name = String(input?.name || "");
    if (!name.startsWith(prefix)) return 0;
    const n = Number(name.slice(prefix.length));
    return Number.isInteger(n) && n >= 1 && n <= max ? n : 0;
}

function isConnected(input) {
    return input?.link !== null && input?.link !== undefined;
}

function fitNodeHeight(node) {
    try {
        const computed = node?.computeSize?.();
        const height = Number(computed?.[1]);
        const width = Number(node?.size?.[0]);
        if (Number.isFinite(height) && height > 0
            && Number.isFinite(width) && width > 0) {
            node.setSize?.([width, height]);
        }
    } catch (_e) { /* best-effort only */ }
}

function sync(node, cfg) {
    if (!node || node.__h3BridgeSyncing) return;
    node.__h3BridgeSyncing = true;
    try {
        let entries = (node.inputs || [])
            .map((input, slot) => ({ input, slot,
                                    index: slotIndex(input, cfg.prefix, cfg.max) }))
            .filter((e) => e.index > 0)
            .sort((a, b) => a.slot - b.slot);

        // Remove every disconnected socket first, back-to-front so slot
        // indices of the remaining ones stay valid while removing.
        const empty = entries.filter((e) => !isConnected(e.input))
            .sort((a, b) => b.slot - a.slot);
        for (const e of empty) {
            try { node.removeInput(e.slot); } catch (_err) { /* retried on next sync */ }
        }

        // Renumber the survivors in cable order, so disconnecting slot 2
        // turns slot 3 into slot 2 - no gap, no silent shift for the
        // sampler (which reads packed values in order, not by name).
        entries = (node.inputs || [])
            .map((input, slot) => ({ input, slot,
                                    index: slotIndex(input, cfg.prefix, cfg.max) }))
            .filter((e) => e.index > 0)
            .sort((a, b) => a.slot - b.slot);
        entries.forEach((e, i) => {
            const name = `${cfg.prefix}${i + 1}`;
            if (e.input.name !== name) {
                e.input.name = name;
                if (typeof e.input.label === "string"
                    && e.input.label.startsWith(cfg.prefix)) {
                    e.input.label = name;
                }
            }
        });

        // Exactly one free socket after the connected list.
        if (entries.length < cfg.max) {
            const nextIndex = entries.length + 1;
            const already = (node.inputs || []).some(
                (i) => slotIndex(i, cfg.prefix, cfg.max) === nextIndex);
            if (!already) {
                node.addInput(`${cfg.prefix}${nextIndex}`, cfg.type);
            }
        }

        fitNodeHeight(node);
        node.graph?.setDirtyCanvas(true, true);
    } finally {
        node.__h3BridgeSyncing = false;
    }
}

function deferSync(node, cfg) {
    if (!node || node.__h3BridgeSyncQueued) return;
    node.__h3BridgeSyncQueued = true;
    requestAnimationFrame(() => {
        node.__h3BridgeSyncQueued = false;
        sync(node, cfg);
    });
}

app.registerExtension({
    name: "h3.promptRefBridge",

    beforeRegisterNodeDef(nodeType, nodeData) {
        const cfg = CONFIGS.find((c) => c.target === nodeData?.name);
        if (!cfg) return;

        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origCreated?.apply(this, arguments);
            deferSync(this, cfg);
            return r;
        };

        const origConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = origConfigure?.apply(this, arguments);
            deferSync(this, cfg);
            return r;
        };

        const origConnectionsChange = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function () {
            const r = origConnectionsChange?.apply(this, arguments);
            deferSync(this, cfg);
            return r;
        };
    },
});
