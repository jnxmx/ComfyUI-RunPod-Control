# ComfyUI-RunPod-Control

A lightweight ComfyUI extension designed for managing pods running on RunPod. It adds custom control widgets directly into the top action bar of the ComfyUI desktop/web interface to manage your pod's lifetime and view files easily.

## Features

- **Auto-Shutdown Timer**: Sets an idle timer (default: 30 minutes) that begins ticking down after all ComfyUI queue runs are complete. If a new job starts, the timer is automatically paused and reset. When the countdown completes, it stops and/or terminates the pod to avoid incurring charges.
- **Graceful Warnings**: When the timer drops below 100 seconds, a centered glassmorphism overlay modal appears with a countdown, allowing you to instantly reset the timer or shut down immediately.
- **Interactive Top Menu**: Hovering over the timer lets you reset it, disable it entirely, or access direct telemetry/logs links on the RunPod Console.
- **FileBrowser Launcher**: Auto-detects if a FileBrowser service is running on the container (e.g. port `8080`). If found, it displays a shortcut to browse files inside `files/ComfyUI/` or directly jump to the `output/` directory on hover.
- **Zero Configuration Needed**: RunPod automatically injects container credentials. This node runs `runpodctl` out-of-the-box without requiring you to set up or configure API keys manually.

## Installation

Simply clone this repository inside your ComfyUI custom nodes directory:
```bash
cd ComfyUI/custom_nodes/
git clone https://github.com/jnxmx/ComfyUI-RunPod-Control.git
```

## How It Works Under the Hood

1. **Detection**: On start, the frontend checks if the environment variable `RUNPOD_POD_ID` is set via a custom local backend route (`/runpod/status`). If it is not running on RunPod, the UI buttons are kept completely hidden (silent mode).
2. **Execution Monitoring**: The timer connects to ComfyUI websocket events and queues to monitor workflow status. The idle timer starts only when the queue becomes empty.
3. **Automatic Termination**: When the timer runs out, the backend executes `runpodctl remove pod $RUNPOD_POD_ID` (or `stop` depending on your settings) to safely stop or delete the pod.
