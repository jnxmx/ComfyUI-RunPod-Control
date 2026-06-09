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
      id: "runpod.filebrowser_port",
      category: ["RunPod Control", "FileBrowser Port"],
      name: "FileBrowser Port",
      type: "number",
      defaultValue: 8080,
      tooltip: "The local port that FileBrowser is listening on inside the container."
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
