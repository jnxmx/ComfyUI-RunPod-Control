import { app } from "../../../scripts/app.js";

app.registerExtension({
  name: "ComfyUI.RunPodControl.Settings",
  settings: [
    {
      id: "runpod.shutdown_minutes",
      category: ["RunPod Control", "Timer Duration (Minutes)"],
      name: "Shutdown Duration (minutes)",
      type: "number",
      defaultValue: 30,
      tooltip: "How long the pod should remain idle after all jobs finish before shutting down.",
      attrs: { min: 1, max: 1440, step: 1 }
    },
    {
      id: "runpod.filebrowser_type",
      category: ["RunPod Control", "FileBrowser Mode"],
      name: "FileBrowser URL Mode",
      type: "combo",
      defaultValue: "relative_path",
      tooltip: "Choose whether FileBrowser is served as a subpath on Comfy's URL (via Nginx proxy) or on a separate RunPod port.",
      options: [
        { value: "relative_path", text: "ComfyUI Subpath (e.g. /files/ via Nginx)" },
        { value: "separate_port", text: "Separate Proxy Port (e.g. 8080)" }
      ]
    },
    {
      id: "runpod.filebrowser_relative_path",
      category: ["RunPod Control", "FileBrowser Relative Path"],
      name: "FileBrowser Relative Path",
      type: "text",
      defaultValue: "/files/",
      tooltip: "The subpath route on your main URL that routes to FileBrowser."
    },
    {
      id: "runpod.filebrowser_port",
      category: ["RunPod Control", "FileBrowser Port"],
      name: "FileBrowser Local Port",
      type: "number",
      defaultValue: 8080,
      tooltip: "The local container port where the FileBrowser service is running (used to verify if the service is active)."
    },
    {
      id: "runpod.filebrowser_visibility",
      category: ["RunPod Control", "FileBrowser Visibility"],
      name: "FileBrowser Visibility",
      type: "combo",
      defaultValue: "auto_detect",
      tooltip: "Choose whether the button should auto-hide when the FileBrowser port check fails, or be permanently displayed.",
      options: [
        { value: "auto_detect", text: "Auto-detect service status" },
        { value: "always_show", text: "Always show button" }
      ]
    },
    {
      id: "runpod.shutdown_action",
      category: ["RunPod Control", "Shutdown Behavior"],
      name: "Shutdown Behavior",
      type: "combo",
      defaultValue: "stop_and_remove",
      tooltip: "Select whether the timer should just stop the pod (retaining storage) or stop and remove/terminate it entirely.",
      options: [
        { value: "stop_only", text: "Stop Only (keep disk & files)" },
        { value: "stop_and_remove", text: "Stop and Remove (terminate pod)" }
      ]
    }
  ]
});
