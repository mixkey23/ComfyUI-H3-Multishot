"""Prompt/reference pack bridges: add or remove a shot's prompt, or a
reference picture, by wiring or unwiring one cable instead of editing the
script's '---' separators or rebuilding a batched IMAGE tensor by hand.

Same idea as the Motion-Context Extender pack's own Prompt/Reference Pack
Bridge nodes: a small node with a fixed but generous set of declared
sockets, presented by the FRONTEND (web/js/h3_prompt_ref_bridge.js) as an
autogrowing list - connect the last free socket and another one appears;
disconnect a socket and the list compacts so nothing later shifts by
accident. The backend only ever sees whatever is actually connected, in
cable order, with gaps skipped.

H3MultishotMemorySampler (and, through it, H3MultishotExtender) accepts
these as optional prompt_pack/reference_pack inputs: prompt_pack REPLACES
the script widget entirely when connected; reference_pack ADDS to whatever
reference_images already carries.
"""

MAX_PROMPT_SLOTS = 64          # matches shot_count's own max elsewhere
MAX_REFERENCE_SLOTS = 9        # matches H3's own <Picture 1..9> ceiling

PROMPT_PACK_TYPE = "H3_PROMPT_PACK"
REF_PACK_TYPE = "H3_REF_PACK"


class H3PromptPackBridge:
    """Pack a dynamic, ordered series of STRING prompts into one socket -
    one connected input per shot. Wire a Text/String node to prompt_1,
    another to prompt_2, and so on; the frontend keeps exactly one spare
    socket free after the last connected one."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "prompt_1": ("STRING", {
                    "forceInput": True,
                    "tooltip": "First shot's prompt. Connecting it adds "
                               "prompt_2 automatically - keep wiring to add "
                               "more shots."}),
            },
            "optional": {
                **{f"prompt_{i}": ("STRING", {
                    "forceInput": True,
                    "tooltip": "Shot %d's prompt." % i})
                   for i in range(2, MAX_PROMPT_SLOTS + 1)},
            },
        }

    RETURN_TYPES = (PROMPT_PACK_TYPE, "INT")
    RETURN_NAMES = ("prompt_pack", "shot_count")
    OUTPUT_TOOLTIPS = ("Wire into H3MultishotMemorySampler's or "
                       "H3MultishotExtender's prompt_pack input.",
                       "How many non-empty prompts were packed.")
    FUNCTION = "pack"
    CATEGORY = "sampling/minimax"

    def pack(self, prompt_1, **kw):
        values = [prompt_1] + [kw.get("prompt_%d" % i)
                               for i in range(2, MAX_PROMPT_SLOTS + 1)]
        prompts = [str(v) for v in values if v is not None and str(v).strip()]
        if not prompts:
            raise ValueError("H3PromptPackBridge: every connected prompt "
                             "was empty. Wire at least one non-empty "
                             "prompt, or disconnect prompt_pack and use "
                             "the script widget instead.")
        pack = {"type": PROMPT_PACK_TYPE, "version": 1, "prompts": prompts}
        return (pack, len(prompts))


class H3ReferencePackBridge:
    """Pack a dynamic, ordered series of IMAGE references into one socket -
    one connected input per reference picture. Adds to reference_images
    (both can be used together) in the same <Picture N> numbering the
    sampler already gives reference_images."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "optional": {
                **{f"ref_{i}": ("IMAGE", {
                    "forceInput": True,
                    "tooltip": "Reference picture %d. If a batch is "
                               "connected, only its first image is used - "
                               "wire one picture per socket." % i})
                   for i in range(1, MAX_REFERENCE_SLOTS + 1)},
            },
        }

    RETURN_TYPES = (REF_PACK_TYPE, "INT")
    RETURN_NAMES = ("reference_pack", "ref_count")
    OUTPUT_TOOLTIPS = ("Wire into H3MultishotMemorySampler's or "
                       "H3MultishotExtender's reference_pack input.",
                       "How many reference pictures were packed.")
    FUNCTION = "pack"
    CATEGORY = "sampling/minimax"

    def pack(self, **kw):
        slots = [kw.get("ref_%d" % i)
                 for i in range(1, MAX_REFERENCE_SLOTS + 1)]
        count = sum(1 for s in slots if s is not None)
        pack = {"type": REF_PACK_TYPE, "version": 1, "slots": slots}
        return (pack, count)


NODE_CLASS_MAPPINGS = {
    "H3PromptPackBridge": H3PromptPackBridge,
    "H3ReferencePackBridge": H3ReferencePackBridge,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "H3PromptPackBridge": "H3 Prompt Pack Bridge (add/remove shots)",
    "H3ReferencePackBridge": "H3 Reference Pack Bridge (add/remove refs)",
}
