import os
import asyncio
import shutil
import logging
from aiohttp import web
import comfy.model_management as comfy_mm

class RunPodTimer:
    def __init__(self):
        self.enabled = True
        self.duration_seconds = 1800  # Default 30 min
        self.seconds_left = 1800
        self.job_active = False
        self.shutdown_action = "stop_and_remove"
        self._task = None

    def check_huggingface_download_active(self) -> bool:
        import sys
        for mod_name, mod in list(sys.modules.items()):
            if "ComfyUI_HuggingFace_Downloader" in mod_name and mod_name.endswith(".web_api"):
                status_dict = getattr(mod, "download_status", None)
                if isinstance(status_dict, dict):
                    lock = getattr(mod, "download_status_lock", None)
                    if lock:
                        try:
                            acquired = lock.acquire(blocking=False)
                            try:
                                for item in status_dict.values():
                                    if isinstance(item, dict):
                                        status = str(item.get("status") or "").lower().strip()
                                        if status in {"pending", "downloading", "downloaded", "verifying", "finalizing", "cancelling"}:
                                            return True
                            finally:
                                if acquired:
                                    lock.release()
                        except Exception:
                            pass
                    else:
                        try:
                            for item in list(status_dict.values()):
                                if isinstance(item, dict):
                                    status = str(item.get("status") or "").lower().strip()
                                    if status in {"pending", "downloading", "downloaded", "verifying", "finalizing", "cancelling"}:
                                        return True
                        except Exception:
                            pass
        return False

    def check_comfyui_manager_active(self) -> bool:
        import sys
        for mod_name, mod in list(sys.modules.items()):
            if "ComfyUI-Manager" in mod_name and mod_name.endswith(".manager_server"):
                # 1. Check if task worker thread is active
                worker_thread = getattr(mod, "task_worker_thread", None)
                if worker_thread and hasattr(worker_thread, "is_alive") and worker_thread.is_alive():
                    return True
                # 2. Check if there are tasks in progress
                in_progress = getattr(mod, "tasks_in_progress", None)
                if isinstance(in_progress, (list, dict, set)) and len(in_progress) > 0:
                    return True
                # 3. Check if there are queued tasks
                t_queue = getattr(mod, "task_queue", None)
                if t_queue and hasattr(t_queue, "qsize") and t_queue.qsize() > 0:
                    return True
        return False

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

                if has_jobs or self.check_huggingface_download_active() or self.check_comfyui_manager_active():
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

_cgroup_ram_patch_applied = False
_cgroup_ram_patch_enabled = True
_ws_keepalive_task = None
_ws_keepalive_enabled = True

def _read_int_file(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = f.read().strip()
        if not raw or raw == "max":
            return None
        return int(raw)
    except Exception:
        return None

def _read_cgroup_memory_limit_and_usage():
    # cgroup v2
    v2_limit = _read_int_file("/sys/fs/cgroup/memory.max")
    v2_usage = _read_int_file("/sys/fs/cgroup/memory.current")
    if v2_limit is not None or v2_usage is not None:
        limit = v2_limit
        usage = v2_usage if v2_usage is not None else 0
    else:
        # cgroup v1
        limit = _read_int_file("/sys/fs/cgroup/memory/memory.limit_in_bytes")
        usage = _read_int_file("/sys/fs/cgroup/memory/memory.usage_in_bytes")
        usage = usage if usage is not None else 0

    # Very large limits in cgroup v1 commonly mean "unlimited".
    if limit is not None and limit >= (1 << 60):
        limit = None
    if usage < 0:
        usage = 0
    return limit, usage

def _patch_comfy_ram_detection_for_cgroups():
    """Monkey-patch ComfyUI RAM detection to respect cgroup memory limits."""
    global _cgroup_ram_patch_applied
    global _cgroup_ram_patch_enabled
    if _cgroup_ram_patch_applied:
        return

    try:
        original_virtual_memory = comfy_mm.psutil.virtual_memory
        sample = original_virtual_memory()
        host_total = int(getattr(sample, "total", 0) or 0)
        host_available = int(getattr(sample, "available", 0) or 0)
        limit, usage = _read_cgroup_memory_limit_and_usage()
        if not limit or host_total <= 0 or limit >= host_total:
            return

        def _virtual_memory_cgroup_aware():
            vm = original_virtual_memory()
            if not _cgroup_ram_patch_enabled:
                return vm
            vm_total = int(getattr(vm, "total", 0) or 0)
            vm_available = int(getattr(vm, "available", 0) or 0)
            c_limit, c_usage = _read_cgroup_memory_limit_and_usage()
            if not c_limit or vm_total <= 0 or c_limit >= vm_total:
                return vm
            effective_total = min(vm_total, c_limit)
            cgroup_free = max(c_limit - (c_usage or 0), 0)
            effective_available = min(vm_available, cgroup_free, effective_total)
            try:
                return vm._replace(total=effective_total, available=effective_available)
            except Exception:
                return vm

        comfy_mm.psutil.virtual_memory = _virtual_memory_cgroup_aware
        _cgroup_ram_patch_applied = True
        _cgroup_ram_patch_enabled = True

        limit_gib = limit / (1024 ** 3)
        host_gib = host_total / (1024 ** 3)
        avail_gib = min(host_available, max(limit - usage, 0)) / (1024 ** 3)
        print(
            f"[ComfyUI-RunPod-Control] Cgroup RAM patch enabled: host={host_gib:.2f} GiB, "
            f"limit={limit_gib:.2f} GiB, available={avail_gib:.2f} GiB"
        )
    except Exception as e:
        print(f"[ComfyUI-RunPod-Control] Failed to apply cgroup RAM patch: {e}")

async def _ws_keepalive_loop():
    """Send lightweight periodic websocket traffic to reduce proxy idle disconnects."""
    while True:
        try:
            import server
            prompt_server = getattr(server, "PromptServer", None)
            server_instance = getattr(prompt_server, "instance", None) if prompt_server is not None else None
            sockets = getattr(server_instance, "sockets", None) if server_instance is not None else None
            if _ws_keepalive_enabled and server_instance is not None and sockets:
                stale_ids = []
                for sid, ws in list(sockets.items()):
                    try:
                        if ws is None or ws.closed:
                            stale_ids.append(sid)
                            continue
                        # Use websocket ping control frame so frontend APIs stay silent.
                        await ws.ping()
                    except Exception:
                        stale_ids.append(sid)
                for sid in stale_ids:
                    sockets.pop(sid, None)
                    metadata = getattr(server_instance, "sockets_metadata", None)
                    if metadata is not None:
                        metadata.pop(sid, None)
        except Exception:
            pass
        await asyncio.sleep(45)

def _ensure_ws_keepalive_task():
    global _ws_keepalive_task
    if _ws_keepalive_task is not None and not _ws_keepalive_task.done():
        return
    try:
        import server
        prompt_server = getattr(server, "PromptServer", None)
        server_instance = getattr(prompt_server, "instance", None) if prompt_server is not None else None
        loop = getattr(server_instance, "loop", None) if server_instance is not None else None
        if loop is None:
            return
        _ws_keepalive_task = loop.create_task(_ws_keepalive_loop())
        print("[ComfyUI-RunPod-Control] WebSocket keepalive task started.")
    except Exception as e:
        print(f"[ComfyUI-RunPod-Control] Failed to start WebSocket keepalive task: {e}")
        _ws_keepalive_task = None

def setup(app):
    if app is None:
        return
    
    # Start the background timer task
    runpod_timer.start()
    
    # Apply cgroup-aware RAM patch and WebSocket keepalive task
    _patch_comfy_ram_detection_for_cgroups()
    _ensure_ws_keepalive_task()
    
    _safe_add_route(app, "GET", "/runpod/status", get_runpod_status)
    _safe_add_route(app, "POST", "/runpod/shutdown", post_runpod_shutdown)
    _safe_add_route(app, "POST", "/runpod/timer", post_runpod_timer)
