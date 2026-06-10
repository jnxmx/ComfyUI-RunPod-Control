import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

// Configuration constants
const TIMER_BUTTON_TOOLTIP = "RunPod Shutdown Timer";
const TIMER_BUTTON_SELECTOR = `button[aria-label="${TIMER_BUTTON_TOOLTIP}"]`;
const FB_BUTTON_TOOLTIP = "RunPod FileBrowser";
const FB_BUTTON_SELECTOR = `button[aria-label="${FB_BUTTON_TOOLTIP}"]`;

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
let timerDropdownMenu = null;
let fbDropdownMenu = null;
let countdownOverlay = null;
let timerButtonVisuals = new Map();
let fbButtonVisuals = new Map();
let decorateQueued = false;

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
        const val = settingsUi.getSettingValue("runpod.shutdown_minutes");
        if (typeof val === "number" && val > 0) return val;
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

                if (fbType === "relative_path") {
                    const origin = window.location.origin.replace(/\/$/, "");
                    runpodStatus.filebrowser_url = `${origin}${cleanSubpath}`;
                    runpodStatus.output_url = `${origin}${cleanSubpath}output/`;
                } else if (runpodStatus.filebrowser_active && fbType === "separate_port") {
                    const activePort = runpodStatus.filebrowser_port || port;
                    const podId = runpodStatus.pod_id || proxyInfo.podId || window.location.hostname;
                    runpodStatus.filebrowser_url = `https://${podId}-${activePort}.proxy.runpod.net${cleanSubpath}`;
                    runpodStatus.output_url = `https://${podId}-${activePort}.proxy.runpod.net${cleanSubpath}output/`;
                } else if (forceShow && !runpodStatus.filebrowser_url) {
                    // Fallback URL generation if separate port was selected but port check failed
                    const podId = runpodStatus.pod_id || proxyInfo.podId || window.location.hostname;
                    runpodStatus.filebrowser_url = `https://${podId}-${port}.proxy.runpod.net${cleanSubpath}`;
                    runpodStatus.output_url = `https://${podId}-${port}.proxy.runpod.net${cleanSubpath}output/`;
                }

                // OVERRIDE: Check if we are accessed via direct TCP IP connection (bypassing HTTP proxy)
                const isIpAddress = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(window.location.hostname);
                const currentPort = window.location.port ? parseInt(window.location.port, 10) : null;
                const comfyuiInternalPorts = runpodStatus.comfyui_ports || [8188];
                
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

    // Instantly redirect the browser window to RunPod console
    // so the user does not get stuck on a freezing/hanging webpage as the pod dies
    window.location.href = "https://console.runpod.io/";
}

// Update the Top Action Bar Timer Button display
function updateTimerButtonUI() {
    const buttons = document.querySelectorAll(TIMER_BUTTON_SELECTOR);
    buttons.forEach((btn) => {
        const labelSpan = btn.querySelector(".rp-timer-label");
        if (!labelSpan) return;

        if (!timerState.enabled) {
            labelSpan.textContent = "no shutdown";
            btn.style.color = "var(--input-text-disabled, #777)";
            return;
        }

        btn.style.color = "";
        if (timerState.jobActive) {
            labelSpan.textContent = `shutdown in ${getConfiguredMinutes()}m`;
        } else {
            const mins = Math.ceil(timerState.secondsLeft / 60);
            labelSpan.textContent = `shutdown in ${mins}m`;
        }
    });
}

// Start, Pause, Reset Timer logic
function resetTimer() {
    timerState.secondsLeft = getConfiguredMinutes() * 60;
    hideCountdownOverlay();
    updateTimerButtonUI();
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
        updateTimerButtonUI();

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
    updateTimerButtonUI();
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
    if (timerDropdownMenu) timerDropdownMenu.style.display = "none";
    if (fbDropdownMenu) fbDropdownMenu.style.display = "none";
}

function ensureTimerDropdown(buttonEl) {
    if (timerDropdownMenu) return timerDropdownMenu;

    const menu = document.createElement("div");
    menu.id = "runpod-timer-dropdown";
    Object.assign(menu.style, {
        position: "absolute",
        background: "var(--base-background, #1f2128)",
        border: "1px solid var(--interface-stroke, #3c3c3c)",
        borderRadius: "8px",
        boxShadow: "var(--shadow-interface, 0 8px 20px rgba(0,0,0,0.5))",
        padding: "4px 0",
        display: "none",
        flexDirection: "column",
        zIndex: "10001",
        fontFamily: "inherit"
    });

    const createItem = (text, onClick) => {
        const item = document.createElement("button");
        item.type = "button";
        item.textContent = text;
        Object.assign(item.style, {
            border: "none",
            background: "transparent",
            color: "var(--input-text, #ddd)",
            padding: "8px 16px",
            textAlign: "left",
            cursor: "pointer",
            width: "100%",
            fontSize: "12px",
            fontFamily: "inherit"
        });
        item.addEventListener("mouseenter", () => item.style.background = "var(--primary-hover-bg, #2b2f3a)");
        item.addEventListener("mouseleave", () => item.style.background = "transparent");
        item.addEventListener("click", (e) => {
            e.stopPropagation();
            hideAllDropdowns();
            onClick();
        });
        return item;
    };

    const disableBtn = createItem(timerState.enabled ? "Disable Shutdown" : "Enable Shutdown", () => {
        timerState.enabled = !timerState.enabled;
        disableBtn.textContent = timerState.enabled ? "Disable Shutdown" : "Enable Shutdown";
        if (timerState.enabled) {
            resetTimer();
        } else {
            pauseTimer();
        }
    });

    const infoBtn = createItem("Pod telemetry info ↗", () => {
        if (runpodStatus.pod_id) {
            const url = `https://console.runpod.io/pods?id=${runpodStatus.pod_id}&inspectorTab=telemetry`;
            window.open(url, "_blank");
        } else {
            showToast("Pod Info", "Pod ID not detected", "warn");
        }
    });

    menu.appendChild(disableBtn);
    menu.appendChild(infoBtn);
    document.body.appendChild(menu);
    timerDropdownMenu = menu;
    return menu;
}

function ensureFileBrowserDropdown(buttonEl) {
    if (fbDropdownMenu) return fbDropdownMenu;

    const menu = document.createElement("div");
    menu.id = "runpod-fb-dropdown";
    Object.assign(menu.style, {
        position: "absolute",
        background: "var(--base-background, #1f2128)",
        border: "1px solid var(--interface-stroke, #3c3c3c)",
        borderRadius: "8px",
        boxShadow: "var(--shadow-interface, 0 8px 20px rgba(0,0,0,0.5))",
        padding: "4px 0",
        display: "none",
        flexDirection: "column",
        zIndex: "10001",
        fontFamily: "inherit"
    });

    const createItem = (text, onClick) => {
        const item = document.createElement("button");
        item.type = "button";
        item.textContent = text;
        Object.assign(item.style, {
            border: "none",
            background: "transparent",
            color: "var(--input-text, #ddd)",
            padding: "8px 16px",
            textAlign: "left",
            cursor: "pointer",
            width: "100%",
            fontSize: "12px",
            fontFamily: "inherit"
        });
        item.addEventListener("mouseenter", () => item.style.background = "var(--primary-hover-bg, #2b2f3a)");
        item.addEventListener("mouseleave", () => item.style.background = "transparent");
        item.addEventListener("click", (e) => {
            e.stopPropagation();
            hideAllDropdowns();
            onClick();
        });
        return item;
    };

    const outputBtn = createItem("Open output folder ↗", () => {
        if (runpodStatus.output_url) {
            window.open(runpodStatus.output_url, "_blank");
        }
    });

    menu.appendChild(outputBtn);
    document.body.appendChild(menu);
    fbDropdownMenu = menu;
    return menu;
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

// Finder to find Comfy's Run button or action bar container to insert next to it
function findRunButtonGroup() {
    // Strategy 1: New Vue-based ComfyUI actionbar (2024+)
    // The queue overlay toggle button is a reliable anchor in the new UI
    const queueOverlayToggle = document.querySelector('[data-testid="queue-overlay-toggle"]');
    if (queueOverlayToggle) {
        // Walk up to find the flex container that holds all actionbar buttons
        const flexContainer = queueOverlayToggle.closest('.relative.flex.items-center');
        if (flexContainer) return flexContainer;
        // Fallback: the panel content wrapper
        const panelContent = queueOverlayToggle.parentElement;
        if (panelContent) return panelContent;
    }

    // Strategy 2: Legacy class-based selectors
    let runBtn = document.querySelector(".comfy-play-button") ||
                 document.querySelector(".comfyui-queue-button") ||
                 document.getElementById("queue-button");

    // Strategy 3: Text-content scan (handles icon+text buttons with innerHTML)
    if (!runBtn) {
        const buttons = document.querySelectorAll("button");
        for (const btn of buttons) {
            if (btn.closest("#runpod-control-container")) continue;
            // Use innerText (respects visibility) or textContent stripped of whitespace
            const text = (btn.innerText || btn.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
            if (
                text === "run" || text === "queue" || text === "queue prompt" ||
                text.startsWith("run ") || text.startsWith("queue ")
            ) {
                runBtn = btn;
                break;
            }
        }
    }

    if (runBtn) {
        return runBtn.closest(".comfyui-button-group") ||
               runBtn.closest(".comfy-menu-queue-group") ||
               runBtn.parentElement ||
               runBtn;
    }
    return null;
}

function queueDecorateButtons() {
    if (decorateQueued) return;
    decorateQueued = true;
    requestAnimationFrame(() => {
        decorateQueued = false;
        decorateButtons();
    });
}

// Setup top action bar UI components
function decorateButtons() {
    if (!runpodStatus.is_runpod) return;

    const targetGroup = findRunButtonGroup();
    if (!targetGroup) {
        console.debug("[RunPod Control] findRunButtonGroup() returned null, will retry");
        return;
    }

    let container = document.getElementById("runpod-control-container");
    if (!container) {
        container = document.createElement("div");
        container.id = "runpod-control-container";
        Object.assign(container.style, {
            display: "inline-flex",
            alignItems: "center",
            gap: "8px",
            marginRight: "8px",
            marginLeft: "4px",
            verticalAlign: "middle"
        });
    }

    // Determine if targetGroup is the actionbar container itself (new Vue UI)
    // or a sibling element to insert before (legacy UI).
    // In new Vue UI: findRunButtonGroup() returns the flex parent that CONTAINS the run button.
    // In legacy UI: it returns the .comfyui-button-group which is a SIBLING to insert before.
    const isContainerItself = targetGroup.contains(document.querySelector('[data-testid="queue-overlay-toggle"]'));

    if (isContainerItself) {
        // New Vue UI: prepend inside the flex container
        // Skip the drag-handle span which should remain first
        if (container.parentNode !== targetGroup) {
            const dragHandle = targetGroup.querySelector('.drag-handle, [class*="drag-handle"]');
            if (dragHandle && dragHandle.parentNode === targetGroup) {
                targetGroup.insertBefore(container, dragHandle.nextSibling);
            } else {
                targetGroup.insertBefore(container, targetGroup.firstChild);
            }
        }
    } else {
        // Legacy UI: insert our container before the button-group element
        if (targetGroup.parentNode) {
            if (container.parentNode !== targetGroup.parentNode || container.nextSibling !== targetGroup) {
                targetGroup.parentNode.insertBefore(container, targetGroup);
            }
        }
    }

    // 1. Timer button setup
    let timerBtn = container.querySelector(TIMER_BUTTON_SELECTOR);
    if (!timerBtn) {
        timerBtn = document.createElement("button");
        timerBtn.className = "comfyui-button comfy-menu-btn";
        timerBtn.setAttribute("aria-label", TIMER_BUTTON_TOOLTIP);
        timerBtn.setAttribute("title", TIMER_BUTTON_TOOLTIP);
        Object.assign(timerBtn.style, {
            padding: "6px 12px",
            minWidth: "110px",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            borderRadius: "4px",
            fontSize: "12px",
            fontWeight: "500",
            border: "1px solid var(--interface-stroke, #3c3c3c)",
            background: "var(--primary-bg, #222)",
            color: "var(--input-text, #ddd)"
        });

        timerBtn.addEventListener("mouseenter", (e) => {
            const labelSpan = timerBtn.querySelector(".rp-timer-label");
            if (labelSpan && timerState.enabled) {
                labelSpan.textContent = "reset timer";
            }
            const menu = ensureTimerDropdown(timerBtn);
            const rect = timerBtn.getBoundingClientRect();
            menu.style.left = `${Math.round(rect.left)}px`;
            menu.style.top = `${Math.round(rect.bottom + 6)}px`;
            menu.style.display = "flex";
        });

        timerBtn.addEventListener("mouseleave", (e) => {
            const labelSpan = timerBtn.querySelector(".rp-timer-label");
            if (labelSpan && timerState.enabled) {
                const mins = Math.ceil(timerState.secondsLeft / 60);
                labelSpan.textContent = timerState.jobActive ? `shutdown in ${getConfiguredMinutes()}m` : `shutdown in ${mins}m`;
            }
            setTimeout(() => {
                if (timerDropdownMenu && !timerDropdownMenu.matches(":hover") && !timerBtn.matches(":hover")) {
                    timerDropdownMenu.style.display = "none";
                }
            }, 100);
        });

        timerBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            if (timerState.enabled) {
                resetTimer();
                showToast("Timer Reset", `Shutdown timer reset to ${getConfiguredMinutes()} minutes.`, "success");
            }
        });

        container.appendChild(timerBtn);
    }

    if (!timerBtn.querySelector(".rp-timer-wrap")) {
        timerBtn.innerHTML = `
            <span class="rp-timer-wrap" style="display:flex; align-items:center; gap:6px;">
                <span class="pi pi-power-off"></span>
                <span class="rp-timer-label">shutdown in ${getConfiguredMinutes()}m</span>
            </span>
        `;
    }

    // 2. FileBrowser button setup
    let fbBtn = container.querySelector(FB_BUTTON_SELECTOR);
    if (runpodStatus.filebrowser_active) {
        if (!fbBtn) {
            fbBtn = document.createElement("button");
            fbBtn.className = "comfyui-button comfy-menu-btn";
            fbBtn.setAttribute("aria-label", FB_BUTTON_TOOLTIP);
            fbBtn.setAttribute("title", FB_BUTTON_TOOLTIP);
            Object.assign(fbBtn.style, {
                padding: "6px 12px",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                borderRadius: "4px",
                fontSize: "12px",
                fontWeight: "500",
                border: "1px solid var(--interface-stroke, #3c3c3c)",
                background: "var(--primary-bg, #222)",
                color: "var(--input-text, #ddd)"
            });

            fbBtn.addEventListener("mouseenter", (e) => {
                if (runpodStatus.output_url) {
                    const menu = ensureFileBrowserDropdown(fbBtn);
                    const rect = fbBtn.getBoundingClientRect();
                    menu.style.left = `${Math.round(rect.left)}px`;
                    menu.style.top = `${Math.round(rect.bottom + 6)}px`;
                    menu.style.display = "flex";
                }
            });

            fbBtn.addEventListener("mouseleave", () => {
                setTimeout(() => {
                    if (fbDropdownMenu && !fbDropdownMenu.matches(":hover") && !fbBtn.matches(":hover")) {
                        fbDropdownMenu.style.display = "none";
                    }
                }, 100);
            });

            fbBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                if (runpodStatus.filebrowser_url) {
                    window.open(runpodStatus.filebrowser_url, "_blank");
                }
            });

            container.appendChild(fbBtn);
        }

        if (!fbBtn.querySelector(".rp-fb-wrap")) {
            fbBtn.innerHTML = `
                <span class="rp-fb-wrap" style="display:flex; align-items:center; gap:6px;">
                    <span class="pi pi-folder"></span>
                    <span>FileBrowser</span>
                </span>
            `;
        }
        fbBtn.style.display = "";
    } else if (fbBtn) {
        fbBtn.style.display = "none";
    }

    updateTimerButtonUI();
}

// Global click/resize listeners to auto-dismiss menus
document.addEventListener("click", () => {
    hideAllDropdowns();
});

window.addEventListener("resize", () => {
    hideAllDropdowns();
});

// Extension registration
app.registerExtension({
    name: "ComfyUI_RunPod_Control",
    settings: [
        {
            id: "runpod.shutdown_minutes",
            category: ["RunPod Control", "Shutdown Timer", "Duration"],
            name: "Shutdown Duration (minutes)",
            type: "number",
            defaultValue: 30,
            tooltip: "How long the pod should remain idle after all jobs finish before shutting down.",
            attrs: { min: 1, max: 1440, step: 1 }
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
            ]
        },
        {
            id: "runpod.filebrowser_relative_path",
            category: ["RunPod Control", "FileBrowser", "Relative Path"],
            name: "FileBrowser Relative Path",
            type: "text",
            defaultValue: "/files/",
            tooltip: "The subpath route on your main URL that routes to FileBrowser."
        },
        {
            id: "runpod.filebrowser_port",
            category: ["RunPod Control", "FileBrowser", "Local Port"],
            name: "FileBrowser Local Port",
            type: "number",
            defaultValue: 8080,
            tooltip: "The local container port where the FileBrowser service is running (used to verify if the service is active)."
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
            ]
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
                        target.closest("#runpod-control-container") ||
                        target.closest("#runpod-timer-dropdown") ||
                        target.closest("#runpod-fb-dropdown") ||
                        target.closest("#runpod-countdown-overlay")
                    )) {
                        selfTriggered = true;
                        break;
                    }
                }
                if (!selfTriggered) {
                    queueDecorateButtons();
                }
            });
            uiObserver.observe(document.body, { childList: true, subtree: true });

            // CRITICAL: call immediately — the DOM may already be fully rendered
            // by the time fetchRunPodStatus() resolves, so the observer alone isn't enough
            queueDecorateButtons();

            // Set up drop-down menus logic
            document.body.addEventListener("mouseover", (e) => {
                if (timerDropdownMenu && timerDropdownMenu.style.display === "flex") {
                    const timerBtn = document.querySelector(TIMER_BUTTON_SELECTOR);
                    if (!timerDropdownMenu.contains(e.target) && !timerBtn?.contains(e.target)) {
                        timerDropdownMenu.style.display = "none";
                    }
                }
                if (fbDropdownMenu && fbDropdownMenu.style.display === "flex") {
                    const fbBtn = document.querySelector(FB_BUTTON_SELECTOR);
                    if (!fbDropdownMenu.contains(e.target) && !fbBtn?.contains(e.target)) {
                        fbDropdownMenu.style.display = "none";
                    }
                }
            });

            setupJobDetection();
            startTimerCountdown();
        }).catch((err) => {
            console.error("[RunPod Control] Error in setup:", err);
        });
    }
});
