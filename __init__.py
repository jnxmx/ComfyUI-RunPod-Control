import threading
import time

# ComfyUI exports WEB_DIRECTORY to auto-serve JS files from this path
WEB_DIRECTORY = "./js"
NODE_CLASS_MAPPINGS = {}
__all__ = ["NODE_CLASS_MAPPINGS", "WEB_DIRECTORY"]

# Register backend web API
try:
    from . import web_api
    import server

    _web_api_registered = False
    _web_api_register_lock = threading.Lock()

    def _try_register_web_api_once() -> bool:
        global _web_api_registered
        with _web_api_register_lock:
            if _web_api_registered:
                return True
            prompt_instance = getattr(server.PromptServer, "instance", None)
            if prompt_instance is None:
                return False
            try:
                # Register routes on aiohttp router
                app = getattr(prompt_instance, "app", None)
                web_api.setup(app)
                _web_api_registered = True
                print("[ComfyUI-RunPod-Control] Web API routes successfully registered.")
                return True
            except Exception as inner_error:
                print(f"[ComfyUI-RunPod-Control] Web API registration attempt failed: {inner_error}")
                return False

    def _register_web_api_with_retry():
        # PromptServer.instance might not be fully initialized when custom nodes are first imported.
        for _ in range(120):  # Retry for up to ~60s
            if _try_register_web_api_once():
                return
            time.sleep(0.5)
        print("[ComfyUI-RunPod-Control] Web API registration timed out waiting for PromptServer.instance.")

    if not _try_register_web_api_once():
        threading.Thread(target=_register_web_api_with_retry, daemon=True).start()
except Exception as e:
    print(f"[ComfyUI-RunPod-Control] Web API not loaded: {e}")
