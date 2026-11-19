import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

console.log("[RunPod Control] v1.0.29 loaded");

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

const RUNPOD_MENU_STYLE_ID = "runpod-control-native-menu-style";
const RUNPOD_BUTTON_SELECTOR = 'button[aria-label="RunPod Control"]';
const ACTIONBAR_STRIP_CLASSES = [
    "bg-transparent",
    "text-muted-foreground",
    "h-6",
    "h-7",
    "rounded-sm",
    "rounded-full",
    "px-2",
    "py-1"
];
const NATIVE_TRIGGER_CLASSES = [
    "runpod-control-btn",
    "relative",
    "inline-flex",
    "cursor-pointer",
    "touch-manipulation",
    "appearance-none",
    "items-center",
    "justify-center",
    "border-none",
    "font-inter",
    "text-xs",
    "font-medium",
    "whitespace-nowrap",
    "transition-colors",
    "focus-visible:ring-1",
    "focus-visible:ring-ring",
    "focus-visible:outline-none",
    "disabled:pointer-events-none",
    "disabled:opacity-50",
    "bg-secondary",
    "text-foreground",
    "hover:bg-accent",
    "group",
    "h-8",
    "gap-1.5",
    "rounded-lg",
    "pr-1.5",
    "pl-2.5",
    "data-[state=open]:bg-accent"
];
const NATIVE_MENU_CONTAINER_CLASS =
    "z-3000 min-w-52 overflow-y-auto rounded-lg border border-solid border-border bg-background p-1 text-foreground shadow-lg outline-none";
const NATIVE_MENU_ITEM_CLASS =
    "group flex min-h-8 w-full cursor-pointer appearance-none items-center gap-2 rounded-sm border-0 bg-transparent px-2 py-1 text-left font-inter text-xs text-foreground outline-none transition-colors hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-50";

function ensureRunPodButtonStyles() {
    if (document.getElementById(RUNPOD_MENU_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = RUNPOD_MENU_STYLE_ID;
    style.textContent = `
        ${RUNPOD_BUTTON_SELECTOR}[data-state="open"] .runpod-control-chevron {
            transform: none;
            rotate: 180deg;
        }
    `;
    document.head.appendChild(style);
}

function syncRunPodButtonOpenState(isOpenOverride = null) {
    const isOpen =
        isOpenOverride !== null
            ? Boolean(isOpenOverride)
            : Boolean(unifiedDropdownMenu && unifiedDropdownMenu.style.display === "flex");
    const stateVal = isOpen ? "open" : "closed";
    const expandedVal = String(isOpen);
    document.querySelectorAll(RUNPOD_BUTTON_SELECTOR).forEach((btn) => {
        if (btn.getAttribute("data-state") !== stateVal) {
            btn.setAttribute("data-state", stateVal);
        }
        if (btn.getAttribute("aria-expanded") !== expandedVal) {
            btn.setAttribute("aria-expanded", expandedVal);
        }
    });
}

// =========================================================================
// Compact Resource Monitor (RunPod-style horseshoe gauges, <= 32px height)
// =========================================================================
const RESOURCE_MONITOR_ID = "runpod-resource-monitor";
let resourceMonitorTimerId = null;
let lastMonitorData = null;

function getMonitorSetting(id, fallback) {
    const settingsUi = app?.ui?.settings;
    if (settingsUi?.getSettingValue) {
        const val = settingsUi.getSettingValue(id);
        if (val !== undefined && val !== null) return val;
    }
    return fallback;
}

function isResourceMonitorEnabled() {
    return getMonitorSetting("runpod.monitor.enabled", true) !== false;
}

function getMonitorColor(value, isTemp = false) {
    if (isTemp) {
        if (value < 60) return "#6764f6";
        if (value < 75) return "#38bdf8";
        if (value < 85) return "#f59e0b";
        return "#ef4444";
    }
    if (value < 50) return "#6764f6";
    if (value < 75) return "#38bdf8";
    if (value < 90) return "#f59e0b";
    return "#ef4444";
}

function formatBytesGiB(bytes) {
    if (typeof bytes !== "number" || bytes < 0) return "?";
    return (bytes / (1024 ** 3)).toFixed(1) + " GiB";
}

function polarToCartesian(cx, cy, r, angleDeg) {
    const rad = (angleDeg * Math.PI) / 180;
    return {
        x: cx + r * Math.cos(rad),
        y: cy + r * Math.sin(rad)
    };
}

function describeArc(cx, cy, r, startAngle, endAngle) {
    const start = polarToCartesian(cx, cy, r, startAngle);
    const end = polarToCartesian(cx, cy, r, endAngle);
    const sweep = endAngle - startAngle;
    const largeArcFlag = sweep > 180 ? "1" : "0";
    return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${r} ${r} 0 ${largeArcFlag} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
}

// Track spans 145° -> 395° (250° arc, leaving a wide 110° bottom gap so ends never touch %)
const GAUGE_START_DEG = 145;
const GAUGE_SPAN_DEG = 250;
const GAUGE_CX = 18;
const GAUGE_CY = 15.6;
const GAUGE_R = 14.3;
const GAUGE_TRACK_D = describeArc(GAUGE_CX, GAUGE_CY, GAUGE_R, GAUGE_START_DEG, GAUGE_START_DEG + GAUGE_SPAN_DEG);

function buildGaugeSvg(label, pct, displayValue, tooltip, isTemp = false) {
    const valid = typeof pct === "number" && pct >= 0;
    const clamped = valid ? Math.max(0, Math.min(100, pct)) : 0;
    const color = valid ? getMonitorColor(isTemp ? pct : clamped, isTemp) : "rgba(255,255,255,0.2)";
    const fillEnd = GAUGE_START_DEG + (GAUGE_SPAN_DEG * clamped) / 100;
    const fillPath = clamped > 0.5
        ? `<path d="${describeArc(GAUGE_CX, GAUGE_CY, GAUGE_R, GAUGE_START_DEG, fillEnd)}" fill="none" stroke="${color}" stroke-width="2.6" stroke-linecap="round" style="transition: stroke 0.25s ease;" />`
        : "";
    const labelFontSize = label.length >= 4 ? "7.8" : "8.8";

    return `
        <div class="runpod-gauge-item" title="${tooltip}" style="position:relative;width:32px;height:32px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;user-select:none;cursor:default;">
            <svg viewBox="0 0 36 36" width="32" height="32" style="display:block;overflow:visible;">
                <path d="${GAUGE_TRACK_D}" fill="none" stroke="rgba(255,255,255,0.14)" stroke-width="2.6" stroke-linecap="round" />
                ${fillPath}
                <text x="18" y="15.4" text-anchor="middle" dominant-baseline="central" fill="var(--foreground, #d4d6e0)" font-family="Inter, system-ui, sans-serif" font-size="${labelFontSize}" font-weight="700" letter-spacing="-0.2">${label}</text>
                <text x="18" y="30.8" text-anchor="middle" dominant-baseline="central" fill="var(--foreground, #f4f4f8)" font-family="Inter, system-ui, sans-serif" font-size="8.6" font-weight="700" style="font-variant-numeric:tabular-nums;">${displayValue}</text>
            </svg>
        </div>
    `;
}

function renderResourceMonitor(data) {
    const container = document.getElementById(RESOURCE_MONITOR_ID);
    if (!container || !isResourceMonitorEnabled()) return;

    const showRam = getMonitorSetting("runpod.monitor.show_ram", true) !== false;
    const showGpu = getMonitorSetting("runpod.monitor.show_gpu", true) !== false;
    const showVram = getMonitorSetting("runpod.monitor.show_vram", true) !== false;
    const showHdd = getMonitorSetting("runpod.monitor.show_hdd", true) !== false;
    const showCpu = getMonitorSetting("runpod.monitor.show_cpu", false) === true;
    const showTemp = getMonitorSetting("runpod.monitor.show_temp", false) === true;

    const gauges = [];
    const gpu0 = Array.isArray(data?.gpus) && data.gpus.length > 0 ? data.gpus[0] : null;

    if (showCpu) {
        const val = data?.cpu_utilization;
        const txt = typeof val === "number" && val >= 0 ? `${Math.round(val)}%` : "--";
        gauges.push(buildGaugeSvg("CPU", val, txt, `CPU Utilization: ${txt}`));
    }
    if (showRam) {
        const val = data?.ram_used_percent;
        const txt = typeof val === "number" && val >= 0 ? `${Math.round(val)}%` : "--";
        const tip = data?.ram_total > 0
            ? `RAM: ${formatBytesGiB(data.ram_used)} / ${formatBytesGiB(data.ram_total)} (${txt})`
            : `RAM: ${txt}`;
        gauges.push(buildGaugeSvg("RAM", val, txt, tip));
    }
    if (showGpu) {
        const val = gpu0?.gpu_utilization;
        const txt = typeof val === "number" && val >= 0 ? `${Math.round(val)}%` : "--";
        const gpuName = gpu0?.name ? ` (${gpu0.name})` : "";
        gauges.push(buildGaugeSvg("GPU", val, txt, `GPU Utilization${gpuName}: ${txt}`));
    }
    if (showVram) {
        const val = gpu0?.vram_used_percent;
        const txt = typeof val === "number" && val >= 0 ? `${Math.round(val)}%` : "--";
        const tip = gpu0?.vram_total > 0
            ? `VRAM: ${formatBytesGiB(gpu0.vram_used)} / ${formatBytesGiB(gpu0.vram_total)} (${txt})`
            : `VRAM: ${txt}`;
        gauges.push(buildGaugeSvg("VRAM", val, txt, tip));
    }
    if (showTemp) {
        const val = gpu0?.gpu_temperature;
        const txt = typeof val === "number" && val >= 0 ? `${Math.round(val)}°` : "--";
        gauges.push(buildGaugeSvg("TMP", val, txt, `GPU Temperature: ${txt}C`, true));
    }
    if (showHdd) {
        const val = data?.hdd_used_percent;
        const txt = typeof val === "number" && val >= 0 ? `${Math.round(val)}%` : "--";
        const pathLabel = data?.hdd_path || getMonitorSetting("runpod.monitor.hdd_path", "/workspace");
        const tip = data?.hdd_total > 0
            ? `Disk (${pathLabel}): ${formatBytesGiB(data.hdd_used)} / ${formatBytesGiB(data.hdd_total)} (${txt})`
            : `Disk (${pathLabel}): ${txt}`;
        gauges.push(buildGaugeSvg("HDD", val, txt, tip));
    }

    container.style.display = gauges.length > 0 ? "inline-flex" : "none";
    container.innerHTML = gauges.join("");
}

const HF_DOWNLOADER_BUTTON_SELECTOR = 'button[aria-label="Hugging Face Downloader"]';

function findActionBarSlot(el) {
    let curr = el;
    while (curr && curr.parentElement && curr.parentElement !== document.body) {
        const parent = curr.parentElement;
        const display = window.getComputedStyle(parent).display || "";
        if (display.includes("flex") && parent.children.length > 1) {
            return { flexParent: parent, slot: curr };
        }
        curr = parent;
    }
    if (el?.parentElement) {
        return { flexParent: el.parentElement, slot: el };
    }
    return null;
}

function syncTopBarOrdering(runpodBtn) {
    if (!runpodBtn) return;
    const rpInfo = findActionBarSlot(runpodBtn);
    if (!rpInfo) return;
    const { flexParent, slot: rpSlot } = rpInfo;

    if (rpSlot.style.order !== "9998") {
        rpSlot.style.order = "9998";
    }

    const hfBtn = document.querySelector(HF_DOWNLOADER_BUTTON_SELECTOR);
    if (hfBtn) {
        let hfSlot = hfBtn;
        while (hfSlot && hfSlot.parentElement && hfSlot.parentElement !== flexParent) {
            hfSlot = hfSlot.parentElement;
        }
        if (hfSlot && hfSlot.parentElement === flexParent && hfSlot.style.order !== "9997") {
            hfSlot.style.order = "9997";
        }
    }
}

function updateResourceMonitorPlacement(btn) {
    syncTopBarOrdering(btn);

    let container = document.getElementById(RESOURCE_MONITOR_ID);
    if (!isResourceMonitorEnabled()) {
        if (container) container.remove();
        stopResourceMonitor();
        return;
    }

    if (!btn) return;
    const rpInfo = findActionBarSlot(btn);
    if (!rpInfo) return;

    if (!container) {
        container = document.createElement("div");
        container.id = RESOURCE_MONITOR_ID;
        Object.assign(container.style, {
            display: "inline-flex",
            alignItems: "center",
            height: "32px",
            gap: "6px",
            marginLeft: "4px",
            padding: "0",
            border: "none",
            background: "transparent",
            flexShrink: "0",
            verticalAlign: "middle",
            order: "9999"
        });
    }

    if (container.parentElement !== rpInfo.flexParent) {
        rpInfo.flexParent.appendChild(container);
    }
    if (container.style.order !== "9999") {
        container.style.order = "9999";
    }

    if (lastMonitorData) {
        renderResourceMonitor(lastMonitorData);
    } else {
        renderResourceMonitor(null);
    }

    if (!resourceMonitorTimerId) {
        startResourceMonitor();
    }
}

async function pollResourceMonitorOnce() {
    if (!isResourceMonitorEnabled()) return;
    const hddPath = encodeURIComponent(getMonitorSetting("runpod.monitor.hdd_path", "/workspace") || "/workspace");
    try {
        const res = await fetch(`/runpod/monitor?hdd_path=${hddPath}`, { cache: "no-store" });
        if (res.ok) {
            lastMonitorData = await res.json();
            renderResourceMonitor(lastMonitorData);
        }
    } catch (e) {
        // Ignore transient errors while server restarts
    }
}

function stopResourceMonitor() {
    if (resourceMonitorTimerId) {
        clearInterval(resourceMonitorTimerId);
        resourceMonitorTimerId = null;
    }
}

function startResourceMonitor() {
    stopResourceMonitor();
    if (!isResourceMonitorEnabled()) return;
    let rateSec = parseFloat(getMonitorSetting("runpod.monitor.refresh_rate", 1.5));
    if (isNaN(rateSec) || rateSec < 0.5) rateSec = 1.5;
    pollResourceMonitorOnce();
    resourceMonitorTimerId = setInterval(pollResourceMonitorOnce, Math.round(rateSec * 1000));
}

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

// Fetch configured duration from settings or env
function getConfiguredMinutes() {
    if (runpodStatus.timer?.env_duration_minutes) {
        return runpodStatus.timer.env_duration_minutes;
    }
    const settingsUi = app?.ui?.settings;
    if (settingsUi?.getSettingValue) {
        let val = settingsUi.getSettingValue("runpod.shutdown_minutes");
        if (typeof val === "string") val = parseInt(val, 10);
        if (typeof val === "number" && !isNaN(val) && val > 0) return val;
    }
    if (runpodStatus.timer?.duration_seconds) {
        return Math.round(runpodStatus.timer.duration_seconds / 60);
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

// Fetch configured shutdown timer enabled setting
function getShutdownTimerEnabled() {
    const settingsUi = app?.ui?.settings;
    if (settingsUi?.getSettingValue) {
        const val = settingsUi.getSettingValue("runpod.enable_shutdown_timer");
        if (typeof val === "boolean") return val;
    }
    return null;
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
        
        if (runpodStatus.timer) {
            timerState.enabled = runpodStatus.timer.enabled;
            timerState.secondsLeft = runpodStatus.timer.seconds_left;
            timerState.jobActive = runpodStatus.timer.job_active;
            timerState.running = timerState.enabled && !timerState.jobActive;
        }
        
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

                let cleanFbSubpath = cleanSubpath;
                if (!cleanFbSubpath.endsWith("/ComfyUI/")) {
                    cleanFbSubpath = `${cleanFbSubpath}ComfyUI/`;
                }
                const cleanOutputSubpath = `${cleanFbSubpath}output/`;

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
                    runpodStatus.filebrowser_url = `https://${podId}-${activePort}.proxy.runpod.net${cleanFbSubpath}`;
                    runpodStatus.output_url = `https://${podId}-${activePort}.proxy.runpod.net${cleanOutputSubpath}`;
                } else if (fbType === "relative_path") {
                    const origin = window.location.origin.replace(/\/$/, "");
                    runpodStatus.filebrowser_url = `${origin}${cleanFbSubpath}`;
                    runpodStatus.output_url = `${origin}${cleanOutputSubpath}`;
                } else if (forceShow && !runpodStatus.filebrowser_url) {
                    // Fallback URL generation if separate port was selected but port check failed
                    const podId = runpodStatus.pod_id || proxyInfo.podId || window.location.hostname;
                    runpodStatus.filebrowser_url = `https://${podId}-${port}.proxy.runpod.net${cleanFbSubpath}`;
                    runpodStatus.output_url = `https://${podId}-${port}.proxy.runpod.net${cleanOutputSubpath}`;
                }

                // Note: Even if ComfyUI is accessed via a direct TCP IP address,
                // FileBrowser is proxy-only (no RUNPOD_TCP_PORT_* mapping for it),
                // so we always use the https://<pod_id>-<port>.proxy.runpod.net URL.
                // No override needed here.
            }
        }
        return runpodStatus.is_runpod;
    } catch (e) {
        console.warn("[RunPod Control] Failed to fetch RunPod status from backend:", e);
        return false;
    }
}

// Show redirect countdown page
function showRedirectCountdown() {
    const existing = document.getElementById("runpod-redirect-overlay");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "runpod-redirect-overlay";
    Object.assign(overlay.style, {
        position: "fixed",
        inset: "0",
        background: "rgba(0, 0, 0, 0.8)",
        backdropFilter: "blur(8px)",
        webkitBackdropFilter: "blur(8px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: "1000000",
        fontFamily: "var(--font-inter, Inter, sans-serif)",
        color: "#fff"
    });

    const card = document.createElement("div");
    Object.assign(card.style, {
        background: "var(--base-background, var(--comfy-menu-bg, #1f2128))",
        border: "1px solid var(--interface-stroke, var(--border-color, #3c4452))",
        borderRadius: "16px",
        padding: "32px",
        textAlign: "center",
        boxShadow: "var(--shadow-interface, 0 12px 28px rgba(0, 0, 0, 0.45))",
        minWidth: "320px"
    });

    const title = document.createElement("div");
    title.textContent = "Pod Deactivated";
    Object.assign(title.style, {
        fontSize: "20px",
        fontWeight: "600",
        marginBottom: "12px",
        color: "#ff4b4b"
    });

    const desc = document.createElement("div");
    desc.textContent = "Your pod is shutting down. Redirecting to RunPod Console in:";
    Object.assign(desc.style, {
        fontSize: "14px",
        color: "var(--descrip-text, #c4c9d4)",
        marginBottom: "20px"
    });

    const number = document.createElement("div");
    let seconds = 5;
    number.textContent = seconds;
    Object.assign(number.style, {
        fontSize: "72px",
        fontWeight: "700",
        fontFamily: "monospace",
        color: "#fff",
        marginBottom: "16px"
    });

    card.appendChild(title);
    card.appendChild(desc);
    card.appendChild(number);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    const timer = setInterval(() => {
        seconds--;
        if (seconds <= 0) {
            clearInterval(timer);
            window.location.href = "https://console.runpod.io/";
        } else {
            number.textContent = seconds;
        }
    }, 1000);
}

// Perform pod shutdown
async function executeShutdown(overrideAction) {
    const action = overrideAction || getShutdownAction();
    showToast("Shutdown Triggered", "Sending terminate signal to the pod...", "warn");
    
    // Trigger the backend API call to terminate/stop the pod
    fetch("/runpod/shutdown", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action })
    }).catch(e => console.error("[RunPod Control] Backend shutdown request failed:", e));

    // Bypass leave-site prompt and redirect after countdown
    bypassBeforeUnload = true;
    window.onbeforeunload = null;
    showRedirectCountdown();
}

// Show restarting overlay and reconnection feedback
function showRestartingOverlay() {
    const existing = document.getElementById("runpod-restarting-overlay");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "runpod-restarting-overlay";
    Object.assign(overlay.style, {
        position: "fixed",
        inset: "0",
        background: "rgba(0, 0, 0, 0.8)",
        backdropFilter: "blur(8px)",
        webkitBackdropFilter: "blur(8px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: "1000000",
        fontFamily: "var(--font-inter, Inter, sans-serif)",
        color: "#fff"
    });

    const card = document.createElement("div");
    Object.assign(card.style, {
        background: "var(--base-background, var(--comfy-menu-bg, #1f2128))",
        border: "1px solid var(--interface-stroke, var(--border-color, #3c4452))",
        borderRadius: "16px",
        padding: "32px",
        textAlign: "center",
        boxShadow: "var(--shadow-interface, 0 12px 28px rgba(0, 0, 0, 0.45))",
        minWidth: "340px",
        maxWidth: "420px"
    });

    const spinner = document.createElement("div");
    Object.assign(spinner.style, {
        width: "48px",
        height: "48px",
        border: "4px solid rgba(255, 255, 255, 0.15)",
        borderTop: "4px solid var(--primary-background, #6366f1)",
        borderRadius: "50%",
        animation: "runpod-spin 1s linear infinite",
        margin: "0 auto 20px auto"
    });

    if (!document.getElementById("runpod-spinner-keyframes")) {
        const style = document.createElement("style");
        style.id = "runpod-spinner-keyframes";
        style.textContent = "@keyframes runpod-spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }";
        document.head.appendChild(style);
    }

    const title = document.createElement("div");
    title.textContent = "Restarting ComfyUI";
    Object.assign(title.style, {
        fontSize: "20px",
        fontWeight: "600",
        marginBottom: "12px",
        color: "var(--primary-background, #818cf8)"
    });

    const desc = document.createElement("div");
    desc.textContent = "ComfyUI server is restarting. Reconnecting automatically...";
    Object.assign(desc.style, {
        fontSize: "14px",
        color: "var(--descrip-text, #c4c9d4)",
        marginBottom: "12px"
    });

    const statusText = document.createElement("div");
    statusText.textContent = "Sending restart command...";
    Object.assign(statusText.style, {
        fontSize: "13px",
        color: "#9ca3af",
        fontStyle: "italic"
    });

    card.appendChild(spinner);
    card.appendChild(title);
    card.appendChild(desc);
    card.appendChild(statusText);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    return {
        card,
        updateStatus: (text) => { statusText.textContent = text; },
        remove: () => overlay.remove()
    };
}

// Perform ComfyUI server restart
async function executeRestart() {
    if (!confirm("Are you sure you want to restart ComfyUI?")) {
        return;
    }

    const ui = showRestartingOverlay();
    
    // Bypass leave-site prompt so reload happens smoothly
    bypassBeforeUnload = true;
    window.onbeforeunload = null;

    try {
        await fetch("/runpod/restart", {
            method: "POST",
            headers: { "Content-Type": "application/json" }
        });
    } catch (e) {
        // If the server drops connection immediately upon restart, that's expected
        console.warn("[RunPod Control] Restart request triggered:", e);
    }

    ui.updateStatus("Shutting down ComfyUI process...");
    await new Promise(r => setTimeout(r, 2500));

    ui.updateStatus("Waiting for ComfyUI to come back online...");

    const startTime = Date.now();
    const maxWaitMs = 120000; // 2 minutes
    const interval = setInterval(async () => {
        try {
            const res = await fetch("/runpod/status?t=" + Date.now(), { cache: "no-store" });
            if (res.ok) {
                clearInterval(interval);
                ui.updateStatus("ComfyUI is back online! Reloading interface...");
                setTimeout(() => {
                    window.location.reload();
                }, 500);
            }
        } catch (e) {
            const elapsed = Math.floor((Date.now() - startTime) / 1000);
            ui.updateStatus(`Server rebooting (${elapsed}s)...`);
            if (Date.now() - startTime > maxWaitMs) {
                clearInterval(interval);
                ui.updateStatus("Restart took longer than expected. Please reload manually.");
                const btn = document.createElement("button");
                btn.textContent = "Reload Page";
                Object.assign(btn.style, {
                    marginTop: "16px",
                    padding: "8px 16px",
                    borderRadius: "8px",
                    background: "var(--primary-background, #6366f1)",
                    color: "#fff",
                    border: "none",
                    cursor: "pointer"
                });
                btn.onclick = () => window.location.reload();
                ui.card.appendChild(btn);
            }
        }
    }, 1500);
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

function applyNativeRunPodTriggerStyling(btn) {
    for (const cls of ACTIONBAR_STRIP_CLASSES) {
        if (btn.classList.contains(cls)) {
            btn.classList.remove(cls);
        }
    }
    for (const cls of NATIVE_TRIGGER_CLASSES) {
        if (!btn.classList.contains(cls)) {
            btn.classList.add(cls);
        }
    }
    if (btn.getAttribute("data-variant") !== "secondary") {
        btn.setAttribute("data-variant", "secondary");
    }
    if (btn.getAttribute("aria-haspopup") !== "menu") {
        btn.setAttribute("aria-haspopup", "menu");
    }
    if (btn.dataset.rpNativeStyled !== "1") {
        btn.style.padding = "";
        btn.style.minWidth = "";
        btn.style.display = "";
        btn.style.alignItems = "";
        btn.style.justifyContent = "";
        btn.style.fontSize = "";
        btn.style.fontWeight = "";
        btn.style.fontFamily = "";
        btn.style.whiteSpace = "";
        // Disable original tooltip since our button renders an inline timer readout
        btn.title = "";
        btn.dataset.rpNativeStyled = "1";
    }
}

function updateButtonUI() {
    ensureRunPodButtonStyles();
    const btn = document.querySelector(RUNPOD_BUTTON_SELECTOR);
    if (!btn) return;

    applyNativeRunPodTriggerStyling(btn);

    const isActive = timerState.enabled && !timerState.jobActive;
    const isUrgent = isActive && timerState.secondsLeft < 100;
    const labelHtml = isActive
        ? `<span class="inline-flex items-center gap-1"><span class="text-xs font-medium">RunPod</span><span class="text-2xs ${isUrgent ? "text-destructive" : "text-muted-foreground"} tabular-nums">${getButtonText()}</span></span>`
        : `<span class="text-xs font-medium">RunPod</span>`;
    const chevronHtml = `<i class="runpod-control-chevron icon-[lucide--chevron-down] size-3 shrink-0 text-muted-foreground transition-transform duration-150 group-data-[state=open]:rotate-180" aria-hidden="true"></i>`;
    const htmlContent = `${labelHtml}${chevronHtml}`;

    if (btn.innerHTML !== htmlContent) {
        btn.innerHTML = htmlContent;
    }

    // Urgent state: red ring & text if timer is active and < 100s left
    if (isUrgent) {
        btn.style.color = "#ff4b4b";
        btn.style.boxShadow = "inset 0 0 0 1px rgba(255, 75, 75, 0.85)";
    } else {
        btn.style.color = "";
        btn.style.boxShadow = "";
    }
    syncRunPodButtonOpenState();
    updateResourceMonitorPlacement(btn);
}

// Start, Pause, Reset Timer logic
async function resetTimer() {
    try {
        const response = await fetch("/runpod/timer", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "reset" })
        });
        if (response.ok) {
            const data = await response.json();
            if (data.timer) {
                timerState.enabled = data.timer.enabled;
                timerState.secondsLeft = data.timer.seconds_left;
                timerState.jobActive = data.timer.job_active;
                timerState.running = timerState.enabled && !timerState.jobActive;
            }
        }
    } catch (e) {
        console.warn("[RunPod Control] Failed to reset timer on backend:", e);
    }
    hideCountdownOverlay();
    updateButtonUI();
}

function startTimerCountdown() {
    if (timerState.intervalId) clearInterval(timerState.intervalId);

    // Poll the backend status every 1 second to stay in sync
    timerState.intervalId = setInterval(async () => {
        const isRunPod = await fetchRunPodStatus();
        if (!isRunPod) return;
        
        updateButtonUI();

        // Overlay trigger condition
        const isActive = timerState.enabled && !timerState.jobActive;
        if (isActive && timerState.secondsLeft < 100) {
            showCountdownOverlay();
        } else {
            hideCountdownOverlay();
        }
    }, 1000);
}

async function pauseTimer() {
    try {
        await fetch("/runpod/timer", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "toggle", enabled: false })
        });
        await fetchRunPodStatus();
    } catch (e) {
        console.warn("[RunPod Control] Failed to pause timer on backend:", e);
    }
    hideCountdownOverlay();
    updateButtonUI();
}

// Set up event listeners for execution states
function setupJobDetection() {
    // 1. WebSocket execution events to force an immediate backend sync
    api.addEventListener("execution_start", () => {
        fetchRunPodStatus().then(() => updateButtonUI());
    });

    api.addEventListener("executed", () => {
        fetchRunPodStatus().then(() => updateButtonUI());
    });

    api.addEventListener("execution_error", () => {
        fetchRunPodStatus().then(() => updateButtonUI());
    });
}

// Dropdown Menus: Create & Hide
function hideAllDropdowns() {
    if (unifiedDropdownMenu) {
        unifiedDropdownMenu.style.display = "none";
        unifiedDropdownMenu.setAttribute("data-state", "closed");
    }
    syncRunPodButtonOpenState(false);
}

// Kill Pod custom dialog (extends ComfyDialog if available)
let ComfyDialogClass = null;
try {
    if (window?.comfyAPI?.ui?.ComfyDialog) {
        ComfyDialogClass = window.comfyAPI.ui.ComfyDialog;
    } else {
        // Fallback to import
        const uiModule = await import("../../../scripts/ui.js");
        if (uiModule && uiModule.ComfyDialog) {
            ComfyDialogClass = uiModule.ComfyDialog;
        }
    }
} catch (e) {
    console.warn("[RunPod Control] ComfyDialog import failed, fallback will be used:", e);
}

if (!ComfyDialogClass) {
    ComfyDialogClass = class {
        constructor() {
            this.element = document.createElement("div");
            this.element.className = "comfy-modal";
            Object.assign(this.element.style, {
                display: "none",
                position: "fixed",
                zIndex: "100002",
                left: "50%",
                top: "50%",
                transform: "translate(-50%, -50%)",
                background: "var(--comfy-menu-bg, #202020)",
                color: "var(--desc-text, #fff)",
                padding: "20px",
                borderRadius: "8px",
                border: "1px solid var(--border-color, #444)",
                boxShadow: "0 0 20px rgba(0,0,0,0.5)",
                minWidth: "350px",
                fontFamily: "inherit"
            });
            this.textElement = document.createElement("div");
            this.element.appendChild(this.textElement);
            document.body.appendChild(this.element);
        }
        show(html) {
            if (typeof html === "string") {
                this.textElement.innerHTML = html;
            } else {
                this.textElement.replaceChildren(html);
            }
            this.element.style.display = "flex";
            this.element.style.flexDirection = "column";
        }
        close() {
            this.element.style.display = "none";
        }
    };
}

class KillPodDialog extends ComfyDialogClass {
    constructor() {
        super();
        this.element.classList.add("runpod-kill-modal");
        
        // Match ComfyUI dialog panel variables and specs
        const TEMPLATE_SURFACE = "var(--base-background, var(--interface-panel-surface, var(--comfy-menu-bg, #1f2128)))";
        const TEMPLATE_BORDER = "var(--interface-stroke, var(--border-color, var(--border-default, #3c4452)))";
        const TEMPLATE_TEXT = "var(--input-text, var(--text-color, var(--p-text-color, #e5e7eb)))";
        const TEMPLATE_SHADOW = "var(--shadow-interface, 0 12px 28px rgba(0, 0, 0, 0.45))";

        Object.assign(this.element.style, {
            zIndex: "100002",
            minWidth: "360px",
            maxWidth: "560px",
            width: "min(560px, 100%)",
            background: TEMPLATE_SURFACE,
            border: `1px solid ${TEMPLATE_BORDER}`,
            borderRadius: "16px",
            padding: "24px",
            boxShadow: TEMPLATE_SHADOW,
            color: TEMPLATE_TEXT,
            display: "none",
            flexDirection: "column",
            gap: "14px",
            fontFamily: "var(--font-inter, Inter, sans-serif)",
            boxSizing: "border-box"
        });
    }

    showKillConfirmation() {
        let timeLeft = 60;
        let timerInterval = null;

        const container = document.createElement("div");
        Object.assign(container.style, {
            display: "flex",
            flexDirection: "column",
            gap: "14px",
            textAlign: "left",
            width: "100%"
        });

        const warningTitle = document.createElement("div");
        warningTitle.textContent = "Terminate Pod (Kill Pod)";
        Object.assign(warningTitle.style, {
            fontFamily: "Inter, Arial, sans-serif",
            fontSize: "20px",
            fontWeight: "600",
            lineHeight: "1.25",
            color: "var(--input-text, #fff)"
        });

        const warningText = document.createElement("div");
        warningText.textContent = "This will completely delete the pod and all generated files that hadn't been downloaded. This action is irreversible.";
        Object.assign(warningText.style, {
            fontSize: "14px",
            lineHeight: "1.4",
            color: "var(--descrip-text, #c4c9d4)"
        });

        const countdownDisplay = document.createElement("div");
        countdownDisplay.textContent = `Auto-terminating in ${timeLeft}s...`;
        Object.assign(countdownDisplay.style, {
            fontSize: "14px",
            fontWeight: "600",
            color: "#ff4b4b"
        });

        const buttonsRow = document.createElement("div");
        Object.assign(buttonsRow.style, {
            display: "flex",
            justifyContent: "flex-end",
            gap: "8px",
            marginTop: "4px"
        });

        const btnCancel = document.createElement("button");
        btnCancel.textContent = "Cancel";
        Object.assign(btnCancel.style, {
            minHeight: "40px",
            padding: "0.5rem 0.8rem",
            fontSize: "14px",
            fontWeight: "600",
            fontFamily: "var(--font-inter, Inter, sans-serif)",
            borderRadius: "10px",
            border: "none",
            boxShadow: "none",
            background: "var(--secondary-background, rgba(255, 255, 255, 0.08))",
            color: "var(--base-foreground, #fff)",
            cursor: "pointer",
            transition: "background-color 120ms ease, opacity 120ms ease",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            lineHeight: "1.1"
        });
        btnCancel.addEventListener("mouseenter", () => {
            btnCancel.style.background = "var(--secondary-background-hover, rgba(255, 255, 255, 0.12))";
        });
        btnCancel.addEventListener("mouseleave", () => {
            btnCancel.style.background = "var(--secondary-background, rgba(255, 255, 255, 0.08))";
        });

        const btnConfirm = document.createElement("button");
        btnConfirm.textContent = "Kill Pod Now";
        Object.assign(btnConfirm.style, {
            minHeight: "40px",
            padding: "0.5rem 0.8rem",
            fontSize: "14px",
            fontWeight: "600",
            fontFamily: "var(--font-inter, Inter, sans-serif)",
            borderRadius: "10px",
            border: "none",
            boxShadow: "none",
            background: "var(--destructive-background, #ff4b4b)",
            color: "#fff",
            cursor: "pointer",
            transition: "background-color 120ms ease, opacity 120ms ease",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            lineHeight: "1.1"
        });
        btnConfirm.addEventListener("mouseenter", () => {
            btnConfirm.style.background = "var(--destructive-background-hover, #ff6b6b)";
        });
        btnConfirm.addEventListener("mouseleave", () => {
            btnConfirm.style.background = "var(--destructive-background, #ff4b4b)";
        });

        const cleanup = () => {
            if (timerInterval) {
                clearInterval(timerInterval);
                timerInterval = null;
            }
            this.close();
        };

        btnCancel.onclick = cleanup;

        btnConfirm.onclick = () => {
            cleanup();
            executeShutdown("stop_and_remove");
        };

        timerInterval = setInterval(() => {
            timeLeft--;
            if (timeLeft <= 0) {
                cleanup();
                executeShutdown("stop_and_remove"); // Auto-kill when timer is over
            } else {
                countdownDisplay.textContent = `Auto-terminating in ${timeLeft}s...`;
            }
        }, 1000);

        // Hide default comfy close buttons if present
        const defaultCloseBtn = this.element.querySelector("button");
        if (defaultCloseBtn) {
            defaultCloseBtn.style.display = "none";
        }

        buttonsRow.appendChild(btnCancel);
        buttonsRow.appendChild(btnConfirm);

        container.appendChild(warningTitle);
        container.appendChild(warningText);
        container.appendChild(countdownDisplay);
        container.appendChild(buttonsRow);

        this.show(container);
    }
}

function ensureUnifiedDropdown(buttonEl) {
    if (unifiedDropdownMenu) return unifiedDropdownMenu;

    const menu = document.createElement("div");
    menu.id = "runpod-unified-dropdown";
    menu.setAttribute("role", "menu");
    menu.setAttribute("data-state", "closed");
    menu.className = NATIVE_MENU_CONTAINER_CLASS;
    Object.assign(menu.style, {
        position: "fixed",
        display: "none",
        flexDirection: "column",
        zIndex: "3000",
        maxHeight: "calc(100vh - 16px)",
        maxWidth: "calc(100vw - 16px)"
    });

    const createSeparator = () => {
        const sep = document.createElement("div");
        sep.setAttribute("role", "separator");
        sep.className = "my-1 h-px bg-border/50";
        return sep;
    };

    const createItem = (text, onClick, options = {}) => {
        const {
            iconClass = "",
            trailingIconClass = "",
            destructive = false
        } = options;
        const item = document.createElement("button");
        item.type = "button";
        item.setAttribute("role", "menuitem");
        item.className = NATIVE_MENU_ITEM_CLASS;

        if (iconClass) {
            const icon = document.createElement("i");
            icon.className = `${iconClass} size-3.5 shrink-0 ${destructive ? "text-destructive" : "text-muted-foreground"}`;
            icon.setAttribute("aria-hidden", "true");
            item.appendChild(icon);
        }

        const labelSpan = document.createElement("span");
        labelSpan.className = `runpod-menu-item-label min-w-0 flex-1 truncate${destructive ? " text-destructive" : ""}`;
        labelSpan.textContent = text;
        item.appendChild(labelSpan);

        if (trailingIconClass) {
            const trailingIcon = document.createElement("i");
            trailingIcon.className = `${trailingIconClass} ml-auto size-3.5 shrink-0 text-muted-foreground`;
            trailingIcon.setAttribute("aria-hidden", "true");
            item.appendChild(trailingIcon);
        }

        item.addEventListener("click", (e) => {
            e.stopPropagation();
            hideAllDropdowns();
            onClick();
        });
        return item;
    };

    const outputsBtn = createItem(
        "Outputs",
        () => {
            if (runpodStatus.output_url) window.open(runpodStatus.output_url, "_blank");
            else showToast("Outputs", "Output URL not available", "warn");
        },
        {
            iconClass: "icon-[lucide--folder-open]",
            trailingIconClass: "icon-[lucide--arrow-up-right]"
        }
    );

    const fbBtn = createItem(
        "FileBrowser",
        () => {
            if (runpodStatus.filebrowser_url) window.open(runpodStatus.filebrowser_url, "_blank");
            else showToast("FileBrowser", "FileBrowser not active", "warn");
        },
        {
            iconClass: "icon-[lucide--folder]",
            trailingIconClass: "icon-[lucide--arrow-up-right]"
        }
    );

    const infoBtn = createItem(
        "Pod Info",
        () => {
            if (runpodStatus.pod_id) {
                const url = `https://console.runpod.io/pods?id=${runpodStatus.pod_id}&inspectorTab=telemetry`;
                window.open(url, "_blank");
            } else {
                showToast("Pod Info", "Pod ID not detected", "warn");
            }
        },
        {
            iconClass: "icon-[lucide--server]",
            trailingIconClass: "icon-[lucide--arrow-up-right]"
        }
    );

    const restartBtn = createItem(
        "Restart ComfyUI",
        () => {
            executeRestart();
        },
        { iconClass: "icon-[lucide--refresh-cw]" }
    );

    const toggleTimerBtn = createItem(
        timerState.enabled ? "Disable shutdown timer" : "Enable shutdown timer",
        async () => {
            const nextEnabled = !timerState.enabled;
            try {
                const response = await fetch("/runpod/timer", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ action: "toggle", enabled: nextEnabled })
                });
                if (response.ok) {
                    const data = await response.json();
                    if (data.timer) {
                        timerState.enabled = data.timer.enabled;
                        timerState.secondsLeft = data.timer.seconds_left;
                        timerState.jobActive = data.timer.job_active;
                        timerState.running = timerState.enabled && !timerState.jobActive;
                        const settingsUi = app?.ui?.settings;
                        if (settingsUi?.setSettingValue) {
                            try {
                                settingsUi.setSettingValue("runpod.enable_shutdown_timer", timerState.enabled);
                            } catch (e) {}
                        }
                    }
                }
            } catch (e) {
                console.warn("[RunPod Control] Failed to toggle timer:", e);
            }
            const labelEl = toggleTimerBtn.querySelector(".runpod-menu-item-label");
            if (labelEl) {
                labelEl.textContent = timerState.enabled ? "Disable shutdown timer" : "Enable shutdown timer";
            }
            updateButtonUI();
        },
        { iconClass: "icon-[lucide--clock]" }
    );

    const killPodBtn = createItem(
        "Kill Pod",
        () => {
            if (runpodStatus.pod_id) {
                const dialog = new KillPodDialog();
                dialog.showKillConfirmation();
            } else {
                showToast("Kill Pod", "Pod ID not detected", "warn");
            }
        },
        {
            iconClass: "icon-[lucide--trash-2]",
            destructive: true
        }
    );

    menu.appendChild(outputsBtn);
    menu.appendChild(fbBtn);
    menu.appendChild(infoBtn);
    menu.appendChild(createSeparator());
    menu.appendChild(restartBtn);
    menu.appendChild(toggleTimerBtn);
    menu.appendChild(createSeparator());
    menu.appendChild(killPodBtn);

    document.body.appendChild(menu);
    unifiedDropdownMenu = menu;
    return menu;
}

function toggleRunPodMenu(event) {
    event?.stopPropagation?.();
    
    // Automatically reset the timer on click/menu open
    resetTimer();

    const btn = document.querySelector(RUNPOD_BUTTON_SELECTOR);
    if (!btn) return;
    
    if (unifiedDropdownMenu && unifiedDropdownMenu.style.display === "flex") {
        hideAllDropdowns();
        return;
    }

    const menu = ensureUnifiedDropdown(btn);
    // Ensure toggle button text is current without overwriting the icon span
    const toggleLabel = Array.from(menu.querySelectorAll(".runpod-menu-item-label")).find((el) =>
        el.textContent.includes("shutdown timer")
    );
    if (toggleLabel) {
        toggleLabel.textContent = timerState.enabled ? "Disable shutdown timer" : "Enable shutdown timer";
    }

    const rect = btn.getBoundingClientRect();
    menu.style.display = "flex";
    const menuWidth = menu.offsetWidth || 208;
    const clampedLeft = Math.max(
        8,
        Math.min(Math.round(rect.left), window.innerWidth - menuWidth - 8)
    );
    menu.style.left = `${clampedLeft}px`;
    menu.style.top = `${Math.round(rect.bottom + 8)}px`;
    menu.setAttribute("data-state", "open");
    syncRunPodButtonOpenState(true);
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

// Global listeners to auto-dismiss menus
document.addEventListener("click", (event) => {
    const target = event?.target;
    if (target instanceof Element && (unifiedDropdownMenu?.contains(target) || target.closest(RUNPOD_BUTTON_SELECTOR))) {
        return;
    }
    hideAllDropdowns();
}, true);
document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
        hideAllDropdowns();
    }
});
window.addEventListener("resize", hideAllDropdowns);

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
            id: "runpod.enable_shutdown_timer",
            category: ["RunPod Control", "Shutdown Timer", "Enable Timer"],
            name: "Enable Shutdown Timer",
            type: "boolean",
            defaultValue: true,
            tooltip: "Controls whether the automatic idle shutdown countdown timer is enabled or disabled by default.",
            onChange(value) {
                if (typeof value === "boolean") {
                    fetch("/runpod/timer", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ action: "toggle", enabled: value })
                    }).then(() => fetchRunPodStatus()).then(() => updateButtonUI());
                }
            }
        },
        {
            id: "runpod.shutdown_minutes",
            category: ["RunPod Control", "Shutdown Timer", "Duration"],
            name: "Shutdown Duration (minutes)",
            type: "number",
            defaultValue: 30,
            tooltip: "How long the pod should remain idle after all jobs finish before shutting down.",
            attrs: { min: 1, max: 1440, step: 1 },
            onChange(value) {
                let val = value;
                if (typeof val === "string") val = parseInt(val, 10);
                if (typeof val === "number" && !isNaN(val) && val > 0) {
                    fetch("/runpod/timer", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ action: "set_duration", duration_seconds: val * 60 })
                    }).then(() => fetchRunPodStatus()).then(() => updateButtonUI());
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
            ],
            onChange(value) {
                if (typeof value === "string") {
                    fetch("/runpod/timer", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ action: "set_shutdown_action", shutdown_action: value })
                    }).then(() => fetchRunPodStatus()).then(() => updateButtonUI());
                }
            }
        },
        {
            id: "runpod.monitor.enabled",
            category: ["RunPod Control", "Resource Monitor", "Enable"],
            name: "Enable Resource Monitor",
            type: "boolean",
            defaultValue: true,
            tooltip: "Show compact RunPod-style resource gauges right next to the RunPod button.",
            onChange() {
                updateButtonUI();
                if (isResourceMonitorEnabled()) startResourceMonitor();
                else stopResourceMonitor();
            }
        },
        {
            id: "runpod.monitor.show_ram",
            category: ["RunPod Control", "Resource Monitor", "Indicators"],
            name: "Show RAM",
            type: "boolean",
            defaultValue: true,
            tooltip: "Display container-aware RAM usage gauge.",
            onChange() {
                renderResourceMonitor(lastMonitorData);
            }
        },
        {
            id: "runpod.monitor.show_gpu",
            category: ["RunPod Control", "Resource Monitor", "Indicators"],
            name: "Show GPU Utilization",
            type: "boolean",
            defaultValue: true,
            tooltip: "Display GPU compute utilization gauge.",
            onChange() {
                renderResourceMonitor(lastMonitorData);
            }
        },
        {
            id: "runpod.monitor.show_vram",
            category: ["RunPod Control", "Resource Monitor", "Indicators"],
            name: "Show VRAM",
            type: "boolean",
            defaultValue: true,
            tooltip: "Display GPU VRAM usage gauge.",
            onChange() {
                renderResourceMonitor(lastMonitorData);
            }
        },
        {
            id: "runpod.monitor.show_hdd",
            category: ["RunPod Control", "Resource Monitor", "Indicators"],
            name: "Show HDD",
            type: "boolean",
            defaultValue: true,
            tooltip: "Display disk usage gauge.",
            onChange() {
                renderResourceMonitor(lastMonitorData);
            }
        },
        {
            id: "runpod.monitor.show_cpu",
            category: ["RunPod Control", "Resource Monitor", "Indicators"],
            name: "Show CPU (Crystools)",
            type: "boolean",
            defaultValue: false,
            tooltip: "Display CPU utilization gauge.",
            onChange() {
                renderResourceMonitor(lastMonitorData);
            }
        },
        {
            id: "runpod.monitor.show_temp",
            category: ["RunPod Control", "Resource Monitor", "Indicators"],
            name: "Show GPU Temp (Crystools)",
            type: "boolean",
            defaultValue: false,
            tooltip: "Display GPU temperature gauge (°C).",
            onChange() {
                renderResourceMonitor(lastMonitorData);
            }
        },
        {
            id: "runpod.monitor.refresh_rate",
            category: ["RunPod Control", "Resource Monitor", "Refresh"],
            name: "Refresh Interval (seconds)",
            type: "slider",
            defaultValue: 1.5,
            attrs: { min: 0.5, max: 5, step: 0.5 },
            tooltip: "How often to poll hardware metrics from the pod.",
            onChange() {
                startResourceMonitor();
            }
        },
        {
            id: "runpod.monitor.hdd_path",
            category: ["RunPod Control", "Resource Monitor", "Disk"],
            name: "HDD Mount Path",
            type: "combo",
            defaultValue: "/workspace",
            options: [
                { value: "/workspace", text: "Workspace Volume (/workspace)" },
                { value: "/", text: "Container Root (/)" }
            ],
            tooltip: "Filesystem path to monitor for HDD usage.",
            onChange() {
                pollResourceMonitorOnce();
            }
        }
    ],
    setup() {
        fetchRunPodStatus().then((isRunPod) => {
            if (!isRunPod) return;

            // Sync current client settings with backend on startup
            const syncSettings = async () => {
                const envMins = runpodStatus.timer?.env_duration_minutes;
                const settingsUi = app?.ui?.settings;

                if (envMins) {
                    if (settingsUi?.setSettingValue) {
                        try {
                            settingsUi.setSettingValue("runpod.shutdown_minutes", envMins);
                        } catch (e) {}
                    }
                } else {
                    const mins = getConfiguredMinutes();
                    await fetch("/runpod/timer", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ action: "set_duration", duration_seconds: mins * 60 })
                    });
                }
                const act = getShutdownAction();
                const timerPref = getShutdownTimerEnabled();
                await fetch("/runpod/timer", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ action: "set_shutdown_action", shutdown_action: act })
                });

                // Backend is authoritative for timer enabled state across restarts
                // (env_disabled + persisted runpod_timer_state.json).
                const backendEnabled = Boolean(runpodStatus.timer?.enabled);
                if (settingsUi?.setSettingValue && timerPref !== backendEnabled) {
                    try {
                        settingsUi.setSettingValue("runpod.enable_shutdown_timer", backendEnabled);
                    } catch (e) {}
                }
                await fetchRunPodStatus();
                updateButtonUI();
            };
            syncSettings();

            // MutationObserver to place buttons dynamically when action bar renders/updates
            const uiObserver = new MutationObserver((mutations) => {
                let selfTriggered = false;
                for (const m of mutations) {
                    const target = m.target;
                    if (target && target.closest && (
                        target.closest("#runpod-unified-dropdown") ||
                        target.closest("#runpod-countdown-overlay") ||
                        target.closest(`#${RESOURCE_MONITOR_ID}`)
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
