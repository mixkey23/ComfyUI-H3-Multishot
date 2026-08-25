"""Read-only status API for chain_id/resume_chain clip-by-clip chains.

H3MultishotMemorySampler already writes a plain-JSON manifest per chain
(chain_multishot_<chain_id>.json under output/video/H3CHAIN_STATE/ - see
_h3_chain_manifest_path in h3_multishot_utils.py) so an external caller can
poll progress without importing torch. This module exposes that same file
over HTTP so the in-ComfyUI clip-by-clip control widget (web/js/
h3_chain_control.js) can poll it too, and so an external orchestrator
(Framesmith) that talks to ComfyUI over HTTP rather than the filesystem has
a route to hit instead of needing filesystem access to ComfyUI's output
directory.

Importing this module registers GET /h3multishot/chain_state on whatever
ComfyUI instance loads the pack. It touches nothing else: no node, no write
path - the manifest is still only ever written by the sampler node itself.
"""
import logging

_ROUTE = "/h3multishot/chain_state"
_LOG = logging.getLogger("h3_multishot.chain_api")


def _register_route():
    try:
        from server import PromptServer
        from aiohttp import web
    except Exception:
        return  # CLI / headless import - no server to register on

    ps = getattr(PromptServer, "instance", None)
    if ps is None:
        return

    @ps.routes.get(_ROUTE)
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

    _LOG.info("[H3-Multishot] chain status route registered: GET %s", _ROUTE)


_register_route()
