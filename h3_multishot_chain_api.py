"""HTTP surface for chain_id/resume_chain clip-by-clip chains: status,
per-shot colour correction, and re-export.

H3MultishotMemorySampler already writes a plain-JSON manifest per chain
(chain_multishot_<chain_id>.json under output/video/H3CHAIN_STATE/ - see
_h3_chain_manifest_path in h3_multishot_utils.py) so an external caller can
poll progress without importing torch. This module exposes that file over
HTTP (GET chain_state) so the in-ComfyUI clip-by-clip control widget (web/js/
h3_chain_control.js) can poll it too, and so an external orchestrator
(Framesmith) that talks to ComfyUI over HTTP rather than the filesystem has
a route to hit instead of needing filesystem access to ComfyUI's output
directory.

It also owns the two write actions the colour editor needs, mirroring the
Motion-Context Extender pack's own color_editor_info/color_adjust routes:

  POST /h3multishot/color_adjust  - save one shot's saturation/contrast/
      brightness into the manifest. Does not touch any cached pixels -
      the correction is only baked in at export time (see reexport below),
      so re-adjusting and re-exporting never re-samples anything.
  POST /h3multishot/reexport      - re-bake the finished master from
      already-staged shots with whatever color_adjustments are saved,
      via H3MultishotUtils._h3_reexport_master. No model/VAE/GPU sampling
      involved - just decode the cached lossless shots and re-encode.

Importing this module registers these three routes on whatever ComfyUI
instance loads the pack.
"""
import logging

_STATE_ROUTE = "/h3multishot/chain_state"
_COLOR_ADJUST_ROUTE = "/h3multishot/color_adjust"
_REEXPORT_ROUTE = "/h3multishot/reexport"
_LOG = logging.getLogger("h3_multishot.chain_api")


def _register_routes():
    try:
        from server import PromptServer
        from aiohttp import web
    except Exception:
        return  # CLI / headless import - no server to register on

    ps = getattr(PromptServer, "instance", None)
    if ps is None:
        return

    @ps.routes.get(_STATE_ROUTE)
    async def h3_chain_state(request):  # noqa: ANN001
        chain_id = request.query.get("chain_id", "").strip()
        if not chain_id:
            return web.json_response(
                {"error": "chain_id query param is required"}, status=400)
        try:
            from .h3_multishot_utils import (_h3_chain_manifest_path,
                                             _h3_load_manifest)
            path = _h3_chain_manifest_path(chain_id)
        except Exception as e:  # noqa: BLE001 - bad chain_id string, etc.
            return web.json_response({"error": str(e)}, status=400)

        manifest = _h3_load_manifest(path)
        if manifest is None:
            return web.json_response({"exists": False, "chain_id": chain_id})
        resp = dict(manifest)
        resp["exists"] = True
        return web.json_response(resp)

    @ps.routes.post(_COLOR_ADJUST_ROUTE)
    async def h3_color_adjust(request):  # noqa: ANN001
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "invalid JSON body"},
                                     status=400)
        chain_id = str(body.get("chain_id", "")).strip()
        if not chain_id:
            return web.json_response({"error": "chain_id is required"},
                                     status=400)
        try:
            shot_index = int(body.get("shot_index"))
        except (TypeError, ValueError):
            return web.json_response(
                {"error": "shot_index must be an integer (0-based)"},
                status=400)
        try:
            from .h3_multishot_utils import (_h3_chain_manifest_path,
                                             _h3_load_manifest,
                                             _h3_update_manifest)
            from .h3_stream_master import normalize_color_adjustment
            path = _h3_chain_manifest_path(chain_id)
            manifest = _h3_load_manifest(path)
            if manifest is None:
                return web.json_response(
                    {"error": "chain_id %r has no saved state yet"
                             % chain_id}, status=404)
            n_total = int(manifest.get("n_total", 0))
            if shot_index < 0 or shot_index >= n_total:
                return web.json_response(
                    {"error": "shot_index out of range (0..%d)"
                             % (n_total - 1)}, status=400)
            adjustment = normalize_color_adjustment(body.get("adjustment"))
            adjustments = dict(manifest.get("color_adjustments") or {})
            adjustments[str(shot_index)] = adjustment
            _h3_update_manifest(path, {"color_adjustments": adjustments})
            return web.json_response({"ok": True, "shot_index": shot_index,
                                      "adjustment": adjustment})
        except Exception as e:  # noqa: BLE001
            return web.json_response({"error": str(e)}, status=500)

    @ps.routes.post(_REEXPORT_ROUTE)
    async def h3_reexport(request):  # noqa: ANN001
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "invalid JSON body"},
                                     status=400)
        chain_id = str(body.get("chain_id", "")).strip()
        if not chain_id:
            return web.json_response({"error": "chain_id is required"},
                                     status=400)
        master_normalize = body.get("master_normalize") or None
        try:
            import asyncio
            from .h3_multishot_utils import _h3_reexport_master
            # decode+re-encode of already-cached shots - no GPU sampling,
            # but still blocking work; keep it off the event loop.
            master_path = await asyncio.get_event_loop().run_in_executor(
                None, _h3_reexport_master, chain_id, master_normalize)
            return web.json_response({"ok": True, "master_path": master_path})
        except Exception as e:  # noqa: BLE001
            return web.json_response({"error": str(e)}, status=500)

    _LOG.info("[H3-Multishot] chain routes registered: GET %s, POST %s, "
             "POST %s", _STATE_ROUTE, _COLOR_ADJUST_ROUTE, _REEXPORT_ROUTE)


_register_routes()
