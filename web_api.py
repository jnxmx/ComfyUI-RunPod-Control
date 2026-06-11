import os
import asyncio
import shutil
from aiohttp import web

class RunPodTimer:
    def __init__(self):
        self.enabled = True
        self.duration_seconds = 1800  # Default 30 min
        self.seconds_left = 1800
        self.job_active = False
        self.shutdown_action = "stop_and_remove"
        self._task = None

    def start(self):
        if self._task is None:
            self._task = asyncio.create_task(self._tick_loop())
            print("[ComfyUI-RunPod-Control] Background timer task started.")

    async def _tick_loop(self):
        # Give the server some time to initialize fully
        await asyncio.sleep(5.0)
        while True:
            try:
                await asyncio.sleep(1.0)
                
                # Check ComfyUI queue status
                import server
                prompt_server = getattr(server, "PromptServer", None)
                if not prompt_server or not getattr(prompt_server, "instance", None):
                    continue
                
                server_instance = prompt_server.instance
                has_jobs = False
                try:
                    queue = getattr(server_instance, "prompt_queue", None)
                    if queue:
                        if hasattr(queue, "get_current_queue_volatile"):
                            running, pending = queue.get_current_queue_volatile()
                        else:
                            running, pending = queue.get_current_queue()
                        has_jobs = (len(running) + len(pending)) > 0
                except Exception as e:
                    print(f"[ComfyUI-RunPod-Control] Exception checking prompt queue: {e}")
                    has_jobs = False

                if has_jobs:
                    self.job_active = True
                    # Reset timer back to duration if job is active
                    self.seconds_left = self.duration_seconds
                else:
                    self.job_active = False
                    if self.enabled:
                        if self.seconds_left > 0:
                            self.seconds_left -= 1
                            if self.seconds_left <= 0:
                                await self._trigger_shutdown()
            except asyncio.CancelledError:
                break
            except Exception as e:
                print(f"[ComfyUI-RunPod-Control] Exception in timer loop: {e}")

    async def _trigger_shutdown(self):
        pod_id = os.environ.get("RUNPOD_POD_ID")
        if not pod_id:
            print("[ComfyUI-RunPod-Control] Shutdown triggered but RUNPOD_POD_ID is missing.")
            return

        runpodctl_path = shutil.which("runpodctl")
        if not runpodctl_path:
            print("[ComfyUI-RunPod-Control] Shutdown triggered but runpodctl not found in PATH.")
            return

        if self.shutdown_action == "stop_only":
            cmd = f"runpodctl stop pod {pod_id}"
        else:
            cmd = f"runpodctl remove pod {pod_id}"

        print(f"[ComfyUI-RunPod-Control] Timer expired. Executing shutdown: {cmd}")
        try:
            process = await asyncio.create_subprocess_shell(
                cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            stdout, stderr = await process.communicate()
            print(f"[ComfyUI-RunPod-Control] Shutdown stdout: {stdout.decode().strip()}")
            print(f"[ComfyUI-RunPod-Control] Shutdown stderr: {stderr.decode().strip()}")
        except Exception as e:
            print(f"[ComfyUI-RunPod-Control] Shutdown command failed: {e}")

runpod_timer = RunPodTimer()


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
            
    # Determine ComfyUI's port to avoid matching it
    comfyui_ports = {8188}
    try:
        import server
        prompt_instance = getattr(server.PromptServer, "instance", None)
        if prompt_instance and hasattr(prompt_instance, "port"):
            comfyui_ports.add(int(prompt_instance.port))
    except Exception:
        pass

    # Also check if client passed the proxy/external port ComfyUI is running on
    client_comfy_port = request.query.get("comfy_port")
    if client_comfy_port:
        try:
            comfyui_ports.add(int(client_comfy_port))
        except ValueError:
            pass

    port_param = request.query.get("port", "")
    try:
        filebrowser_port = int(port_param) if port_param else None
    except ValueError:
        filebrowser_port = None

    # Collect internal ports that RunPod has mapped to direct TCP connections.
    # These are NOT accessible via the *.proxy.runpod.net HTTPS proxy tunnel,
    # so we must EXCLUDE them when looking for a proxy-accessible FileBrowser port.
    tcp_internal_ports = set()
    for key in os.environ:
        if key.startswith("RUNPOD_TCP_PORT_"):
            try:
                internal_port = int(key.replace("RUNPOD_TCP_PORT_", ""))
                tcp_internal_ports.add(internal_port)
            except ValueError:
                pass

    filebrowser_active = False
    detected_port = None
    filebrowser_url = None
    output_url = None

    if is_runpod and pod_id:
        # 1. First test the explicitly user-configured port (if not a TCP port or ComfyUI port)
        if (
            filebrowser_port is not None
            and filebrowser_port not in comfyui_ports
            and filebrowser_port not in tcp_internal_ports
            and await check_port_open("127.0.0.1", filebrowser_port, timeout=0.5)
        ):
            filebrowser_active = True
            detected_port = filebrowser_port
        else:
            # 2. Probe common fallback ports, skipping:
            #    - ComfyUI ports
            #    - TCP-direct mapped ports (not proxy-accessible)
            #    - The already-tested user port
            fallback_ports = [7861, 7860, 8081, 8080, 8000, 3000, 80]
            for p in fallback_ports:
                if p in comfyui_ports:
                    continue
                if p in tcp_internal_ports:
                    # This port is a direct TCP mapping, not proxy-accessible — skip it
                    continue
                if filebrowser_port is not None and p == filebrowser_port:
                    continue
                if await check_port_open("127.0.0.1", p, timeout=0.3):
                    filebrowser_active = True
                    detected_port = p
                    break
        
        if filebrowser_active and detected_port:
            # Build proxy URLs using the detected active port
            filebrowser_url = f"https://{pod_id}-{detected_port}.proxy.runpod.net/files/ComfyUI/"
            output_url = f"https://{pod_id}-{detected_port}.proxy.runpod.net/files/ComfyUI/output/"

    # Build the full TCP mapping (internal → external) for the response
    tcp_port_mappings = {}
    for key, value in os.environ.items():
        if key.startswith("RUNPOD_TCP_PORT_"):
            try:
                internal_port = int(key.replace("RUNPOD_TCP_PORT_", ""))
                tcp_port_mappings[internal_port] = int(value)
            except ValueError:
                pass

    return web.json_response({
        "is_runpod": is_runpod,
        "pod_id": pod_id,
        "public_ip": os.environ.get("RUNPOD_PUBLIC_IP"),
        "tcp_port_mappings": tcp_port_mappings,
        "filebrowser_active": filebrowser_active,
        "filebrowser_port": detected_port,
        "filebrowser_url": filebrowser_url,
        "output_url": output_url,
        "comfyui_ports": list(comfyui_ports),
        "gpu_name": os.environ.get("RUNPOD_GPU_KEY", "GPU").replace("NVIDIA-", "").replace("GeForce-", "").replace("RTX-", "RTX "),
        "balance": os.environ.get("RUNPOD_BALANCE", "?"),
        "timer": {
            "enabled": runpod_timer.enabled,
            "seconds_left": runpod_timer.seconds_left,
            "duration_seconds": runpod_timer.duration_seconds,
            "job_active": runpod_timer.job_active,
            "shutdown_action": runpod_timer.shutdown_action
        }
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
    elif action == "restart":
        cmd = f"runpodctl pod restart {pod_id}"
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

async def post_runpod_timer(request):
    try:
        body = await request.json()
        action = body.get("action")
        
        if action == "reset":
            runpod_timer.seconds_left = runpod_timer.duration_seconds
        elif action == "toggle":
            enabled = body.get("enabled", not runpod_timer.enabled)
            runpod_timer.enabled = enabled
            if enabled:
                runpod_timer.seconds_left = runpod_timer.duration_seconds
        elif action == "set_duration":
            duration = body.get("duration_seconds")
            if isinstance(duration, int) and duration > 0:
                runpod_timer.duration_seconds = duration
                if not runpod_timer.job_active and runpod_timer.enabled:
                    runpod_timer.seconds_left = duration
        elif action == "set_shutdown_action":
            sht_action = body.get("shutdown_action")
            if sht_action in ["stop_only", "stop_and_remove"]:
                runpod_timer.shutdown_action = sht_action
                
        return web.json_response({
            "success": True,
            "timer": {
                "enabled": runpod_timer.enabled,
                "seconds_left": runpod_timer.seconds_left,
                "duration_seconds": runpod_timer.duration_seconds,
                "job_active": runpod_timer.job_active,
                "shutdown_action": runpod_timer.shutdown_action
            }
        })
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)}, status=500)

def setup(app):
    if app is None:
        return
    
    # Start the background timer task
    runpod_timer.start()
    
    _safe_add_route(app, "GET", "/runpod/status", get_runpod_status)
    _safe_add_route(app, "POST", "/runpod/shutdown", post_runpod_shutdown)
    _safe_add_route(app, "POST", "/runpod/timer", post_runpod_timer)
