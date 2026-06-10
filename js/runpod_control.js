import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

console.log("[RunPod Control] v1.0.15 loaded");

// Global State
let runpodStatus = {
    is_runpod: false,
    pod_id: null,
    filebrowser_active: false,
    filebrowser_url: null,
    output_url: null
};

let timerState = {
    enabled: true,
    running: false,
    secondsLeft: 1800, // Default 30 min (updated from settings)
    intervalId: null,
    jobActive: false
};

// UI Elements & State Tracking
let unifiedDropdownMenu = null;
let countdownOverlay = null;
let decorateQueued = false;
let bypassBeforeUnload = false;

// Intercept and prevent "Confirm on close/leave" prompts if redirecting intentionally
window.addEventListener("beforeunload", (e) => {
    if (bypassBeforeUnload) {
        e.stopImmediatePropagation();
        delete e.returnValue;
    }
}, true);

// Helper: Show notification toast
function showToast(summary, detail, severity = "info") {
    if (app?.extensionManager?.toast?.add) {
        app.extensionManager.toast.add({
            severity,
            summary,
            detail,
            life: 5000,
            closable: true
        });
    } else {
        console.log(`[RunPod Control] [${severity.toUpperCase()}] ${summary}: ${detail}`);
    }
}

// Fetch configured duration from settings
function getConfiguredMinutes() {
    const settingsUi = app?.ui?.settings;
    if (settingsUi?.getSettingValue) {
        let val = settingsUi.getSettingValue("runpod.shutdown_minutes");
        if (typeof val === "string") val = parseInt(val, 10);
        if (typeof val === "number" && !isNaN(val) && val > 0) return val;
    }
    return 30;
}

// Fetch configured FileBrowser port
function getFileBrowserPort() {
    const settingsUi = app?.ui?.settings;
    if (settingsUi?.getSettingValue) {
        const val = settingsUi.getSettingValue("runpod.filebrowser_port");
        if (typeof val === "number" && val > 0) return val;
    }
    return 8080;
}

// Fetch configured FileBrowser URL mode
function getFileBrowserType() {
    const settingsUi = app?.ui?.settings;
    if (settingsUi?.getSettingValue) {
        const val = settingsUi.getSettingValue("runpod.filebrowser_type");
        if (typeof val === "string") return val;
    }
    return "relative_path";
}

// Fetch configured FileBrowser relative path suffix
function getFileBrowserRelativePath() {
    const settingsUi = app?.ui?.settings;
    if (settingsUi?.getSettingValue) {
        const val = settingsUi.getSettingValue("runpod.filebrowser_relative_path");
        if (typeof val === "string") return val;
    }
    return "/files/";
}

// Fetch configured FileBrowser visibility behavior
function getFileBrowserVisibility() {
    const settingsUi = app?.ui?.settings;
    if (settingsUi?.getSettingValue) {
        const val = settingsUi.getSettingValue("runpod.filebrowser_visibility");
        if (typeof val === "string") return val;
    }
    return "auto_detect";
}

// Fetch configured shutdown behavior
function getShutdownAction() {
    const settingsUi = app?.ui?.settings;
    if (settingsUi?.getSettingValue) {
        const val = settingsUi.getSettingValue("runpod.shutdown_action");
        if (typeof val === "string") return val;
    }
    return "stop_and_remove";
}

// Extract clean pod ID and active ComfyUI port from RunPod proxy hostname
function getRunPodProxyInfo() {
    const host = window.location.hostname;
    // Format: {podId}-{port}.proxy.runpod.net
    const match = host.match(/^([a-z0-9]+)-(\d+)\.proxy\.runpod\.net/i);
    if (match) {
        return {
            podId: match[1],
            comfyPort: parseInt(match[2], 10)
        };
    }
    // Fallback: Check if port is specified in window.location.port
    let comfyPort = null;
    if (window.location.port) {
        try {
            comfyPort = parseInt(window.location.port, 10);
        } catch (e) {}
    }
    return {
        podId: null,
        comfyPort: comfyPort
    };
}

// Check RunPod status from Python backend
async function fetchRunPodStatus() {
    const port = getFileBrowserPort();
    const proxyInfo = getRunPodProxyInfo();
    
    let url = `/runpod/status?port=${port}`;
    if (proxyInfo.comfyPort) {
        url += `&comfy_port=${proxyInfo.comfyPort}`;
    }
    
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error("Backend unavailable");
        runpodStatus = await response.json();
        
        console.log("[RunPod Control] Detected RunPod status:", runpodStatus);
        
        const forceShow = getFileBrowserVisibility() === "always_show";
        if (runpodStatus.is_runpod) {
            if (runpodStatus.filebrowser_active || forceShow) {
                // If forced, ensure active state is simulated
                runpodStatus.filebrowser_active = true;
                
                const fbType = getFileBrowserType();
                const subpath = getFileBrowserRelativePath();
                const leadSlash = subpath.startsWith("/") ? "" : "/";
                const trailSlash = subpath.endsWith("/") ? "" : "/";
                const cleanSubpath = `${leadSlash}${subpath}${trailSlash}`;

                const activePort = runpodStatus.filebrowser_port || port;
                const comfyuiInternalPorts = runpodStatus.comfyui_ports || [8188];
                const comfyPort = proxyInfo.comfyPort;
                const isComfyPort = comfyuiInternalPorts.includes(activePort) || (comfyPort && activePort === comfyPort);

                // Auto-correct: If the active FileBrowser port is different from ComfyUI's ports,
                // we MUST route to a separate proxy port regardless of the setting, as it is physically
                // not served on the ComfyUI port.
                const shouldExposeOnSeparatePort = (fbType === "separate_port") || (runpodStatus.filebrowser_active && !isComfyPort);

                if (shouldExposeOnSeparatePort) {
                    const podId = runpodStatus.pod_id || proxyInfo.podId || window.location.hostname;
                    runpodStatus.filebrowser_url = `https://${podId}-${activePort}.proxy.runpod.net${cleanSubpath}`;
                    runpodStatus.output_url = `https://${podId}-${activePort}.proxy.runpod.net${cleanSubpath}output/`;
                } else if (fbType === "relative_path") {
                    const origin = window.location.origin.replace(/\/$/, "");
                    runpodStatus.filebrowser_url = `${origin}${cleanSubpath}`;
                    runpodStatus.output_url = `${origin}${cleanSubpath}output/`;
                } else if (forceShow && !runpodStatus.filebrowser_url) {
                    // Fallback URL generation if separate port was selected but port check failed
                    const podId = runpodStatus.pod_id || proxyInfo.podId || window.location.hostname;
                    runpodStatus.filebrowser_url = `https://${podId}-${port}.proxy.runpod.net${cleanSubpath}`;
                    runpodStatus.output_url = `https://${podId}-${port}.proxy.runpod.net${cleanSubpath}output/`;
                }

                // OVERRIDE: Check if we are accessed via direct TCP IP connection (bypassing HTTP proxy)
                const isIpAddress = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(window.location.hostname);
                const currentPort = window.location.port ? parseInt(window.location.port, 10) : null;
                
                let isDirectTcp = isIpAddress;
                if (!isDirectTcp && currentPort && runpodStatus.tcp_port_mappings) {
                    for (const intPort of comfyuiInternalPorts) {
                        const extPort = runpodStatus.tcp_port_mappings[intPort];
                        if (extPort && currentPort === extPort) {
                            isDirectTcp = true;
                            break;
                        }
                    }
                }

                if (isDirectTcp) {
                    const activePort = runpodStatus.filebrowser_port || port;
                    const externalFbPort = runpodStatus.tcp_port_mappings ? runpodStatus.tcp_port_mappings[activePort] : null;
                    const host = window.location.hostname;
                    
                    if (externalFbPort) {
                        console.log(`[RunPod Control] Direct TCP detected. Mapping internal port ${activePort} -> external ${externalFbPort}`);
                        runpodStatus.filebrowser_url = `http://${host}:${externalFbPort}${cleanSubpath}`;
                        runpodStatus.output_url = `http://${host}:${externalFbPort}${cleanSubpath}output/`;
                    } else {
                        // If mapping not found, warn the user but fall back to the raw internal port on the host
                        console.warn(`[RunPod Control] Direct TCP detected but external mapping for FileBrowser port ${activePort} not found in environment.`);
                        runpodStatus.filebrowser_url = `http://${host}:${activePort}${cleanSubpath}`;
                        runpodStatus.output_url = `http://${host}:${activePort}${cleanSubpath}output/`;
                    }
                }
            }
        }
        return runpodStatus.is_runpod;
    } catch (e) {
        console.warn("[RunPod Control] Failed to fetch RunPod status from backend:", e);
        return false;
    }
}

// Perform pod shutdown
async function executeShutdown() {
    const action = getShutdownAction();
    showToast("Shutdown Triggered", "Sending terminate signal to the pod...", "warn");
    
    // Trigger the backend API call to terminate/stop the pod
    const shutdownPromise = fetch("/runpod/shutdown", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action })
    }).catch(e => console.error("[RunPod Control] Backend shutdown request failed:", e));

    // Bypass leave-site prompt and redirect
    bypassBeforeUnload = true;
    window.onbeforeunload = null;
    window.location.href = "https://console.runpod.io/";
}

// Perform pod restart
async function executeRestart() {
    showToast("Restart Triggered", "Sending restart signal to the pod...", "warn");
    
    fetch("/runpod/shutdown", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "restart" })
    }).catch(e => console.error("[RunPod Control] Backend restart request failed:", e));

    // Bypass leave-site prompt and redirect
    bypassBeforeUnload = true;
    window.onbeforeunload = null;
    window.location.href = "https://console.runpod.io/";
}

// Update the Top Action Bar Timer Button display
function getButtonText() {
    let timerText = "no shutdown";
    if (timerState.enabled) {
        if (timerState.jobActive) {
            timerText = `${getConfiguredMinutes()}m`;
        } else {
            const mins = Math.ceil(timerState.secondsLeft / 60);
            timerText = `${mins}m`;
        }
    }
    return timerText;
}

function updateButtonUI() {
    const btn = document.querySelector('button[aria-label="RunPod Control"]');
    if (!btn) return;

    if (!btn.classList.contains("runpod-control-btn")) {
        btn.classList.add("runpod-control-btn");
        Object.assign(btn.style, {
            padding: "4px 8px",
            minWidth: "max-content",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "12px",
            fontWeight: "500",
            fontFamily: "monospace",
            whiteSpace: "pre"
        });
        
        // Disable original tooltip since our button is custom
        btn.title = "";
    }

    const isActive = timerState.enabled && !timerState.jobActive;
    let htmlContent;
    if (isActive) {
        htmlContent = `RunPod <span class="pi pi-power-off" style="margin: 0 4px; font-size: 12px; display: inline-block;"></span>${getButtonText()}`;
    } else {
        htmlContent = `RunPod`;
    }

    if (btn.innerHTML !== htmlContent) {
        btn.innerHTML = htmlContent;
    }
}

// Start, Pause, Reset Timer logic
function resetTimer() {
    timerState.secondsLeft = getConfiguredMinutes() * 60;
    hideCountdownOverlay();
    updateButtonUI();
    if (!timerState.jobActive && timerState.enabled) {
        startTimerCountdown();
    }
}

function startTimerCountdown() {
    if (timerState.intervalId) clearInterval(timerState.intervalId);
    if (!timerState.enabled || timerState.jobActive) return;

    timerState.running = true;
    timerState.intervalId = setInterval(() => {
        if (timerState.secondsLeft <= 0) {
            clearInterval(timerState.intervalId);
            timerState.running = false;
            hideCountdownOverlay();
            executeShutdown();
            return;
        }

        timerState.secondsLeft--;
        updateButtonUI();

        // Overlay trigger condition
        if (timerState.secondsLeft < 100) {
            showCountdownOverlay();
        } else {
            hideCountdownOverlay();
        }
    }, 1000);
}

function pauseTimer() {
    if (timerState.intervalId) {
        clearInterval(timerState.intervalId);
        timerState.intervalId = null;
    }
    timerState.running = false;
    hideCountdownOverlay();
    updateButtonUI();
}

// Set up event listeners for execution states
function setupJobDetection() {
    // 1. WebSocket execution events
    api.addEventListener("execution_start", () => {
        timerState.jobActive = true;
        pauseTimer();
    });

    api.addEventListener("executed", () => {
        checkQueueState();
    });

    api.addEventListener("execution_error", () => {
        checkQueueState();
    });

    // 2. Poll/query queue immediately to synchronize state
    checkQueueState();
}

async function checkQueueState() {
    try {
        const response = await fetch("/queue");
        if (!response.ok) return;
        const data = await response.json();
        const running = data.queue_running || [];
        const pending = data.queue_pending || [];
        const total = running.length + pending.length;

        if (total > 0) {
            timerState.jobActive = true;
            pauseTimer();
        } else {
            if (timerState.jobActive) {
                // Transitioning from active -> idle
                timerState.jobActive = false;
                resetTimer();
            } else if (!timerState.running && timerState.enabled) {
                // If not running, kick-start
                startTimerCountdown();
            }
        }
    } catch (e) {
        console.warn("[RunPod Control] Failed to verify queue state:", e);
    }
}

// Dropdown Menus: Create & Hide
function hideAllDropdowns() {
    if (unifiedDropdownMenu) unifiedDropdownMenu.style.display = "none";
}

function ensureUnifiedDropdown(buttonEl) {
    if (unifiedDropdownMenu) return unifiedDropdownMenu;

    const menu = document.createElement("div");
    menu.id = "runpod-unified-dropdown";
    Object.assign(menu.style, {
        position: "absolute",
        background: "var(--p-menu-background, #18181b)",
        border: "1px solid var(--p-menu-border-color, #27272a)",
        borderRadius: "8px",
        boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1), 0 10px 15px -3px rgb(0 0 0 / 0.1)",
        padding: "4px",
        display: "none",
        flexDirection: "column",
        zIndex: "10001",
        fontFamily: "inherit",
        minWidth: "200px"
    });

    const createItem = (text, onClick) => {
        const item = document.createElement("button");
        item.type = "button";
        item.textContent = text;
        Object.assign(item.style, {
            border: "none",
            borderRadius: "6px",
            background: "transparent",
            color: "var(--p-menu-item-color, var(--input-text, #f4f4f5))",
            padding: "8px 12px",
            textAlign: "left",
            cursor: "pointer",
            width: "100%",
            fontSize: "13px",
            fontFamily: "inherit",
            transition: "background 0.1s ease, color 0.1s ease"
        });
        item.addEventListener("mouseenter", () => {
            item.style.background = "var(--p-button-primary-background, var(--comfy-menu-primary-bg, #3b82f6))";
            item.style.color = "var(--p-button-primary-color, #ffffff)";
        });
        item.addEventListener("mouseleave", () => {
            item.style.background = "transparent";
            item.style.color = "var(--p-menu-item-color, var(--input-text, #f4f4f5))";
        });
        item.addEventListener("click", (e) => {
            e.stopPropagation();
            hideAllDropdowns();
            onClick();
        });
        return item;
    };

    const outputsBtn = createItem("Outputs", () => {
        if (runpodStatus.output_url) window.open(runpodStatus.output_url, "_blank");
        else showToast("Outputs", "Output URL not available", "warn");
    });

    const fbBtn = createItem("FileBrowser", () => {
        if (runpodStatus.filebrowser_url) window.open(runpodStatus.filebrowser_url, "_blank");
        else showToast("FileBrowser", "FileBrowser not active", "warn");
    });

    const infoBtn = createItem("Pod Info", () => {
        if (runpodStatus.pod_id) {
            const url = `https://console.runpod.io/pods?id=${runpodStatus.pod_id}&inspectorTab=telemetry`;
            window.open(url, "_blank");
        } else {
            showToast("Pod Info", "Pod ID not detected", "warn");
        }
    });

    const restartBtn = createItem("Restart Pod", () => {
        if (runpodStatus.pod_id) {
            executeRestart();
        } else {
            showToast("Restart Pod", "Pod ID not detected", "warn");
        }
    });

    const toggleTimerBtn = createItem(timerState.enabled ? "Disable shutdown timer" : "Enable shutdown timer", () => {
        timerState.enabled = !timerState.enabled;
        toggleTimerBtn.textContent = timerState.enabled ? "Disable shutdown timer" : "Enable shutdown timer";
        if (timerState.enabled) {
            resetTimer();
        } else {
            pauseTimer();
        }
    });

    const resetTimerBtn = createItem("Reset shutdown timer", () => {
        resetTimer();
        showToast("Timer Reset", `Shutdown timer reset to ${getConfiguredMinutes()} minutes.`, "success");
    });

    menu.appendChild(outputsBtn);
    menu.appendChild(fbBtn);
    menu.appendChild(infoBtn);
    menu.appendChild(restartBtn);
    menu.appendChild(toggleTimerBtn);
    menu.appendChild(resetTimerBtn);

    document.body.appendChild(menu);
    unifiedDropdownMenu = menu;
    return menu;
}

function toggleRunPodMenu(event) {
    event?.stopPropagation?.();
    const btn = document.querySelector('button[aria-label="RunPod Control"]');
    if (!btn) return;
    
    if (unifiedDropdownMenu && unifiedDropdownMenu.style.display === "flex") {
        hideAllDropdowns();
        return;
    }

    const menu = ensureUnifiedDropdown(btn);
    // Ensure toggle button text is current
    const toggleBtn = Array.from(menu.children).find(c => c.textContent.includes("shutdown timer"));
    if (toggleBtn) {
        toggleBtn.textContent = timerState.enabled ? "Disable shutdown timer" : "Enable shutdown timer";
    }

    const rect = btn.getBoundingClientRect();
    menu.style.left = `${Math.round(rect.left)}px`;
    menu.style.top = `${Math.round(rect.bottom + 6)}px`;
    menu.style.display = "flex";
}

// Centered Glassmorphism Countdown Overlay
function showCountdownOverlay() {
    if (countdownOverlay) {
        const secText = countdownOverlay.querySelector(".rp-countdown-seconds");
        if (secText) {
            const mins = Math.floor(timerState.secondsLeft / 60);
            const secs = timerState.secondsLeft % 60;
            secText.textContent = `${mins}:${secs.toString().padStart(2, "0")}`;
        }
        return;
    }

    const overlay = document.createElement("div");
    overlay.id = "runpod-countdown-overlay";
    Object.assign(overlay.style, {
        position: "fixed",
        inset: "0",
        background: "rgba(0, 0, 0, 0.65)",
        backdropFilter: "blur(12px)",
        webkitBackdropFilter: "blur(12px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: "100000",
        fontFamily: "inherit",
        animation: "rpFadeIn 0.3s ease forwards"
    });

    const styleTag = document.createElement("style");
    styleTag.textContent = `
        @keyframes rpFadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes rpPulse { 
            0% { transform: scale(1); filter: drop-shadow(0 0 0px rgba(255, 75, 75, 0)); }
            50% { transform: scale(1.05); filter: drop-shadow(0 0 15px rgba(255, 75, 75, 0.4)); }
            100% { transform: scale(1); filter: drop-shadow(0 0 0px rgba(255, 75, 75, 0)); }
        }
    `;
    document.head.appendChild(styleTag);

    const card = document.createElement("div");
    Object.assign(card.style, {
        background: "var(--modal-panel-background, #1f2128)",
        border: "1px solid rgba(255, 75, 75, 0.3)",
        borderRadius: "16px",
        padding: "32px",
        width: "360px",
        textAlign: "center",
        boxShadow: "0 10px 30px rgba(0, 0, 0, 0.5)"
    });

    const title = document.createElement("div");
    title.textContent = "⚠️ Pod Shutting Down";
    Object.assign(title.style, {
        fontSize: "18px",
        fontWeight: "600",
        color: "var(--desc-text, #ff4b4b)",
        marginBottom: "16px"
    });

    const mins = Math.floor(timerState.secondsLeft / 60);
    const secs = timerState.secondsLeft % 60;
    const timeDisplay = document.createElement("div");
    timeDisplay.className = "rp-countdown-seconds";
    timeDisplay.textContent = `${mins}:${secs.toString().padStart(2, "0")}`;
    Object.assign(timeDisplay.style, {
        fontSize: "48px",
        fontWeight: "700",
        fontFamily: "monospace",
        color: "var(--input-text, #fff)",
        marginBottom: "24px",
        animation: timerState.secondsLeft < 30 ? "rpPulse 1.2s infinite ease-in-out" : "none"
    });

    const btnReset = document.createElement("button");
    btnReset.textContent = `Reset Timer (${getConfiguredMinutes()} min)`;
    Object.assign(btnReset.style, {
        width: "100%",
        padding: "12px",
        border: "none",
        borderRadius: "8px",
        background: "var(--comfy-menu-primary-bg, #007bff)",
        color: "#fff",
        fontWeight: "600",
        cursor: "pointer",
        marginBottom: "10px",
        fontSize: "14px"
    });
    btnReset.addEventListener("click", () => {
        resetTimer();
    });

    const btnShutdown = document.createElement("button");
    btnShutdown.textContent = "Shut Down Now";
    Object.assign(btnShutdown.style, {
        width: "100%",
        padding: "12px",
        border: "1px solid rgba(255, 75, 75, 0.4)",
        borderRadius: "8px",
        background: "transparent",
        color: "#ff4b4b",
        fontWeight: "600",
        cursor: "pointer",
        fontSize: "14px"
    });
    btnShutdown.addEventListener("click", () => {
        hideCountdownOverlay();
        executeShutdown();
    });

    card.appendChild(title);
    card.appendChild(timeDisplay);
    card.appendChild(btnReset);
    card.appendChild(btnShutdown);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    countdownOverlay = overlay;
}

function hideCountdownOverlay() {
    if (countdownOverlay) {
        countdownOverlay.remove();
        countdownOverlay = null;
    }
}

function queueUpdateUI() {
    if (decorateQueued) return;
    decorateQueued = true;
    requestAnimationFrame(() => {
        decorateQueued = false;
        updateButtonUI();
    });
}

// Global click listeners to auto-dismiss menus
document.addEventListener("click", () => {
    hideAllDropdowns();
});

// Extension registration
app.registerExtension({
    name: "ComfyUI_RunPod_Control",
    actionBarButtons: [
        {
            icon: "pi pi-power-off",
            tooltip: "RunPod Control",
            onClick: toggleRunPodMenu
        }
    ],
    settings: [
        {
            id: "runpod.shutdown_minutes",
            category: ["RunPod Control", "Shutdown Timer", "Duration"],
            name: "Shutdown Duration (minutes)",
            type: "number",
            defaultValue: 30,
            tooltip: "How long the pod should remain idle after all jobs finish before shutting down.",
            attrs: { min: 1, max: 1440, step: 1 },
            onChange(value) {
                if (typeof value === "number" && value > 0) {
                    if (!timerState.jobActive && timerState.enabled) {
                        resetTimer();
                    } else {
                        timerState.secondsLeft = value * 60;
                        updateButtonUI();
                    }
                }
            }
        },
        {
            id: "runpod.filebrowser_type",
            category: ["RunPod Control", "FileBrowser", "URL Mode"],
            name: "FileBrowser URL Mode",
            type: "combo",
            defaultValue: "relative_path",
            tooltip: "Choose whether FileBrowser is served as a subpath on Comfy's URL (via Nginx proxy) or on a separate RunPod port.",
            options: [
                { value: "relative_path", text: "ComfyUI Subpath (e.g. /files/ via Nginx)" },
                { value: "separate_port", text: "Separate Proxy Port (e.g. 8080)" }
            ],
            onChange() {
                fetchRunPodStatus().then(() => queueUpdateUI());
            }
        },
        {
            id: "runpod.filebrowser_relative_path",
            category: ["RunPod Control", "FileBrowser", "Relative Path"],
            name: "FileBrowser Relative Path",
            type: "text",
            defaultValue: "/files/",
            tooltip: "The subpath route on your main URL that routes to FileBrowser.",
            onChange() {
                fetchRunPodStatus().then(() => queueUpdateUI());
            }
        },
        {
            id: "runpod.filebrowser_port",
            category: ["RunPod Control", "FileBrowser", "Local Port"],
            name: "FileBrowser Local Port",
            type: "number",
            defaultValue: 8080,
            tooltip: "The local container port where the FileBrowser service is running (used to verify if the service is active).",
            onChange() {
                fetchRunPodStatus().then(() => queueUpdateUI());
            }
        },
        {
            id: "runpod.filebrowser_visibility",
            category: ["RunPod Control", "FileBrowser", "Visibility"],
            name: "FileBrowser Visibility",
            type: "combo",
            defaultValue: "auto_detect",
            tooltip: "Choose whether the button should auto-hide when the FileBrowser port check fails, or be permanently displayed.",
            options: [
                { value: "auto_detect", text: "Auto-detect service status" },
                { value: "always_show", text: "Always show button" }
            ],
            onChange() {
                fetchRunPodStatus().then(() => queueUpdateUI());
            }
        },
        {
            id: "runpod.shutdown_action",
            category: ["RunPod Control", "Shutdown Timer", "Shutdown Behavior"],
            name: "Shutdown Behavior",
            type: "combo",
            defaultValue: "stop_and_remove",
            tooltip: "Select whether the timer should just stop the pod (retaining storage) or stop and remove/terminate it entirely.",
            options: [
                { value: "stop_only", text: "Stop Only (keep disk & files)" },
                { value: "stop_and_remove", text: "Stop and Remove (terminate pod)" }
            ]
        }
    ],
    setup() {
        fetchRunPodStatus().then((isRunPod) => {
            if (!isRunPod) return;

            timerState.secondsLeft = getConfiguredMinutes() * 60;

            // MutationObserver to place buttons dynamically when action bar renders/updates
            const uiObserver = new MutationObserver((mutations) => {
                let selfTriggered = false;
                for (const m of mutations) {
                    const target = m.target;
                    if (target && target.closest && (
                        target.closest("#runpod-unified-dropdown") ||
                        target.closest("#runpod-countdown-overlay")
                    )) {
                        selfTriggered = true;
                        break;
                    }
                }
                if (!selfTriggered) {
                    queueUpdateUI();
                }
            });
            uiObserver.observe(document.body, { childList: true, subtree: true });

            // CRITICAL: call immediately — the DOM may already be fully rendered
            queueUpdateUI();

            setupJobDetection();
            startTimerCountdown();
        }).catch((err) => {
            console.error("[RunPod Control] Error in setup:", err);
        });
    }
});
