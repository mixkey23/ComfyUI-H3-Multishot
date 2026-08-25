// Clip-by-clip chain control for the two chain_id-driven nodes.
//
// H3MultishotMemorySampler: chain_id/resume_chain/shots_this_run/
// regenerate_from_shot are enough to drive a chain by hand, but doing that
// by hand is exactly the kind of toggling this widget exists to automate
// for testing INSIDE ComfyUI, before wiring the same calls up from an
// external caller (Framesmith): "does this chain already have saved
// state?" decides resume_chain, and the buttons just set the right widget
// values and queue the graph - the same graph, run again, same as a person
// clicking Queue Prompt repeatedly, just with the bookkeeping done for you.
//
// H3MultishotExtender: a single `validated` toggle instead of four widgets
// (see h3_multishot_extender.py), so it only needs a status readout - no
// buttons to automate, since "queue again" already IS the whole control.
//
// State lives entirely on the PYTHON side (h3_multishot_utils.py writes
// chain_multishot_<chain_id>.json - see _h3_chain_manifest_path). This
// widget only ever READS that file, via the GET /h3multishot/chain_state
// route registered by h3_multishot_chain_api.py. It never writes chain
// state itself.

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const MEMORY_SAMPLER = "H3MultishotMemorySampler";
const EXTENDER = "H3MultishotExtender";
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
    if (data.pending_candidate) {
        return `chain: shot ${data.pending_candidate}/${total} is a ` +
            `CANDIDATE - toggle validated to lock it in`;
    }
    return `chain: ${done}/${total} rendered, next shot ${done + 1}`;
}

function addStatusWidget(node) {
    const status = node.addWidget("text", "chain_status", "chain: -",
        () => {});
    status.disabled = true;
    status.serialize = false;   // display-only, never saved into the graph
    return status;
}

function pollWhileAlive(node, refresh) {
    const timer = setInterval(refresh, POLL_MS);
    const origRemoved = node.onRemoved;
    node.onRemoved = function () {
        clearInterval(timer);
        origRemoved?.apply(this, arguments);
    };
    refresh();
}

// Per-shot saturation/contrast/brightness, baked in only at export time
// (h3_stream_master.py:_apply_color_adjustment). The live preview below is
// a real DOM <img> (node.addDOMWidget), not ComfyUI's own canvas-drawn node
// preview - that one is drawn via ctx.drawImage internals that vary across
// frontend versions and are not a stable target for a CSS filter. This
// <img> is entirely this extension's own, fetched from GET /h3multishot/
// shot_preview (always the NEUTRAL frame - the cached shot is never
// adjusted in place) and styled with `filter: saturate() contrast()
// brightness()`, the SAME CSS transform model _apply_color_adjustment
// bakes in server-side, so what you see here is what Re-export produces.
function addColorEditor(node, getChainId) {
    const img = document.createElement("img");
    img.style.width = "100%";
    img.style.display = "block";
    img.style.imageRendering = "pixelated";
    img.alt = "shot preview (set chain_id and render/confirm a shot)";

    let previewWidget = null;
    if (typeof node.addDOMWidget === "function") {
        try {
            previewWidget = node.addDOMWidget(
                "color_preview", "H3ColorPreview", img, { serialize: false });
        } catch (e) {
            console.warn("[H3-Multishot] color preview DOM widget failed "
                + "to attach - sliders/Save/Re-export still work.", e);
        }
    }

    const shotWidget = node.addWidget("number", "color_shot", 1,
        () => { refreshPreviewImage(); }, { min: 1, max: 9999, step: 10, precision: 0 });
    shotWidget.tooltip = "Which shot (1-based) the sliders below edit.";
    const applyFilter = () => {
        img.style.filter = `saturate(${satWidget.value}%) `
            + `contrast(${conWidget.value}%) brightness(${briWidget.value}%)`;
    };
    const satWidget = node.addWidget("slider", "color_saturation", 100,
        applyFilter, { min: 0, max: 200 });
    const conWidget = node.addWidget("slider", "color_contrast", 100,
        applyFilter, { min: 50, max: 150 });
    const briWidget = node.addWidget("slider", "color_brightness", 100,
        applyFilter, { min: 50, max: 150 });
    for (const w of [shotWidget, satWidget, conWidget, briWidget]) {
        w.serialize = false;   // per-shot editing state, not part of the graph
    }
    applyFilter();

    // Always re-fetches (no change-guard): a regenerated shot keeps the
    // same chain_id/shot_index but its underlying pixels changed, so
    // "nothing looks different about the request" cannot be the signal to
    // skip it. The fetched PNG is a single small middle-frame image, so
    // re-fetching on every poll tick is cheap.
    const refreshPreviewImage = () => {
        const chainId = getChainId();
        const shotIndex = Math.max(0, Math.round(shotWidget.value) - 1);
        if (!chainId) {
            img.removeAttribute("src");
            return;
        }
        const url = api.apiURL(
            `/h3multishot/shot_preview?chain_id=${encodeURIComponent(chainId)}`
            + `&shot_index=${shotIndex}&t=${Date.now()}`);
        img.onerror = () => { img.removeAttribute("src"); };
        img.src = url;
    };

    node.addWidget("button", "🎨 Save color for shot", null, async () => {
        const chainId = getChainId();
        if (!chainId) { alert("No chain_id yet - render at least shot 1 first."); return; }
        try {
            const res = await api.fetchApi("/h3multishot/color_adjust", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    chain_id: chainId,
                    shot_index: Math.max(0, Math.round(shotWidget.value) - 1),
                    adjustment: { saturation: satWidget.value,
                                 contrast: conWidget.value,
                                 brightness: briWidget.value },
                }),
            });
            const payload = await res.json();
            if (!res.ok || payload.error) {
                throw new Error(payload.error || `HTTP ${res.status}`);
            }
        } catch (e) {
            alert(`Save color failed: ${e.message ?? e}`);
        }
    });

    node.addWidget("button", "📤 Re-export master (no re-render)", null,
        async () => {
            const chainId = getChainId();
            if (!chainId) { alert("No chain_id yet."); return; }
            try {
                const res = await api.fetchApi("/h3multishot/reexport", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ chain_id: chainId }),
                });
                const payload = await res.json();
                if (!res.ok || payload.error) {
                    throw new Error(payload.error || `HTTP ${res.status}`);
                }
                alert(`Re-exported: ${payload.master_path}`);
            } catch (e) {
                alert(`Re-export failed: ${e.message ?? e}`);
            }
        });

    // Picks up a newly rendered/confirmed shot automatically (once its
    // state file exists) and a chain_id typed in after node creation.
    // Cheap: only actually re-fetches when chain_id/shot_index changed
    // since the last check (see the `key`/`lastFetchedKey` guard above).
    refreshPreviewImage();
    pollWhileAlive(node, refreshPreviewImage);
}

function setupMemorySampler(node) {
    const status = addStatusWidget(node);

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
    pollWhileAlive(node, refresh);

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

    addColorEditor(node, () => {
        const idWidget = findWidget(node, "chain_id");
        return String(idWidget?.value || "").trim();
    });
}

function setupExtender(node) {
    // Mirrors the Python side's own fallback: chain_id_override if set,
    // else "extender_<this node's id>" (h3_multishot_extender.py's
    // `unique_id` is exactly this node's ComfyUI id).
    const status = addStatusWidget(node);

    const refresh = async () => {
        const overrideWidget = findWidget(node, "chain_id_override");
        const override = String(overrideWidget?.value || "").trim();
        const chainId = override || `extender_${node.id}`;
        try {
            const data = await fetchChainState(chainId);
            status.value = summarize(data);
            node.setDirtyCanvas?.(true, true);
        } catch (e) {
            status.value = `chain: request failed (${e.message ?? e})`;
            node.setDirtyCanvas?.(true, true);
        }
    };
    pollWhileAlive(node, refresh);

    addColorEditor(node, () => {
        const overrideWidget = findWidget(node, "chain_id_override");
        const override = String(overrideWidget?.value || "").trim();
        return override || `extender_${node.id}`;
    });
}

app.registerExtension({
    name: "h3.chainControl",

    nodeCreated(node) {
        if (node.comfyClass === MEMORY_SAMPLER) setupMemorySampler(node);
        else if (node.comfyClass === EXTENDER) setupExtender(node);
    },
});
