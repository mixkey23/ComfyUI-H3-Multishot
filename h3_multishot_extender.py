"""H3MultishotExtender - a single-node, Extender-pack-style front end for
H3MultishotMemorySampler's clip-by-clip engine.

The Motion-Context Extender pack's own MiniMaxH3Extender node is ONE node,
re-queued repeatedly, with a single `validated` toggle: OFF renders (or
re-renders) the current shot as a candidate; ON locks it in and moves to the
next one. This node reproduces that shape and that exact toggle, but does
NOT reimplement H3 sampling or Motion-Context conditioning - it is a thin
wrapper that calls H3MultishotMemorySampler.run() with the internal
_h3_candidate/_h3_candidate_confirm switches that engine already exposes for
this purpose, so every continuity mode, bank/pin/colour/gain dial, and the
disk-cache format this pack already ships stay the SAME between this node
and the chain_id-driven H3MultishotMemorySampler workflow. Two front doors,
one engine.

Chain identity defaults to the node's own ComfyUI unique_id (like Extender's
`owner_id`), so dropping this node into a graph and re-queueing it needs no
manual chain_id bookkeeping. chain_id_override is there for a caller (e.g.
Framesmith) that wants an explicit, stable id instead of relying on node-id
stability across separately-submitted API prompts.
"""
from .h3_multishot_utils import H3MultishotMemorySampler

_DROP_OPTIONAL = ("chain_id", "resume_chain", "shots_this_run")


class H3MultishotExtender:
    """MiniMaxH3Extender-style node: one node, re-queued per shot, a single
    `validated` toggle instead of chain_id/resume_chain/shots_this_run.
    regenerate_from_shot is kept (unlike those three) so the clip panel
    (web/js/h3_clip_panel.js) can redo an earlier, already-confirmed clip -
    normal use never needs to touch it by hand. Wraps
    H3MultishotMemorySampler.run()."""

    @classmethod
    def INPUT_TYPES(cls):
        base = H3MultishotMemorySampler.INPUT_TYPES()
        optional = {k: v for k, v in base["optional"].items()
                   if k not in _DROP_OPTIONAL}
        optional["chain_id_override"] = ("STRING", {
            "default": "",
            "tooltip": "Leave empty to key this chain off this NODE (its "
                       "ComfyUI id) - drop it in a graph, re-queue it "
                       "repeatedly, done. Set it to key the chain by name "
                       "instead, e.g. when an external caller (Framesmith) "
                       "wants a stable id independent of node numbering "
                       "across separately-submitted prompts."})
        required = dict(base["required"])
        required["validated"] = ("BOOLEAN", {
            "default": False,
            "label_on": "confirmed - lock in and move on",
            "label_off": "candidate - preview, retry allowed",
            "tooltip": "OFF (default): render the CURRENT shot as an "
                       "unconfirmed candidate - re-queueing with OFF still "
                       "retries this same shot, discarding the previous "
                       "attempt, and returns its frames/audio for review. "
                       "ON: lock in the current candidate (no re-render) "
                       "and advance - the NEXT queue works on the next "
                       "shot. If nothing was rendered yet for this shot, ON "
                       "renders it and locks it in immediately, same as "
                       "clicking OFF then ON without looking. Once every "
                       "shot is locked in, the master outputs are the "
                       "finished, joined chain."})
        return {"required": required, "optional": optional,
                "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO",
                          "unique_id": "UNIQUE_ID"}}

    RETURN_TYPES = H3MultishotMemorySampler.RETURN_TYPES + ("STRING",)
    RETURN_NAMES = H3MultishotMemorySampler.RETURN_NAMES + ("status",)
    OUTPUT_TOOLTIPS = H3MultishotMemorySampler.OUTPUT_TOOLTIPS + (
        "Human-readable chain status - which shot this call worked on, "
        "candidate/confirmed, and how many shots remain.",)
    FUNCTION = "extend"
    CATEGORY = "sampling/minimax"

    def extend(self, validated=False, chain_id_override="",
              regenerate_from_shot=0, unique_id=None, prompt=None,
              extra_pnginfo=None, **kw):
        from .h3_multishot_utils import (_h3_chain_manifest_path,
                                         _h3_load_manifest)

        chain_id = str(chain_id_override or "").strip()
        if not chain_id:
            chain_id = "extender_%s" % (unique_id if unique_id is not None
                                        else "default")
        regenerate_from_shot = int(regenerate_from_shot or 0)

        manifest = _h3_load_manifest(_h3_chain_manifest_path(chain_id))
        already_started = manifest is not None

        if (regenerate_from_shot <= 0 and manifest is not None
                and manifest.get("complete")):
            # Re-queueing a finished chain is a normal thing to do with a
            # single re-queued node (nothing stops someone from pressing
            # Queue once more) - H3MultishotMemorySampler's own chain_id
            # path treats that as an error (it is meant for an external
            # caller that tracks completion itself and should not need to
            # re-discover it the hard way), but this node's whole point is
            # "just keep queueing it", so hand back the already-finished
            # result instead of failing.
            import torch
            n_total = manifest.get("n_total", 0)
            master_path = manifest.get("master_path", "")
            status = ("chain complete: %s/%s shots -> %s"
                      % (n_total, n_total, master_path))
            empty_latent = {"samples": torch.zeros(0)}
            return (torch.zeros((1, 64, 64, 3), dtype=torch.half),
                    {"waveform": torch.zeros((1, 2, 1)), "sample_rate": 32000},
                    int(n_total), empty_latent, empty_latent, 0, master_path,
                    status)

        sampler = H3MultishotMemorySampler()
        result = sampler.run(
            chain_id=chain_id,
            resume_chain=already_started,
            shots_this_run=1,
            regenerate_from_shot=regenerate_from_shot,
            _h3_candidate=not bool(validated),
            _h3_candidate_confirm=bool(validated),
            prompt=prompt, extra_pnginfo=extra_pnginfo,
            **kw)

        manifest = _h3_load_manifest(_h3_chain_manifest_path(chain_id)) or {}
        n_total = manifest.get("n_total", "?")
        next_shot = manifest.get("next_shot", 0)
        pending = manifest.get("pending_candidate")
        if manifest.get("complete"):
            status = ("chain complete: %s/%s shots -> %s"
                      % (n_total, n_total, manifest.get("master_path", "")))
        elif pending:
            status = ("shot %s/%s is a CANDIDATE - set validated=True to "
                      "lock it in, or queue again to retry it"
                      % (pending, n_total))
        else:
            status = "shot %s/%s confirmed - next queue renders shot %s" % (
                next_shot, n_total, int(next_shot) + 1)
        return result + (status,)


NODE_CLASS_MAPPINGS = {"H3MultishotExtender": H3MultishotExtender}
NODE_DISPLAY_NAME_MAPPINGS = {
    "H3MultishotExtender": "H3 Multishot Extender (clip-by-clip)"}
