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

// Disable the full Crystools monitor bars while our own monitor is enabled
const CRYSTOOLS_MONITOR_SETTING_IDS = (() => {
    const ids = ["Crystools.ShowCpu", "Crystools.ShowRam", "Crystools.ShowHdd"];
    const words = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven"];
    for (const w of words) {
        ids.push(`Crystools.ShowGpuUsage${w}`, `Crystools.ShowGpuVram${w}`, `Crystools.ShowGpuTemperature${w}`);
    }
    return ids;
})();

function disableCrystoolsMonitor() {
    if (getMonitorSetting("runpod.monitor.enabled", true) === false) return;
    const settingsUi = app?.ui?.settings;
    if (!settingsUi?.getSettingValue || !settingsUi?.setSettingValue) return;
    for (const id of CRYSTOOLS_MONITOR_SETTING_IDS) {
        try {
            if (settingsUi.getSettingValue(id) === true) {
                settingsUi.setSettingValue(id, false);
            }
        } catch (e) {}
    }
}

function isResourceMonitorEnabled() {
    return getMonitorSetting("runpod.monitor.enabled", true) !== false;
}

function getMonitorColor(_value, _isTemp = false) {
    return "var(--primary-background, #0b8ce9)";
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

const MONITOR_COMPACT_BREAKPOINT_PX = 1220;
let monitorCompactOverride = null; // null = auto, true = forced mini, false = forced full
let lastAutoCompact = typeof window !== "undefined" ? window.innerWidth <= MONITOR_COMPACT_BREAKPOINT_PX : false;

function isResourceMonitorCompact() {
    if (monitorCompactOverride !== null) return monitorCompactOverride;
    return typeof window !== "undefined" ? window.innerWidth <= MONITOR_COMPACT_BREAKPOINT_PX : false;
}

if (typeof window !== "undefined") {
    window.addEventListener("resize", () => {
        const autoCompact = window.innerWidth <= MONITOR_COMPACT_BREAKPOINT_PX;
        if (autoCompact !== lastAutoCompact) {
            lastAutoCompact = autoCompact;
            monitorCompactOverride = null;
            renderResourceMonitor(lastMonitorData);
        }
    });
}

function buildMiniBarHtml(label, pct, tooltip, isTemp = false) {
    const valid = typeof pct === "number" && pct >= 0;
    const clamped = valid ? Math.max(0, Math.min(100, pct)) : 0;
    const color = valid ? getMonitorColor(isTemp ? pct : clamped, isTemp) : "rgba(255,255,255,0.2)";
    const letter = label.charAt(0).toUpperCase();
    const fillStyle = clamped > 0
        ? `height:${clamped.toFixed(1)}%;min-height:2px;background:${color};`
        : "height:0%;";

    return `
        <div class="runpod-gauge-mini-item" title="${tooltip} (click to expand)" style="width:8px;height:32px;display:inline-flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;flex-shrink:0;user-select:none;cursor:pointer;">
            <div style="width:4px;height:18px;border-radius:999px;background:rgba(255,255,255,0.14);overflow:hidden;display:flex;align-items:flex-end;flex-shrink:0;">
                <div style="width:100%;border-radius:999px;transition:height 0.25s ease;${fillStyle}"></div>
            </div>
            <span style="font-family:Inter,system-ui,sans-serif;font-size:9px;font-weight:700;line-height:1;color:var(--foreground,#d4d6e0);">${letter}</span>
        </div>
    `;
}

function buildGaugeSvg(label, pct, displayValue, tooltip, isTemp = false) {
    if (isResourceMonitorCompact()) {
        return buildMiniBarHtml(label, pct, tooltip, isTemp);
    }
    const valid = typeof pct === "number" && pct >= 0;
    const clamped = valid ? Math.max(0, Math.min(100, pct)) : 0;
    const color = valid ? getMonitorColor(isTemp ? pct : clamped, isTemp) : "rgba(255,255,255,0.2)";
    const fillEnd = GAUGE_START_DEG + (GAUGE_SPAN_DEG * clamped) / 100;
    const fillPath = clamped > 0.5
        ? `<path d="${describeArc(GAUGE_CX, GAUGE_CY, GAUGE_R, GAUGE_START_DEG, fillEnd)}" fill="none" stroke="${color}" stroke-width="2.6" stroke-linecap="round" style="transition: stroke 0.25s ease;" />`
        : "";
    const labelFontSize = label.length >= 4 ? "7.8" : "8.8";

    return `
        <div class="runpod-gauge-item" title="${tooltip} (click to collapse)" style="position:relative;width:32px;height:32px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;user-select:none;cursor:pointer;">
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
        let tip = `Disk (${pathLabel}): ${txt}`;
        if (data?.hdd_total > 0 && data?.hdd_used >= 0) {
            tip = `Disk (${pathLabel}): ${formatBytesGiB(data.hdd_used)} / ${formatBytesGiB(data.hdd_total)} (${txt})`;
        } else if (data?.hdd_used >= 0) {
            tip = `Disk (${pathLabel}): ${formatBytesGiB(data.hdd_used)} used`;
        }
        gauges.push(buildGaugeSvg("HDD", val, txt, tip));
    }

    const compact = isResourceMonitorCompact();
    container.dataset.compact = compact ? "1" : "0";
    container.style.gap = compact ? "1px" : "6px";
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
            cursor: "pointer",
            order: "9999"
        });
        container.addEventListener("click", (e) => {
            e.stopPropagation();
            monitorCompactOverride = !isResourceMonitorCompact();
            renderResourceMonitor(lastMonitorData);
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

// Fetch configured FileBrowser enabled setting
function getFileBrowserEnabled() {
    const settingsUi = app?.ui?.settings;
    if (settingsUi?.getSettingValue) {
        const val = settingsUi.getSettingValue("runpod.filebrowser_enabled");
        if (typeof val === "boolean") return val;
    }
    return true;
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
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) throw new Error("Backend unavailable");
        runpodStatus = await response.json();
        
        if (runpodStatus.timer) {
            timerState.enabled = runpodStatus.timer.enabled;
            timerState.secondsLeft = runpodStatus.timer.seconds_left;
            timerState.jobActive = runpodStatus.timer.job_active;
            timerState.running = timerState.enabled && !timerState.jobActive;
        }
        
        const fbEnabled = getFileBrowserEnabled();
        const forceShow = getFileBrowserVisibility() === "always_show";
        if (!fbEnabled) {
            runpodStatus.filebrowser_active = false;
            runpodStatus.filebrowser_url = null;
            runpodStatus.output_url = null;
        } else if (runpodStatus.is_runpod) {
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

const RUNPOD_DIALOG_STYLE_ID = "runpod-control-native-dialog-style";

function ensureNativeDialogStyles() {
    if (document.getElementById(RUNPOD_DIALOG_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = RUNPOD_DIALOG_STYLE_ID;
    style.textContent = `
        @keyframes runpod-spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        :where(.rp-ds-overlay) {
            position: fixed;
            inset: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            background: rgba(0, 0, 0, 0.7);
        }
        :where(.rp-ds-dialog) {
            display: flex;
            flex-direction: column;
            background: var(--base-background, var(--comfy-menu-bg, #1f2128));
            color: var(--base-foreground, var(--input-text, #f4f4f5));
            border: 1px solid var(--border-default, var(--border-color, rgba(255, 255, 255, 0.12)));
            border-radius: 16px;
            box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
            font-family: var(--font-inter, Inter, system-ui, sans-serif);
            outline: none;
            box-sizing: border-box;
        }
        :where(.rp-ds-header) {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            padding: 16px 16px 8px 16px;
        }
        :where(.rp-ds-content) {
            display: flex;
            flex-direction: column;
            gap: 10px;
            padding: 8px 16px;
            font-size: 14px;
            line-height: 1.5;
            color: var(--muted-foreground, var(--descrip-text, #a1a1aa));
        }
        :where(.rp-ds-footer) {
            display: flex;
            align-items: center;
            justify-content: flex-end;
            gap: 8px;
            padding: 8px 16px 16px 16px;
        }
        :where(.rp-ds-btn) {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            height: 32px;
            padding: 0 12px;
            border-radius: 8px;
            border: none;
            font-family: var(--font-inter, Inter, system-ui, sans-serif);
            font-size: 12px;
            font-weight: 500;
            cursor: pointer;
            white-space: nowrap;
            transition: background-color 120ms ease, opacity 120ms ease;
        }
        :where(.rp-ds-btn-secondary) {
            background: var(--secondary-background, rgba(255, 255, 255, 0.08));
            color: var(--base-foreground, #f4f4f5);
        }
        :where(.rp-ds-btn-secondary:hover) {
            background: var(--secondary-background-hover, rgba(255, 255, 255, 0.14));
        }
        :where(.rp-ds-btn-primary) {
            background: var(--primary-background, #0b8ce9);
            color: #ffffff;
        }
        :where(.rp-ds-btn-primary:hover) {
            opacity: 0.9;
        }
        :where(.rp-ds-btn-destructive) {
            background: var(--destructive-background, #ef4444);
            color: #ffffff;
        }
        :where(.rp-ds-btn-destructive:hover) {
            opacity: 0.9;
        }
        :where(.rp-ds-input) {
            display: flex;
            height: 36px;
            width: 100%;
            box-sizing: border-box;
            border-radius: 8px;
            border: 1px solid var(--border-default, rgba(255, 255, 255, 0.14));
            background: var(--secondary-background, rgba(255, 255, 255, 0.06));
            color: var(--base-foreground, #f4f4f5);
            padding: 0 12px;
            font-size: 14px;
            outline: none;
        }
        :where(.rp-ds-input:focus) {
            border-color: var(--primary-background, #0b8ce9);
        }
        :where(.rp-ds-close) {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 32px;
            height: 32px;
            border-radius: 8px;
            border: none;
            background: transparent;
            color: var(--muted-foreground, #a1a1aa);
            cursor: pointer;
        }
        :where(.rp-ds-close:hover) {
            background: var(--secondary-background-hover, rgba(255, 255, 255, 0.08));
            color: var(--base-foreground, #f4f4f5);
        }
    `;
    document.head.appendChild(style);
}

function createNativeDialogButton(label, variant = "secondary", iconClass = "") {
    ensureNativeDialogStyles();
    const btn = document.createElement("button");
    btn.type = "button";
    const base =
        "rp-ds-btn relative inline-flex h-8 cursor-pointer touch-manipulation appearance-none items-center justify-center gap-1.5 rounded-lg border-none px-3 font-inter text-xs font-medium whitespace-nowrap transition-colors focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50";
    const variantClasses = variant === "primary"
        ? "rp-ds-btn-primary bg-primary text-foreground hover:bg-primary/90"
        : variant === "destructive"
            ? "rp-ds-btn-destructive bg-destructive text-foreground hover:bg-destructive/90"
            : "rp-ds-btn-secondary bg-secondary text-foreground hover:bg-accent";
    btn.className = `${base} ${variantClasses}`;

    if (iconClass) {
        const icon = document.createElement("i");
        icon.className = `${iconClass} size-3.5 shrink-0`;
        icon.setAttribute("aria-hidden", "true");
        btn.appendChild(icon);
    }

    const labelSpan = document.createElement("span");
    labelSpan.textContent = label;
    btn.appendChild(labelSpan);
    return btn;
}

function createNativeDialogOverlay(id, { zIndex = "100000", width = "420px", title = "", onClose = null } = {}) {
    ensureNativeDialogStyles();
    const existing = document.getElementById(id);
    if (existing) existing.remove();

    const mask = document.createElement("div");
    mask.id = id;
    mask.className = "rp-ds-overlay fixed inset-0 flex items-center justify-center bg-black/70";
    mask.style.zIndex = zIndex;

    const dialog = document.createElement("div");
    dialog.className =
        "rp-ds-dialog flex flex-col rounded-2xl border border-solid border-border bg-background text-foreground shadow-lg outline-none font-inter";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.style.width = width;
    dialog.style.maxWidth = "calc(100vw - 2rem)";

    const header = document.createElement("div");
    header.className = "rp-ds-header flex shrink-0 items-center justify-between gap-2 px-4 pt-4 pb-2";

    const titleWrap = document.createElement("div");
    titleWrap.className = "flex min-w-0 items-center gap-2";

    const titleEl = document.createElement("h2");
    titleEl.className = "m-0 min-w-0 text-base font-semibold text-foreground";
    titleEl.textContent = title;
    titleWrap.appendChild(titleEl);
    header.appendChild(titleWrap);

    const content = document.createElement("div");
    content.className = "rp-ds-content flex min-h-0 flex-1 flex-col gap-2.5 px-4 py-2 text-sm text-muted-foreground";

    const footer = document.createElement("div");
    footer.className = "rp-ds-footer flex shrink-0 items-center justify-end gap-2 px-4 pt-2 pb-4";

    dialog.appendChild(header);
    dialog.appendChild(content);
    dialog.appendChild(footer);
    mask.appendChild(dialog);

    let keyHandler = null;
    const teardown = () => {
        if (keyHandler) {
            document.removeEventListener("keydown", keyHandler, true);
            keyHandler = null;
        }
        mask.remove();
    };

    if (typeof onClose === "function") {
        const closeBtn = document.createElement("button");
        closeBtn.type = "button";
        closeBtn.setAttribute("aria-label", "Close");
        closeBtn.className =
            "rp-ds-close relative inline-flex size-8 shrink-0 cursor-pointer appearance-none items-center justify-center rounded-lg border-none bg-transparent text-muted-foreground transition-colors hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none";
        closeBtn.innerHTML = `<i class="icon-[lucide--x] size-4" aria-hidden="true"></i>`;
        closeBtn.addEventListener("click", () => onClose());
        header.appendChild(closeBtn);

        mask.addEventListener("mousedown", (e) => {
            if (e.target === mask) onClose();
        });
        keyHandler = (e) => {
            if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                onClose();
            }
        };
        document.addEventListener("keydown", keyHandler, true);
    }

    return { overlay: mask, card: dialog, header, titleWrap, titleEl, content, footer, teardown };
}

// Show redirect countdown dialog
function showRedirectCountdown() {
    const { overlay, content, footer } = createNativeDialogOverlay("runpod-redirect-overlay", {
        zIndex: "1000000",
        width: "400px",
        title: "Pod Deactivated"
    });

    let seconds = 5;
    const desc = document.createElement("p");
    desc.className = "m-0 text-sm leading-relaxed text-muted-foreground";
    const secSpan = document.createElement("span");
    secSpan.className = "font-semibold text-foreground tabular-nums";
    secSpan.textContent = `${seconds}s`;
    desc.append("Your pod is shutting down. Redirecting to RunPod Console in ", secSpan, ".");
    content.appendChild(desc);

    const btnNow = createNativeDialogButton("Open Console Now", "secondary");
    btnNow.addEventListener("click", () => {
        window.location.href = "https://console.runpod.io/";
    });
    footer.appendChild(btnNow);

    document.body.appendChild(overlay);

    const timer = setInterval(() => {
        seconds--;
        if (seconds <= 0) {
            clearInterval(timer);
            window.location.href = "https://console.runpod.io/";
        } else {
            secSpan.textContent = `${seconds}s`;
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
    const { overlay, titleWrap, titleEl, content, footer, teardown } = createNativeDialogOverlay("runpod-restarting-overlay", {
        zIndex: "1000000",
        width: "400px",
        title: "Restarting ComfyUI"
    });

    const spinner = document.createElement("div");
    Object.assign(spinner.style, {
        width: "16px",
        height: "16px",
        border: "2px solid rgba(255, 255, 255, 0.16)",
        borderTop: "2px solid var(--primary-background, #0b8ce9)",
        borderRadius: "50%",
        animation: "runpod-spin 0.8s linear infinite",
        flexShrink: "0"
    });
    titleWrap.insertBefore(spinner, titleEl);

    const desc = document.createElement("p");
    desc.className = "m-0 text-sm leading-relaxed text-muted-foreground";
    desc.textContent = "ComfyUI server is restarting. Reconnecting automatically once ready.";

    const statusText = document.createElement("div");
    statusText.className = "text-xs text-muted-foreground tabular-nums opacity-80";
    statusText.textContent = "Sending restart command...";

    content.appendChild(desc);
    content.appendChild(statusText);
    footer.style.display = "none";
    document.body.appendChild(overlay);

    return {
        card: footer,
        updateStatus: (text) => { statusText.textContent = text; },
        showFooterButton: (btn) => {
            footer.style.display = "flex";
            footer.appendChild(btn);
        },
        remove: teardown
    };
}

// Perform ComfyUI server restart
async function executeRestart() {
    const dialogConfirm = app?.extensionManager?.dialog?.confirm;
    let confirmed = false;
    if (typeof dialogConfirm === "function") {
        confirmed = await dialogConfirm({
            title: "Restart ComfyUI",
            message: "Are you sure you want to restart ComfyUI?",
            type: "default"
        });
    } else {
        confirmed = confirm("Are you sure you want to restart ComfyUI?");
    }
    if (!confirmed) return;

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
                const btn = createNativeDialogButton("Reload Page", "primary");
                btn.onclick = () => window.location.reload();
                ui.showFooterButton(btn);
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
    const isLow = isActive && timerState.secondsLeft < 600;
    const labelHtml = isActive
        ? `<span class="inline-flex items-center gap-1"><span class="text-xs font-medium">RunPod</span><span class="text-2xs ${isLow ? "text-destructive" : "text-muted-foreground"} tabular-nums">${getButtonText()}</span></span>`
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

class KillPodDialog {
    showKillConfirmation() {
        let timeLeft = 60;
        let timerInterval = null;
        let teardownFn = null;

        const cleanup = () => {
            if (timerInterval) {
                clearInterval(timerInterval);
                timerInterval = null;
            }
            if (teardownFn) teardownFn();
        };

        const { overlay, content, footer, teardown } = createNativeDialogOverlay("runpod-kill-modal", {
            zIndex: "100002",
            width: "440px",
            title: "Terminate Pod",
            onClose: cleanup
        });
        teardownFn = teardown;

        const warningText = document.createElement("p");
        warningText.className = "m-0 text-sm leading-relaxed text-muted-foreground";
        warningText.textContent = "This will completely delete the pod and all generated files that hadn't been downloaded. This action is irreversible.";

        const countdownDisplay = document.createElement("div");
        countdownDisplay.className = "text-sm font-semibold text-destructive tabular-nums";
        countdownDisplay.style.color = "var(--destructive-background, #ef4444)";
        countdownDisplay.textContent = `Auto-terminating in ${timeLeft}s...`;

        content.appendChild(warningText);
        content.appendChild(countdownDisplay);

        const btnCancel = createNativeDialogButton("Cancel", "secondary");
        const btnConfirm = createNativeDialogButton("Terminate Pod Now", "destructive", "icon-[lucide--trash-2]");

        btnCancel.onclick = cleanup;
        btnConfirm.onclick = () => {
            cleanup();
            executeShutdown("stop_and_remove");
        };

        timerInterval = setInterval(() => {
            timeLeft--;
            if (timeLeft <= 0) {
                cleanup();
                executeShutdown("stop_and_remove");
            } else {
                countdownDisplay.textContent = `Auto-terminating in ${timeLeft}s...`;
            }
        }, 1000);

        footer.appendChild(btnCancel);
        footer.appendChild(btnConfirm);
        document.body.appendChild(overlay);
        btnCancel.focus();
    }
}

let isApplyingTimerSetting = false;

async function promptForTimerMinutes(defaultMins = 30) {
    const defStr = String(defaultMins > 0 ? defaultMins : 30);
    return new Promise((resolve) => {
        let settled = false;
        let teardownFn = null;
        const finish = (val) => {
            if (settled) return;
            settled = true;
            if (teardownFn) teardownFn();
            resolve(val);
        };

        const { overlay, content, footer, teardown } = createNativeDialogOverlay("runpod-timer-prompt-modal", {
            zIndex: "100002",
            width: "400px",
            title: "Enable Shutdown Timer",
            onClose: () => finish(null)
        });
        teardownFn = teardown;

        const label = document.createElement("label");
        label.className = "flex flex-col gap-2 text-sm text-muted-foreground";
        label.textContent = "How many minutes should the shutdown timer be set for?";

        const input = document.createElement("input");
        input.type = "number";
        input.min = "1";
        input.max = "1440";
        input.step = "1";
        input.value = defStr;
        input.className =
            "rp-ds-input flex h-9 w-full min-w-0 appearance-none rounded-lg border-none bg-secondary px-3 py-2 font-inter text-sm text-foreground placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none";

        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                finish(input.value);
            }
        });

        label.appendChild(input);
        content.appendChild(label);

        const btnCancel = createNativeDialogButton("Cancel", "secondary");
        const btnConfirm = createNativeDialogButton("Enable Timer", "primary");
        btnCancel.onclick = () => finish(null);
        btnConfirm.onclick = () => finish(input.value);

        footer.appendChild(btnCancel);
        footer.appendChild(btnConfirm);
        document.body.appendChild(overlay);
        requestAnimationFrame(() => {
            input.focus();
            input.select();
        });
    });
}

async function applyTimerToggle(nextEnabled, { promptMinutes = true } = {}) {
    let durationSeconds = null;
    if (nextEnabled && promptMinutes) {
        const raw = await promptForTimerMinutes(30);
        if (raw === null || raw === undefined) {
            return false;
        }
        const mins = parseInt(String(raw).trim(), 10);
        if (isNaN(mins) || mins < 1 || mins > 1440) {
            showToast("Shutdown Timer", "Please enter a valid duration between 1 and 1440 minutes.", "warn");
            return false;
        }
        durationSeconds = mins * 60;
    }

    try {
        const payload = { action: "toggle", enabled: Boolean(nextEnabled) };
        if (durationSeconds !== null) {
            payload.duration_seconds = durationSeconds;
        }
        const response = await fetch("/runpod/timer", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
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
                    isApplyingTimerSetting = true;
                    try {
                        settingsUi.setSettingValue("runpod.enable_shutdown_timer", timerState.enabled);
                        if (durationSeconds !== null) {
                            settingsUi.setSettingValue("runpod.shutdown_minutes", Math.round(durationSeconds / 60));
                        }
                    } catch (e) {
                    } finally {
                        isApplyingTimerSetting = false;
                    }
                }
            }
        }
    } catch (e) {
        console.warn("[RunPod Control] Failed to toggle timer:", e);
    }

    if (!timerState.enabled) {
        hideCountdownOverlay();
    }
    updateButtonUI();
    return true;
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
    outputsBtn.classList.add("runpod-fb-link-item");

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
    fbBtn.classList.add("runpod-fb-link-item");

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
            await applyTimerToggle(nextEnabled, { promptMinutes: nextEnabled });
            const labelEl = toggleTimerBtn.querySelector(".runpod-menu-item-label");
            if (labelEl) {
                labelEl.textContent = timerState.enabled ? "Disable shutdown timer" : "Enable shutdown timer";
            }
        },
        { iconClass: "icon-[lucide--clock]" }
    );

    const killPodBtn = createItem(
        "Terminate Pod",
        () => {
            if (runpodStatus.pod_id) {
                const dialog = new KillPodDialog();
                dialog.showKillConfirmation();
            } else {
                showToast("Terminate Pod", "Pod ID not detected", "warn");
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
    const fbEnabled = getFileBrowserEnabled();
    menu.querySelectorAll(".runpod-fb-link-item").forEach((el) => {
        el.style.display = fbEnabled ? "" : "none";
    });
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

// Native-style ComfyUI Idle Shutdown Countdown Dialog
function showCountdownOverlay() {
    const mins = Math.floor(timerState.secondsLeft / 60);
    const secs = timerState.secondsLeft % 60;
    const formattedTime = `${mins}:${secs.toString().padStart(2, "0")}`;

    if (countdownOverlay) {
        const secText = countdownOverlay.querySelector(".rp-countdown-seconds");
        if (secText) {
            secText.textContent = formattedTime;
        }
        return;
    }

    const { overlay, content, footer } = createNativeDialogOverlay("runpod-countdown-overlay", {
        zIndex: "100000",
        width: "420px",
        title: "Pod Shutting Down"
    });

    const desc = document.createElement("p");
    desc.className = "m-0 text-sm leading-relaxed text-muted-foreground";

    const timeDisplay = document.createElement("span");
    timeDisplay.className = "rp-countdown-seconds font-semibold text-destructive tabular-nums";
    timeDisplay.style.color = "var(--destructive-background, #ef4444)";
    timeDisplay.textContent = formattedTime;
    desc.append("No active jobs detected. This pod will automatically shut down in ", timeDisplay, ".");
    content.appendChild(desc);

    const btnShutdown = createNativeDialogButton("Shut Down Now", "secondary");
    btnShutdown.addEventListener("click", () => {
        hideCountdownOverlay();
        executeShutdown();
    });

    const btnReset = createNativeDialogButton(`Reset Timer (${getConfiguredMinutes()} min)`, "primary");
    btnReset.addEventListener("click", () => {
        resetTimer();
    });

    footer.appendChild(btnShutdown);
    footer.appendChild(btnReset);
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
            sortOrder: 300,
            tooltip: "Controls whether the automatic idle shutdown countdown timer is enabled or disabled by default.",
            async onChange(value) {
                if (isApplyingTimerSetting || typeof value !== "boolean") return;
                if (value === timerState.enabled) return;
                const applied = await applyTimerToggle(value, { promptMinutes: value });
                if (!applied) {
                    const settingsUi = app?.ui?.settings;
                    if (settingsUi?.setSettingValue) {
                        isApplyingTimerSetting = true;
                        try {
                            settingsUi.setSettingValue("runpod.enable_shutdown_timer", timerState.enabled);
                        } catch (e) {
                        } finally {
                            isApplyingTimerSetting = false;
                        }
                    }
                }
            }
        },
        {
            id: "runpod.shutdown_minutes",
            category: ["RunPod Control", "Shutdown Timer", "Duration"],
            name: "Shutdown Duration (minutes)",
            type: "number",
            defaultValue: 30,
            sortOrder: 300,
            tooltip: "How long the pod should remain idle after all jobs finish before shutting down.",
            attrs: { min: 1, max: 1440, step: 1 },
            onChange(value) {
                if (isApplyingTimerSetting) return;
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
            id: "runpod.shutdown_action",
            category: ["RunPod Control", "Shutdown Timer", "Shutdown Behavior"],
            name: "Shutdown Behavior",
            type: "combo",
            defaultValue: "stop_and_remove",
            sortOrder: 300,
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
            sortOrder: 200,
            tooltip: "Show compact RunPod-style resource gauges right next to the RunPod button.",
            onChange() {
                updateButtonUI();
                disableCrystoolsMonitor();
                if (isResourceMonitorEnabled()) startResourceMonitor();
                else stopResourceMonitor();
            }
        },
        {
            id: "runpod.monitor.show_ram",
            category: ["RunPod Control", "Resource Monitor", "Show RAM"],
            name: "Show RAM",
            type: "boolean",
            defaultValue: true,
            sortOrder: 200,
            tooltip: "Display container-aware RAM usage gauge.",
            onChange() {
                renderResourceMonitor(lastMonitorData);
            }
        },
        {
            id: "runpod.monitor.show_gpu",
            category: ["RunPod Control", "Resource Monitor", "Show GPU"],
            name: "Show GPU Utilization",
            type: "boolean",
            defaultValue: true,
            sortOrder: 200,
            tooltip: "Display GPU compute utilization gauge.",
            onChange() {
                renderResourceMonitor(lastMonitorData);
            }
        },
        {
            id: "runpod.monitor.show_vram",
            category: ["RunPod Control", "Resource Monitor", "Show VRAM"],
            name: "Show VRAM",
            type: "boolean",
            defaultValue: true,
            sortOrder: 200,
            tooltip: "Display GPU VRAM usage gauge.",
            onChange() {
                renderResourceMonitor(lastMonitorData);
            }
        },
        {
            id: "runpod.monitor.show_hdd",
            category: ["RunPod Control", "Resource Monitor", "Show HDD"],
            name: "Show HDD",
            type: "boolean",
            defaultValue: true,
            sortOrder: 200,
            tooltip: "Display disk usage gauge.",
            onChange() {
                renderResourceMonitor(lastMonitorData);
            }
        },
        {
            id: "runpod.monitor.show_cpu",
            category: ["RunPod Control", "Resource Monitor", "Show CPU"],
            name: "Show CPU",
            type: "boolean",
            defaultValue: false,
            sortOrder: 200,
            tooltip: "Display CPU utilization gauge.",
            onChange() {
                renderResourceMonitor(lastMonitorData);
            }
        },
        {
            id: "runpod.monitor.show_temp",
            category: ["RunPod Control", "Resource Monitor", "Show GPU Temp"],
            name: "Show GPU Temp",
            type: "boolean",
            defaultValue: false,
            sortOrder: 200,
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
            sortOrder: 200,
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
            sortOrder: 200,
            options: [
                { value: "/workspace", text: "Workspace Volume (/workspace)" },
                { value: "/", text: "Container Root (/)" }
            ],
            tooltip: "Filesystem path to monitor for HDD usage.",
            onChange() {
                pollResourceMonitorOnce();
            }
        },
        {
            id: "runpod.filebrowser_enabled",
            category: ["RunPod Control", "FileBrowser Links", "Enable"],
            name: "Enable FileBrowser Links",
            type: "boolean",
            defaultValue: true,
            sortOrder: 100,
            tooltip: "Show Outputs and FileBrowser links in the RunPod menu.",
            onChange() {
                fetchRunPodStatus().then(() => queueUpdateUI());
            }
        },
        {
            id: "runpod.filebrowser_type",
            category: ["RunPod Control", "FileBrowser Links", "URL Mode"],
            name: "FileBrowser URL Mode",
            type: "combo",
            defaultValue: "relative_path",
            sortOrder: 100,
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
            category: ["RunPod Control", "FileBrowser Links", "Relative Path"],
            name: "FileBrowser Relative Path",
            type: "text",
            defaultValue: "/files/",
            sortOrder: 100,
            tooltip: "The subpath route on your main URL that routes to FileBrowser.",
            onChange() {
                fetchRunPodStatus().then(() => queueUpdateUI());
            }
        },
        {
            id: "runpod.filebrowser_port",
            category: ["RunPod Control", "FileBrowser Links", "Local Port"],
            name: "FileBrowser Local Port",
            type: "number",
            defaultValue: 8080,
            sortOrder: 100,
            tooltip: "The local container port where the FileBrowser service is running (used to verify if the service is active).",
            onChange() {
                fetchRunPodStatus().then(() => queueUpdateUI());
            }
        },
        {
            id: "runpod.filebrowser_visibility",
            category: ["RunPod Control", "FileBrowser Links", "Visibility"],
            name: "FileBrowser Visibility",
            type: "combo",
            defaultValue: "auto_detect",
            sortOrder: 100,
            tooltip: "Choose whether the button should auto-hide when the FileBrowser port check fails, or be permanently displayed.",
            options: [
                { value: "auto_detect", text: "Auto-detect service status" },
                { value: "always_show", text: "Always show button" }
            ],
            onChange() {
                fetchRunPodStatus().then(() => queueUpdateUI());
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
            // Crystools registers its settings asynchronously; retry a few times
            [1500, 5000, 12000].forEach((ms) => setTimeout(disableCrystoolsMonitor, ms));

            // MutationObserver to place buttons dynamically when action bar renders/updates
            const uiObserver = new MutationObserver((mutations) => {
                let selfTriggered = false;
                for (const m of mutations) {
                    const target = m.target;
                    if (target && target.closest && (
                        target.closest("#runpod-unified-dropdown") ||
                        target.closest(".rp-ds-overlay") ||
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
