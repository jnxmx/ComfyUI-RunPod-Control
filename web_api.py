import os
import asyncio
import shutil
from aiohttp import web

def _safe_add_route(app, method, path, handler):
    try:
        if app is not None and hasattr(app, "router"):
            app.router.add_route(method, path, handler)
    except Exception as e:
        print(f"[ComfyUI-RunPod-Control] Failed to register route {method} {path}: {e}")

async def check_port_open(host: str, port: int, timeout: float = 1.0) -> bool:
    try:
        conn = asyncio.open_connection(host, port)
        reader, writer = await asyncio.wait_for(conn, timeout=timeout)
        writer.close()
        await writer.wait_closed()
        return True
    except Exception:
        return False

async def get_runpod_status(request):
    pod_id = os.environ.get("RUNPOD_POD_ID")
    
    # Simple check to see if we are running in a RunPod container
    is_runpod = pod_id is not None and len(pod_id) > 0
    
    # If not detected via env, check hostname (RunPod hostname is usually the pod ID)
    if not is_runpod:
        # Check if the hostname has the RunPod pattern or we are on RunPod
        # RunPod pod hostnames are often hex/alphanumeric strings matching pod ID
        hostname = os.environ.get("HOSTNAME", "")
        # RunPod specific env variables
        if os.environ.get("RUNPOD_GPU_KEY") or os.environ.get("RUNPOD_PUBLIC_IP"):
            is_runpod = True
            pod_id = hostname
            
    port_param = request.query.get("port", "8080")
    try:
        filebrowser_port = int(port_param)
    except ValueError:
        filebrowser_port = 8080
        
    filebrowser_active = False
    filebrowser_url = None
    output_url = None
    
    if is_runpod and pod_id:
        # Check if FileBrowser port is open locally
        filebrowser_active = await check_port_open("127.0.0.1", filebrowser_port, timeout=1.0)
        if filebrowser_active:
            # Build proxy URLs using RunPod's proxy URL naming scheme
            filebrowser_url = f"https://{pod_id}-{filebrowser_port}.proxy.runpod.net/files/ComfyUI/"
            output_url = f"https://{pod_id}-{filebrowser_port}.proxy.runpod.net/files/ComfyUI/output/"

    return web.json_response({
        "is_runpod": is_runpod,
        "pod_id": pod_id,
        "filebrowser_active": filebrowser_active,
        "filebrowser_url": filebrowser_url,
        "output_url": output_url
    })

async def post_runpod_shutdown(request):
    pod_id = os.environ.get("RUNPOD_POD_ID")
    if not pod_id:
        return web.json_response({"success": False, "error": "Not running on RunPod or RUNPOD_POD_ID env variable missing."}, status=400)
    
    # Verify runpodctl is installed
    runpodctl_path = shutil.which("runpodctl")
    if not runpodctl_path:
        return web.json_response({
            "success": False,
            "error": "runpodctl CLI is not installed or not found in PATH."
        }, status=500)
        
    # Read shutdown action from request body (stop only vs stop and remove)
    try:
        body = await request.json()
        action = body.get("action", "stop_and_remove")
    except Exception:
        action = "stop_and_remove"
        
    # We will trigger the command in the background after returning the response
    # to avoid the request hanging/timeout while the container is being terminated.
    if action == "stop_only":
        cmd = f"runpodctl stop pod {pod_id}"
    else:
        # Default is stop & remove (terminate)
        # To be safe, run remove pod, which handles both stopping and removal.
        cmd = f"runpodctl remove pod {pod_id}"
        
    async def run_shutdown_cmd():
        print(f"[ComfyUI-RunPod-Control] Initiating shutdown command: {cmd}")
        # Give some time for response to be sent back to browser
        await asyncio.sleep(1.0)
        try:
            process = await asyncio.create_subprocess_shell(
                cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            stdout, stderr = await process.communicate()
            print(f"[ComfyUI-RunPod-Control] stdout: {stdout.decode().strip()}")
            print(f"[ComfyUI-RunPod-Control] stderr: {stderr.decode().strip()}")
        except Exception as e:
            print(f"[ComfyUI-RunPod-Control] Failed to run shutdown command: {e}")
            
    # Schedule command execution
    asyncio.create_task(run_shutdown_cmd())
    
    return web.json_response({
        "success": True,
        "message": f"Shutdown command scheduled successfully using action: {action}"
    })

def setup(app):
    if app is None:
        return
    _safe_add_route(app, "GET", "/runpod/status", get_runpod_status)
    _safe_add_route(app, "POST", "/runpod/shutdown", post_runpod_shutdown)
