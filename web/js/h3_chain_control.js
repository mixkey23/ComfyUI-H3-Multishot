// Clip-by-clip chain control for H3MultishotMemorySampler.
//
// The node's own chain_id/resume_chain/shots_this_run/regenerate_from_shot
// widgets are enough to drive a chain by hand, but doing that by hand is
// exactly the kind of toggling this widget exists to automate for testing
// INSIDE ComfyUI, before wiring the same three calls up from an external
// caller (Framesmith): "does this chain already have saved state?" decides
// resume_chain, and the three buttons below just set the right widget
// values and queue the graph - the same graph, run again, same as a person
// clicking Queue Prompt repeatedly, just with the bookkeeping done for you.
//
// State lives entirely on the PYTHON side (h3_multishot_utils.py writes
// chain_multishot_<chain_id>.json - see _h3_chain_manifest_path). This
// widget only ever READS that file, via the GET /h3multishot/chain_state
// route registered by h3_multishot_chain_api.py. It never writes chain
// state itself.

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const TARGET = "H3MultishotMemorySampler";
const POLL_MS = 4000;

function findWidget(node, name) {
    return node.widgets?.find((w) => w.name === name);
}

function setWidget(node, name, value) {
    const w = findWidget(node, name);
    if (!w) return;
    w.value = value;
    w.callback?.(value);
}

async function fetchChainState(chainId) {
    const res = await api.fetchApi(
        `/h3multishot/chain_state?chain_id=${encodeURIComponent(chainId)}`);
    if (!res.ok) {
        throw new Error(`chain_state request failed (${res.status})`);
    }
    return res.json();
}

function summarize(data) {
    if (!data) return "chain: -";
    if (data.error) return `chain: error - ${data.error}`;
    if (!data.exists) return "chain: not started yet";
    const done = data.next_shot ?? 0;
    const total = data.n_total ?? "?";
    if (data.complete) {
        return `chain: complete (${total}/${total})` +
            (data.master_path ? ` -> ${data.master_path}` : "");
    }
    return `chain: ${done}/${total} rendered, next shot ${done + 1}`;
}

app.registerExtension({
    name: "h3.chainControl",

    nodeCreated(node) {
        if (node.comfyClass !== TARGET) return;

        const status = node.addWidget("text", "chain_status", "chain: -",
            () => {});
        status.disabled = true;
        status.serialize = false;   // display-only, never saved into the graph

        const refresh = async () => {
            const idWidget = findWidget(node, "chain_id");
            const chainId = String(idWidget?.value || "").trim();
            if (!chainId) {
                status.value = "chain: - (set chain_id to enable)";
                node.setDirtyCanvas?.(true, true);
                return null;
            }
            try {
                const data = await fetchChainState(chainId);
                status.value = summarize(data);
                node.setDirtyCanvas?.(true, true);
                return data;
            } catch (e) {
                status.value = `chain: request failed (${e.message ?? e})`;
                node.setDirtyCanvas?.(true, true);
                return null;
            }
        };

        // Poll while the node is on the canvas. Cleared on node removal so
        // a deleted node does not keep polling forever in the background.
        const timer = setInterval(refresh, POLL_MS);
        const origRemoved = node.onRemoved;
        node.onRemoved = function () {
            clearInterval(timer);
            origRemoved?.apply(this, arguments);
        };
        refresh();

        const queueOne = async (shotsThisRun, regenerateFrom, label) => {
            const idWidget = findWidget(node, "chain_id");
            const chainId = String(idWidget?.value || "").trim();
            if (!chainId) {
                alert("Set chain_id on this node first.");
                return;
            }
            const data = await refresh();
            if (regenerateFrom > 0 && !(data && data.exists)) {
                alert(`chain_id "${chainId}" has no saved state yet - `
                    + "nothing to regenerate. Use ▶ Next shot first.");
                return;
            }
            const resuming = !!(data && data.exists && !data.complete);
            if (data && data.exists && data.complete && regenerateFrom === 0) {
                if (!confirm(`chain_id "${chainId}" already finished. `
                    + "Queuing again will error unless you set "
                    + "regenerate_from_shot yourself. Queue anyway?")) {
                    return;
                }
            }
            setWidget(node, "resume_chain", resuming || regenerateFrom > 0);
            setWidget(node, "shots_this_run", shotsThisRun);
            setWidget(node, "regenerate_from_shot", regenerateFrom);
            status.value = `chain: queuing (${label})...`;
            node.setDirtyCanvas?.(true, true);
            await app.queuePrompt(0);
            setTimeout(refresh, 1500);
        };

        node.addWidget("button", "▶ Next shot (clip-by-clip)", null,
            () => queueOne(1, 0, "next shot"));
        node.addWidget("button", "⏩ Render rest (batch)", null,
            () => queueOne(0, 0, "batch"));
        node.addWidget("button", "↺ Regenerate shot...", null,
            () => {
                const n = prompt(
                    "Redo which shot? (1-based; discards its saved state "
                    + "and everything after it)");
                if (!n) return;
                const idx = parseInt(n, 10);
                if (!Number.isInteger(idx) || idx < 1) {
                    alert("Enter a shot number, 1 or higher.");
                    return;
                }
                queueOne(1, idx, `regenerate shot ${idx}`);
            });
    },
});
