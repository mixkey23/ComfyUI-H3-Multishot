// Clip-by-clip visual panel for H3MultishotMemorySampler (chain_id) and
// H3MultishotExtender - card-per-shot editing, a reference picture grid,
// and Save/Load Project, in the spirit of the Motion-Context Extender
// pack's own node panel.
//
// This is a SEPARATE dom widget added below the node's normal widgets
// (chain_id/validated/etc. stay exactly as they are - this panel reads and
// writes them, it does not replace them). Everything it shows is derived
// from state that already exists:
//   - the clip list comes from the `script` widget ('---'-separated), or
//     is read-only when prompt_pack is wired (the bridge node owns it then)
//   - the reference grid mixes the `reference_uploads` widget (JSON array
//     of filenames this panel manages, uploaded via ComfyUI's own
//     /upload/image - the same route LoadImage uses) with a live count from
//     reference_pack/reference_images if wired
//   - validated/next/pending per clip comes from the SAME chain manifest
//     h3_chain_control.js already polls (GET /h3multishot/chain_state):
//     shot i is validated iff i < next_shot, "next" iff i === next_shot
//   - Save/Load Project is a plain client-side JSON export/import of the
//     script, reference_uploads and chain id - no new backend endpoint,
//     since none of that needs the server to leave the browser tab.
//
// Checking "Validated" on the NEXT card queues a render+confirm (mirrors
// H3MultishotExtender's validated=True, or H3MultishotMemorySampler's
// chain_id resume with shots_this_run=1). Unchecking it on an ALREADY
// validated card queues a regenerate_from_shot for that index, after
// confirming - unvalidating cascades (every later clip is discarded too),
// the same rule the Extender pack's own panel enforces.

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const MEMORY_SAMPLER = "H3MultishotMemorySampler";
const EXTENDER = "H3MultishotExtender";
const MAX_REFS = 9;
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
function widgetValue(node, name, fallback) {
    const w = findWidget(node, name);
    return w ? w.value : fallback;
}
function isInputConnected(node, name) {
    // prompt_pack/reference_pack are SOCKET-ONLY custom types (H3_PROMPT_
    // PACK/H3_REF_PACK) - they never appear in node.widgets, only in
    // node.inputs, unlike every widget this file otherwise reads/writes.
    const input = node.inputs?.find((i) => i.name === name);
    return !!(input && input.link !== null && input.link !== undefined);
}

function parseShots(scriptText) {
    const parts = String(scriptText || "").split(/\n?---\n?/)
        .map((s) => s.trim());
    return parts.length ? parts : [""];
}
function joinShots(shots) {
    return shots.map((s) => s.trim()).join("\n---\n");
}
function parseRefUploads(node) {
    try {
        const arr = JSON.parse(String(widgetValue(node, "reference_uploads", "[]")));
        return Array.isArray(arr) ? arr : [];
    } catch (_e) {
        return [];
    }
}
function setRefUploads(node, arr) {
    setWidget(node, "reference_uploads", JSON.stringify(arr));
}

async function fetchChainState(chainId) {
    if (!chainId) return null;
    try {
        const res = await api.fetchApi(
            `/h3multishot/chain_state?chain_id=${encodeURIComponent(chainId)}`);
        if (!res.ok) return null;
        return await res.json();
    } catch (_e) {
        return null;
    }
}

async function uploadImage(file) {
    const fd = new FormData();
    fd.append("image", file);
    fd.append("type", "input");
    fd.append("overwrite", "false");
    const res = await api.fetchApi("/upload/image", { method: "POST", body: fd });
    if (!res.ok) throw new Error(`upload failed (HTTP ${res.status})`);
    const payload = await res.json();
    return payload.subfolder ? `${payload.subfolder}/${payload.name}` : payload.name;
}

function imageUrl(filename) {
    const [subfolder, name] = filename.includes("/")
        ? [filename.slice(0, filename.lastIndexOf("/")), filename.slice(filename.lastIndexOf("/") + 1)]
        : ["", filename];
    return api.apiURL(`/view?filename=${encodeURIComponent(name)}`
        + `&subfolder=${encodeURIComponent(subfolder)}&type=input`);
}

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
}

function ensureStyles() {
    if (document.getElementById("h3cp-style")) return;
    const style = document.createElement("style");
    style.id = "h3cp-style";
    style.textContent = `
.h3cp { display: flex; flex-direction: column; gap: 6px; width: 100%;
  font-size: 11px; color: var(--input-text, #ddd); }
.h3cp-header { display: flex; justify-content: space-between; opacity: .8; }
.h3cp-toolbar { display: flex; gap: 6px; flex-wrap: wrap; }
.h3cp-toolbar button, .h3cp-card-head button { font-size: 10px; padding: 3px 8px;
  border-radius: 4px; border: 1px solid rgba(255,255,255,.2);
  background: rgba(255,255,255,.06); color: inherit; cursor: pointer; }
.h3cp-toolbar button:hover, .h3cp-card-head button:hover { background: rgba(255,255,255,.14); }
.h3cp-refs-label { opacity: .6; text-transform: uppercase; font-size: 9px; letter-spacing: .04em; }
.h3cp-refs-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(64px, 1fr));
  gap: 6px; }
.h3cp-ref-cell { position: relative; aspect-ratio: 1; border: 1px dashed rgba(255,255,255,.25);
  border-radius: 4px; display: flex; align-items: center; justify-content: center;
  cursor: pointer; overflow: hidden; background: rgba(255,255,255,.04); }
.h3cp-ref-cell img { width: 100%; height: 100%; object-fit: cover; display: block; }
.h3cp-ref-cell .h3cp-ref-x { position: absolute; top: 2px; right: 2px; width: 16px; height: 16px;
  border-radius: 50%; background: rgba(0,0,0,.6); color: #fff; font-size: 10px; line-height: 16px;
  text-align: center; }
.h3cp-ref-label { position: absolute; bottom: 2px; left: 3px; font-size: 8px; opacity: .8;
  text-shadow: 0 0 3px #000; }
.h3cp-clips { display: flex; flex-direction: column; gap: 6px; max-height: 480px; overflow-y: auto; }
.h3cp-card { border: 1px solid rgba(255,255,255,.15); border-radius: 6px; padding: 6px; }
.h3cp-card.is-validated { border-color: #3ecf6c; }
.h3cp-card.is-next { border-color: #4a90d9; }
.h3cp-card-head { display: flex; justify-content: space-between; align-items: center;
  gap: 6px; margin-bottom: 4px; }
.h3cp-badge { font-size: 9px; padding: 1px 6px; border-radius: 8px; opacity: .85; }
.h3cp-badge.is-validated { background: #235c37; }
.h3cp-badge.is-next { background: #234a68; }
.h3cp-badge.is-pending { background: rgba(255,255,255,.08); }
.h3cp-prompt { width: 100%; box-sizing: border-box; min-height: 54px; resize: vertical;
  background: rgba(0,0,0,.25); color: inherit; border: 1px solid rgba(255,255,255,.12);
  border-radius: 4px; font-family: inherit; font-size: 10px; padding: 4px; }
.h3cp-card-foot { display: flex; justify-content: space-between; align-items: center;
  margin-top: 4px; opacity: .85; }
.h3cp-card-foot label { display: flex; align-items: center; gap: 3px; cursor: pointer; }
`;
    document.head.appendChild(style);
}

function fileInput(accept, onFile) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.style.display = "none";
    input.addEventListener("change", () => {
        if (input.files && input.files[0]) onFile(input.files[0]);
        input.value = "";
    });
    document.body.appendChild(input);
    return input;
}

// --- per-node-type adapter: resolves chain id and knows how to queue a
// confirm/candidate/regenerate action for that node's own widget set -----

function memorySamplerAdapter(node) {
    return {
        getChainId: () => String(widgetValue(node, "chain_id", "")).trim(),
        scriptEditable: () => !isInputConnected(node, "prompt_pack"),
        async queueShot({ regenerateFrom, asCandidate }) {
            const chainId = this.getChainId();
            if (!chainId) { alert("Set chain_id on this node first."); return; }
            const state = await fetchChainState(chainId);
            const exists = !!(state && state.exists);
            setWidget(node, "resume_chain", exists);
            setWidget(node, "shots_this_run", 1);
            setWidget(node, "regenerate_from_shot", regenerateFrom || 0);
            // asCandidate has no direct equivalent on this node - chain_id
            // mode always confirms immediately. Use H3MultishotExtender
            // for a candidate-then-confirm workflow.
            await app.queuePrompt(0);
        },
    };
}

function extenderAdapter(node) {
    return {
        getChainId: () => {
            const override = String(widgetValue(node, "chain_id_override", "")).trim();
            return override || `extender_${node.id}`;
        },
        scriptEditable: () => !isInputConnected(node, "prompt_pack"),
        async queueShot({ regenerateFrom, asCandidate }) {
            setWidget(node, "regenerate_from_shot", regenerateFrom || 0);
            // Regenerating always starts as a candidate (validated=false),
            // regardless of asCandidate - re-check the box once you like
            // what you see to confirm it, same as any other candidate.
            setWidget(node, "validated", regenerateFrom ? false : !asCandidate);
            await app.queuePrompt(0);
        },
    };
}

function buildPanel(node, adapter) {
    ensureStyles();
    const root = el("div", "h3cp");

    const header = el("div", "h3cp-header");
    const statusEl = el("span", null, "chain: -");
    const countsEl = el("span", null, "");
    header.append(statusEl, countsEl);

    const toolbar = el("div", "h3cp-toolbar");
    const addBtn = el("button", null, "+ Add Clip");
    const removeBtn = el("button", null, "− Remove Last");
    const saveBtn = el("button", null, "Save Project");
    const loadBtn = el("button", null, "Load Project");
    toolbar.append(addBtn, removeBtn, saveBtn, loadBtn);

    const refsLabel = el("div", "h3cp-refs-label",
        "Reference images — click a slot to set/replace");
    const refsGrid = el("div", "h3cp-refs-grid");

    const clipsEl = el("div", "h3cp-clips");

    root.append(header, toolbar, refsLabel, refsGrid, clipsEl);

    const loadProjectInput = fileInput(".json", async (file) => {
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            if (typeof data.script === "string") setWidget(node, "script", data.script);
            if (Array.isArray(data.reference_uploads)) setRefUploads(node, data.reference_uploads);
            if (typeof data.chain_id === "string") setWidget(node, "chain_id", data.chain_id);
            if (typeof data.chain_id_override === "string") {
                setWidget(node, "chain_id_override", data.chain_id_override);
            }
            renderStructure();
        } catch (e) {
            alert(`Load Project failed: ${e.message ?? e}`);
        }
    });

    saveBtn.addEventListener("click", () => {
        const data = {
            script: widgetValue(node, "script", ""),
            reference_uploads: parseRefUploads(node),
            chain_id: widgetValue(node, "chain_id", undefined),
            chain_id_override: widgetValue(node, "chain_id_override", undefined),
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `h3_clip_project_${Date.now()}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
    });
    loadBtn.addEventListener("click", () => loadProjectInput.click());

    addBtn.addEventListener("click", () => {
        if (!adapter.scriptEditable()) {
            alert("script is driven by prompt_pack - add a shot by wiring "
                + "another Text node into H3PromptPackBridge instead.");
            return;
        }
        const shots = parseShots(widgetValue(node, "script", ""));
        shots.push("");
        setWidget(node, "script", joinShots(shots));
        renderStructure();
    });
    removeBtn.addEventListener("click", () => {
        if (!adapter.scriptEditable()) {
            alert("script is driven by prompt_pack - remove a shot by "
                + "unwiring its Text node from H3PromptPackBridge instead.");
            return;
        }
        const shots = parseShots(widgetValue(node, "script", ""));
        if (shots.length <= 1) return;
        shots.pop();
        setWidget(node, "script", joinShots(shots));
        renderStructure();
    });

    let editingIndex = null;
    let lastState = null;

    function refCell(index) {
        const uploads = parseRefUploads(node);
        const filename = uploads[index];
        const cell = el("div", "h3cp-ref-cell");
        if (filename) {
            const img = document.createElement("img");
            img.src = imageUrl(filename);
            const label = el("span", "h3cp-ref-label", `Ref ${index + 1}`);
            const x = el("span", "h3cp-ref-x", "×");
            x.title = "Remove";
            x.addEventListener("click", (ev) => {
                ev.stopPropagation();
                const next = parseRefUploads(node);
                next[index] = null;
                setRefUploads(node, next.filter((v) => v));
                renderStructure();
            });
            cell.append(img, label, x);
        } else {
            cell.append(el("span", null, `+ Ref ${index + 1}`));
        }
        cell.addEventListener("click", () => {
            const picker = fileInput("image/*", async (file) => {
                try {
                    const name = await uploadImage(file);
                    const next = parseRefUploads(node);
                    next[index] = name;
                    setRefUploads(node, next);
                    renderStructure();
                } catch (e) {
                    alert(`Reference upload failed: ${e.message ?? e}`);
                } finally {
                    picker.remove();
                }
            });
            picker.click();
        });
        return cell;
    }

    function clipCard(index, text, total, nextIndex) {
        const isValidated = index < nextIndex;
        const isNext = index === nextIndex;
        const card = el("div", "h3cp-card"
            + (isValidated ? " is-validated" : "")
            + (isNext ? " is-next" : ""));

        const head = el("div", "h3cp-card-head");
        head.append(el("span", null, `Clip ${index + 1}/${total}`));
        const badge = el("span", "h3cp-badge"
            + (isValidated ? " is-validated" : isNext ? " is-next" : " is-pending"),
            isValidated ? "VALIDATED" : isNext ? "NEXT" : "pending");
        head.append(badge);
        card.append(head);

        const textarea = document.createElement("textarea");
        textarea.className = "h3cp-prompt";
        textarea.value = text;
        textarea.readOnly = !adapter.scriptEditable();
        textarea.addEventListener("focus", () => { editingIndex = index; });
        textarea.addEventListener("blur", () => {
            editingIndex = null;
            const shots = parseShots(widgetValue(node, "script", ""));
            shots[index] = textarea.value;
            setWidget(node, "script", joinShots(shots));
        });
        card.append(textarea);

        const foot = el("div", "h3cp-card-foot");
        const baseSeed = Number(widgetValue(node, "seed", 0)) || 0;
        const perShot = !!widgetValue(node, "seed_per_shot", true);
        const shotSeed = perShot ? baseSeed + index : baseSeed;
        const frames = Number(widgetValue(node, "frames_per_shot", 0)) || 0;
        foot.append(el("span", null, `seed ${shotSeed}`));
        foot.append(el("span", null, `${(frames / 24).toFixed(2)}s`));

        const label = document.createElement("label");
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = isValidated;
        checkbox.disabled = index > nextIndex;
        checkbox.addEventListener("change", async () => {
            if (checkbox.checked && isNext) {
                await adapter.queueShot({ regenerateFrom: 0, asCandidate: false });
            } else if (!checkbox.checked && isValidated) {
                if (!confirm(`Redo clip ${index + 1}? This discards it and `
                    + `every clip after it.`)) {
                    checkbox.checked = true;
                    return;
                }
                await adapter.queueShot({ regenerateFrom: index + 1, asCandidate: false });
            } else {
                checkbox.checked = isValidated;
            }
        });
        label.append(checkbox, document.createTextNode(" Validated"));
        foot.append(label);
        card.append(foot);

        if (isNext) {
            const previewBtn = el("button", null, "👁 Preview (don't confirm)");
            previewBtn.addEventListener("click",
                () => adapter.queueShot({ regenerateFrom: 0, asCandidate: true }));
            card.append(previewBtn);
        }

        return card;
    }

    function renderStructure() {
        if (editingIndex !== null) return;   // don't yank focus mid-edit
        const shots = parseShots(widgetValue(node, "script", ""));
        const nextIndex = lastState?.next_shot ?? 0;

        refsGrid.replaceChildren(...Array.from({ length: MAX_REFS },
            (_v, i) => refCell(i)));
        clipsEl.replaceChildren(...shots.map((text, i) =>
            clipCard(i, text, shots.length, nextIndex)));
        const refCount = parseRefUploads(node).filter(Boolean).length;
        countsEl.textContent = `${shots.length} clip(s) • ${refCount} ref(s)`;
    }

    function renderStatus(state) {
        lastState = state;
        if (!state) { statusEl.textContent = "chain: -"; return; }
        if (state.error) { statusEl.textContent = `chain: error - ${state.error}`; return; }
        if (!state.exists) { statusEl.textContent = "chain: not started yet"; return; }
        if (state.complete) {
            statusEl.textContent = `chain: complete (${state.n_total}/${state.n_total})`;
        } else {
            statusEl.textContent = `chain: ${state.next_shot}/${state.n_total} `
                + `validated, next is clip ${state.next_shot + 1}`;
        }
        // badges/checkboxes can go stale between structural rebuilds - a
        // light pass over existing cards keeps them honest without
        // touching (and losing focus/selection in) the textareas.
        const cards = clipsEl.querySelectorAll(".h3cp-card");
        cards.forEach((card, i) => {
            const isValidated = i < (state.next_shot ?? 0);
            const isNext = i === (state.next_shot ?? 0);
            card.classList.toggle("is-validated", isValidated);
            card.classList.toggle("is-next", isNext);
            const badge = card.querySelector(".h3cp-badge");
            if (badge) {
                badge.textContent = isValidated ? "VALIDATED" : isNext ? "NEXT" : "pending";
                badge.className = "h3cp-badge"
                    + (isValidated ? " is-validated" : isNext ? " is-next" : " is-pending");
            }
            const checkbox = card.querySelector('input[type="checkbox"]');
            if (checkbox && document.activeElement !== checkbox) {
                checkbox.checked = isValidated;
                checkbox.disabled = i > (state.next_shot ?? 0);
            }
        });
    }

    async function poll() {
        const state = await fetchChainState(adapter.getChainId());
        const structureStale = !lastState
            || lastState.next_shot !== state?.next_shot
            || lastState.exists !== state?.exists;
        renderStatus(state);
        if (structureStale) renderStructure();
    }

    renderStructure();
    poll();
    const timer = setInterval(poll, POLL_MS);
    const origRemoved = node.onRemoved;
    node.onRemoved = function () {
        clearInterval(timer);
        loadProjectInput.remove();
        origRemoved?.apply(this, arguments);
    };

    return root;
}

function attachPanel(node, adapter) {
    if (typeof node.addDOMWidget !== "function") {
        console.warn("[H3-Multishot] clip panel needs addDOMWidget support "
            + "- skipping (native chain controls still work).");
        return;
    }
    try {
        const root = buildPanel(node, adapter);
        node.addDOMWidget("h3_clip_panel", "H3ClipPanel", root, { serialize: false });
    } catch (e) {
        console.warn("[H3-Multishot] clip panel failed to attach.", e);
    }
}

app.registerExtension({
    name: "h3.clipPanel",

    nodeCreated(node) {
        if (node.comfyClass === MEMORY_SAMPLER) {
            attachPanel(node, memorySamplerAdapter(node));
        } else if (node.comfyClass === EXTENDER) {
            attachPanel(node, extenderAdapter(node));
        }
    },
});
