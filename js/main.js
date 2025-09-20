/* ---------- Global state -------------------------------------------------- */
let port                  = null; // active SerialPort
let transport             = null; // esptool transport
let loader                = null; // esptool loader instance
let esptoolPromise        = null;
let __lastSerialDisconnectTs = 0;
let __connectAttemptTs       = 0;

let __isConnecting = false; // single-flight guard
let __connectCalls = 0;     // counter for diagnostics

const BAUD       = 115200;   // default bootloader baud
const FLASH_ADDR = 0x10000;  // app partition offset
const CHIP_LABEL = 'ESP32-S2';

globalThis.port ||= { getInfo: () => ({ usbVendorId: undefined, usbProductId: undefined }) };

// Find UI elements (best-effort)
const FLASH_BUTTON =
    document.getElementById('flashBtn') ||
    document.querySelector('[data-role="flash"]') ||
    document.querySelector('#flash'); // fallback if your id is "flash"

// Optional: cache firmware file when selected
let __firmwareFile = null;

/* ----------------------------------------------------------------------------
    * function setFlashEnabled(isEnabled)
    * What:  Toggle flash button enabled/disabled (CSS makes it green when enabled).
    * Ends:  Updates the #flash button disabled state.
    * -------------------------------------------------------------------------- */
function setFlashEnabled(isEnabled) {
    if (!FLASH_BUTTON) return;
    FLASH_BUTTON.disabled = !isEnabled;
} // END setFlashEnabled

/* ----------------------------------------------------------------------------
    * function updateFlashButtonState()
    * What:  Enable flash only when connected (loader) AND a file is selected.
    * Ends:  Calls setFlashEnabled().
    * -------------------------------------------------------------------------- */
function updateFlashButtonState() {
    const hasLoader = !!loader;
    const fileFromInput =
    (document.getElementById('firmware') || document.querySelector('input[type=file]'))?.files?.[0];
    const hasFile = !!(__firmwareFile || fileFromInput);
    setFlashEnabled(hasLoader && hasFile);
} // END updateFlashButtonState

// Initialize as disabled on load
setFlashEnabled(false);

// File input wiring (single-bind guard)
const fwInput = document.getElementById('firmware') || document.querySelector('input[type=file]');
if (fwInput && !fwInput.__wired) {
    fwInput.__wired = true;
    fwInput.addEventListener('change', (e) => {
    __firmwareFile = e.target.files?.[0] || null;
    if (__firmwareFile) {
        //log(`Firmware: ${__firmwareFile.name} ${__firmwareFile.size} bytes`);
    }
    updateFlashButtonState();
    });
}

// Capture the native getPorts to poll real ports even if shim later.
try {
    if (navigator.serial?.getPorts && !navigator.serial.__nativeGetPorts) {
    Object.defineProperty(navigator.serial, '__nativeGetPorts', {
        value: navigator.serial.getPorts.bind(navigator.serial),
        configurable: true
    });
    }
} catch {}

// Seed ALL common aliases as accessors that resolve to the current port.
// This guarantees (alias).getInfo exists even if a bundle reads them early.
(function seedPortAliasAccessors() {
    const names = [
    'port', 'selectedPort', 'SerialPort', 'esptoolPort', '__PORT__',
    'serialPort', '__serialPort', '__selectedPort', 'WebSerialPort', 'ESPTOOL_PORT'
    ];
    if (!('__CURRENT_SERIAL_PORT__' in globalThis)) {
    Object.defineProperty(globalThis, '__CURRENT_SERIAL_PORT__', { value: null, writable: true });
    }
    const placeholder = { getInfo: () => ({ usbVendorId: undefined, usbProductId: undefined }) };
    for (const n of names) {
    const desc = Object.getOwnPropertyDescriptor(globalThis, n);
    if (!desc || desc.configurable) {
        try {
        Object.defineProperty(globalThis, n, {
            configurable: true,
            get() { return globalThis.__CURRENT_SERIAL_PORT__ || placeholder; },
            set(v) { globalThis.__CURRENT_SERIAL_PORT__ = v || null; }
        });
        } catch {}
    }
    }
})();

// -- Thenable + phantom array shim for navigator.serial.getPorts() --
//    Immediately returns an Array with length 0 (so code won't skip the chooser)
//    If code wrongly does getPorts()[0].getInfo(), index 0 is a non-enumerable getter
//    returning a harmless object with .getInfo() to avoid crashes
//    It's also a Promise (thenable), so `await navigator.serial.getPorts()` still works
(function patchGetPorts() {
    if (!(navigator.serial && navigator.serial.getPorts) || navigator.serial.__shimPhantom) return;

    const nativeGetPorts = navigator.serial.getPorts.bind(navigator.serial);

    function safePlaceholder() {
    return { getInfo: () => ({ usbVendorId: undefined, usbProductId: undefined }) };
    }

    async function resolveRealList() {
    try {
        const list = await nativeGetPorts();
        if (Array.isArray(list) && list.length) return list;
    } catch {}
    if (globalThis.__selectedRealPort) return [globalThis.__selectedRealPort];
    return [];
    }

    navigator.serial.getPorts = function getPortsThenable() {
    // Phantom array that looks empty, but has a safe [0] accessor
    const arr = [];
    Object.defineProperty(arr, '0', {
        enumerable: false,
        configurable: true,
        get() { return safePlaceholder(); }
    });

    // Promise facet
    const p = resolveRealList();
    arr.then    = (...a) => p.then(...a);
    arr.catch   = (...a) => p.catch(...a);
    arr.finally = (...a) => p.finally(...a);
    return arr;
    };

    Object.defineProperty(navigator.serial, '__shimPhantom', { value: true });
})();

// --- Promise the bundle can (indirectly) await for a real SerialPort ---
let __portResolve;
globalThis.__portReady = new Promise(res => { __portResolve = res; });

// --- Make getPorts() return the chosen port, or WAIT until one exists ---
if (navigator.serial?.getPorts && !navigator.serial.__shimAwaitPort) {
    const nativeGetPorts = navigator.serial.getPorts.bind(navigator.serial);

    function pickSelectedPortSync() {
    return (
        globalThis.port ||
        globalThis.selectedPort ||
        globalThis.SerialPort ||
        globalThis.esptoolPort ||
        globalThis.__PORT__ ||
        globalThis.__selectedRealPort ||
        null
    );
    }

    navigator.serial.getPorts = function getPortsThenable() {
    const arr = [];
    Object.defineProperty(arr, '0', {
        enumerable: false,
        configurable: true,
        get() {
        const p = pickSelectedPortSync();
        return p || { getInfo: () => ({ usbVendorId: undefined, usbProductId: undefined }) };
        }
    });

    const p = (async () => {
        try {
        const list = await nativeGetPorts();
        if (Array.isArray(list) && list.length) return list;
        } catch {}
        const chosen = pickSelectedPortSync() || await globalThis.__portReady;
        return chosen ? [chosen] : [];
    })();

    arr.then    = (...a) => p.then(...a);
    arr.catch   = (...a) => p.catch(...a);
    arr.finally = (...a) => p.finally(...a);
    return arr;
    };

    Object.defineProperty(navigator.serial, '__shimAwaitPort', { value: true });
}

/* ----------------------------------------------------------------------------
    * function $(selector)
    * What:  Tiny DOM helper.
    * Ends:  Returns the first matching element.
    * -------------------------------------------------------------------------- */
function $(sel) { return document.querySelector(sel); } // END $

/* ---------- Log/Status plumbing (safe even if #debug/#status are missing) -- */
let statusEl = $('#status');
let debugEl  = $('#debug');

// Progress UI handles
let progressBar  = $('#progress-bar');
let progressText = $('#progress-text');

/** Set progress 0..100 and update UI. */
function setProgress(pct) {
    const v = Math.max(0, Math.min(100, Math.floor(Number(pct) || 0)));
    if (progressBar)  progressBar.style.width = v + '%';
    if (progressText) progressText.textContent = v + '%';
} // END setProgress

/* ----------------------------------------------------------------------------
    * function setStatus(text)
    * What:  Update the visible status line.
    * Ends:  Writes to #status if present, and console for redundancy.
    * -------------------------------------------------------------------------- */
function setStatus(text) {
    const msg = `Status: ${text}`;
    if (statusEl) statusEl.textContent = msg;
    console.log('[WebSerial][status]', text);
} // END setStatus

/* ----------------------------------------------------------------------------
    * function log(...args)
    * What:  Centralized debug logger with timestamp and #debug sink.
    * Ends:  Appends a line in #debug and prints to console.
    * -------------------------------------------------------------------------- */
function log(...args) {

    /* Uncommen the Top Sections for date and time stamps in debug */
    //const ts = new Date().toISOString().replace('T', ' ').replace('Z', '');
    //console.log('[WebSerial]', ts, ...args);
    //if (!debugEl) return;
    //try {
    //const line = [ts, ...args.map(v => (typeof v === 'string' ? v : JSON.stringify(v)))].join(' ');
    //debugEl.textContent += line + '\n';
    //debugEl.scrollTop = debugEl.scrollHeight;
    //} catch {}


    // Console (no manual timestamp)
    console.log('[WebSerial]', ...args);

    // On-page debug console (no timestamp prefix)
    if (!debugEl) return;
    try {
    const line = args.map(v => (typeof v === 'string' ? v : JSON.stringify(v))).join(' ');
    debugEl.textContent += line + '\n';
    debugEl.scrollTop = debugEl.scrollHeight;
    } catch {
    /* ignore rendering issues */
    }

} // END log

/* --------------------------------------------------
    Global error breadcrumbs
    -------------------------------------------------- */
window.addEventListener('error', ev =>
    log('[window.onerror]', ev?.message || ev)
);
window.addEventListener('unhandledrejection', ev =>
    log('[unhandled]', ev?.reason?.message || String(ev?.reason))
);

// Extra serial connect/disconnect breadcrumbs (native-USB reboot visibility)
// Track last event timestamps to detect a reboot mid-handshake.
let __lastSerialEvents = { connect: 0, disconnect: 0 };
try {
    const safeInfo = p => { try { return p?.getInfo?.() || '(no getInfo)'; } catch { return '(no getInfo)'; } };
    navigator.serial?.addEventListener?.('connect', ev => {
    __lastSerialEvents.connect = Date.now();
    log('[serial event] connect:', safeInfo(ev?.port));
    });
    navigator.serial?.addEventListener?.('disconnect', ev => {
    __lastSerialEvents.disconnect = Date.now();
    log('[serial event] disconnect:', safeInfo(ev?.port));
    });
} catch {}

/* ----------------------------------------------------------------------------
    * function onReady(fn)
    * What:  Robust DOM-ready shim; runs immediately if DOM already parsed.
    * Ends:  Executes `fn` exactly once.
    * -------------------------------------------------------------------------- */
function onReady(fn) {
    if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        try { fn(); } catch (e) { console.error('[ready->fn]', e); }
    }, { once: true });
    } else {
    try { fn(); } catch (e) { console.error('[ready->fn]', e); }
    }
} // END onReady

/* ----------------------------------------------------------------------------
    * function ensureTerminalAPI(t)
    * What:  Normalize/patch a terminal object so esptool can safely call:
    *        t.clean(), t.write(), t.writeLine()/writeln()/println()
    * Ends:  Returns a terminal object with guaranteed methods.
    * -------------------------------------------------------------------------- */
function ensureTerminalAPI(t) {
    const fallback = {
    clean   : () => { if (debugEl) debugEl.textContent = ''; },
    write   : (s='') => log(String(s).replace(/\r/g,'')),
    writeLine: (s='') => log(String(s).replace(/\r/g,'')),
    writeln : (s='') => log(String(s).replace(/\r/g,'')),
    println : (s='') => log(String(s).replace(/\r/g,'')),
    };
    const base = (t && typeof t === 'object') ? t : {};
    base.write     = base.write     || fallback.write;
    base.writeLine = base.writeLine || base.writeln || base.println || fallback.writeLine;
    base.writeln   = base.writeln   || base.writeLine;
    base.println   = base.println   || base.writeLine;
    base.clean     = base.clean     || fallback.clean;
    return base;
} // END ensureTerminalAPI

// Patch helpers for bundle import: expose the selected port during import.
// Handles callers that call getPorts(), await getPorts, index getPorts[0],
// or even read non-standard navigator.serial.ports[0].
// UPDATE: getPorts() now returns a *thenable array* so `getPorts()[0]` works.
async function __withPortExposedForBundle(selectedPort, thunk) {
    const aliasNames = [
    'port','selectedPort','SerialPort','esptoolPort','__PORT__',
    'serialPort','__serialPort','__selectedPort','WebSerialPort','ESPTOOL_PORT'
    ];
    const prevGlobal = {};
    for (const n of aliasNames) { prevGlobal[n] = globalThis[n]; globalThis[n] = selectedPort; }

    const ns = navigator.serial;
    let restoreGetPorts = null;
    let restorePortsProp = null;

    function makeThenableArray() {
    const arr = [];
    Object.defineProperty(arr, '0',      { configurable: true, get: () => selectedPort });
    Object.defineProperty(arr, 'length', { configurable: true, get: () => 1 });
    const p = Promise.resolve([selectedPort]);
    arr.then    = (...a) => p.then(...a);
    arr.catch   = (...a) => p.catch(...a);
    arr.finally = (...a) => p.finally(...a);
    return arr;
    }

    if (ns) {
    const nativeGetPorts = typeof ns.getPorts === 'function' ? ns.getPorts.bind(ns) : null;

    // getPorts callable that returns a *thenable array*
    function getPortsCallable() { return makeThenableArray(); }
    // Also support navigator.serial.getPorts[0]
    Object.defineProperty(getPortsCallable, '0', { configurable: true, get: () => selectedPort });

    if (nativeGetPorts) {
        ns.getPorts = getPortsCallable;
        restoreGetPorts = () => { ns.getPorts = nativeGetPorts; };
    }

    // Ensure navigator.serial.ports[0] works
    const portsArrayGetter = () => [selectedPort];
    const hadOwnPorts = Object.prototype.hasOwnProperty.call(ns, 'ports');
    const oldPortsDesc = hadOwnPorts ? Object.getOwnPropertyDescriptor(ns, 'ports') : undefined;

    try {
        Object.defineProperty(ns, 'ports', { configurable: true, enumerable: false, get: portsArrayGetter });
        restorePortsProp = () => {
        if (hadOwnPorts && oldPortsDesc) Object.defineProperty(ns, 'ports', oldPortsDesc);
        else { try { delete ns.ports; } catch {} }
        };
    } catch {}
    }

    try {
    return await thunk();
    } finally {
    if (restoreGetPorts)  try { restoreGetPorts(); }  catch {}
    if (restorePortsProp) try { restorePortsProp(); } catch {}
    for (const n of Object.keys(prevGlobal)) { try { globalThis[n] = prevGlobal[n]; } catch {} }
    }
} // END __withPortExposedForBundle

/*-------------------------------------------------------------------------------
// Make "weird" bundle probes always see the selected SerialPort.
// Covers: navigator.serial.getPorts[0], navigator.serial.ports[0],
//         getPorts() (returns [port] as a *thenable array*), and global aliases.
// UPDATE: getPorts() now returns a *thenable array* so `getPorts()[0]` works.
--------------------------------------------------------------------------------*/
function installPortShims(selectedPort) {
    if (!selectedPort) return;

    // 1) Global aliases some builds probe for
    const names = [
    'port','selectedPort','SerialPort','esptoolPort','__PORT__',
    'serialPort','__serialPort','__selectedPort','WebSerialPort','ESPTOOL_PORT'
    ];
    for (const n of names) { try { globalThis[n] = selectedPort; } catch {} }

    // Ensure selectedPort.getInfo exists
    try {
    if (typeof selectedPort.getInfo !== 'function') {
        Object.defineProperty(selectedPort, 'getInfo', {
        value: () => ({ usbVendorId: undefined, usbProductId: undefined })
        });
    }
    } catch {}

    // 2) navigator.serial.* shims
    const ns = navigator.serial;
    try {
    if (!ns.__nativeGetPorts && typeof ns.getPorts === 'function') {
        Object.defineProperty(ns, '__nativeGetPorts', { value: ns.getPorts.bind(ns) });
    }
    } catch {}
    if (!ns) return;

    // 2a) Ensure navigator.serial.ports[0] works
    try {
    Object.defineProperty(ns, 'ports', {
        configurable: true,
        get: () => [selectedPort],
    });
    } catch {}
} // END installPortShims

// Best-effort: escalate control-signal failures so outer catch can rebind.
// UPDATE: throw a sentinel error on the first failure after reboot starts.
function __shimSetSignals(target, label = 'obj') {
    if (!target || typeof target.setSignals !== 'function' || target.setSignals.__shimmed) return;
    const native = target.setSignals.bind(target);
    target.setSignals = async function patchedSetSignals(signals) {
    try {
        return await native(signals);
    } catch (e) {
        const msg = e?.message || '';
        if (e?.name === 'NetworkError' || /set control signals/i.test(msg)) {
        const started = __connectAttemptTs || 0;
        const sawDiscDuringAttempt =
            (__lastSerialEvents.disconnect && __lastSerialEvents.disconnect >= started);

        // Always escalate so the outer try/catch can run the rebind flow.
        const phase = sawDiscDuringAttempt ? 'post-disconnect' : 'pre-disconnect';
        log(`[${label}.setSignals shim] transient ${phase} — throwing sentinel to rebind:`, msg);

        const err = new Error('setSignals transient');
        err.name = 'NetworkError';
        throw err;
        }
        throw e;
    }
    };
    Object.defineProperty(target.setSignals, '__shimmed', { value: true });
} // END_of_shimsetsignals

// Coerce bad baud values and make open() idempotent across bundle calls
function __shimOpenAndBaud(target, label = 'obj') {
    if (!target) return;

    // Wrap open() to clamp invalid baudRate (e.g., 0)
    if (typeof target.open === 'function' && !target.open.__baudShim) {
    const native = target.open.bind(target);
    const shim = async (opts = {}) => {
        if (opts && typeof opts === 'object') {
        const raw = Number(opts.baudRate ?? opts.baudrate ?? opts.baud);
        if (!Number.isFinite(raw) || raw <= 0) {
            log(`[${label}.open shim] invalid baud=${raw}; using ${BAUD}`);
            opts = { ...opts, baudRate: BAUD };
        }
        }
        return native(opts);
    };
    Object.defineProperty(shim, '__baudShim', { value: true });
    target.open = shim;
    }

    // Wrap setBaudRate / setBaudrate if present
    for (const name of ['setBaudRate', 'setBaudrate']) {
    if (typeof target[name] === 'function' && !target[name].__baudShim) {
        const native = target[name].bind(target);
        const shim = async (rate) => {
        let r = Number(rate);
        if (!Number.isFinite(r) || r <= 0) {
            log(`[${label}.${name} shim] invalid baud=${r}; keeping ${BAUD}`);
            r = BAUD;
        }
        return native(r);
        };
        Object.defineProperty(shim, '__baudShim', { value: true });
        target[name] = shim;
    }
    }
} // END_Of_ShimOpenandBaud

/* ----------------------------------------------------------------------------
    * function waitForReenumeration(prevPort, prevInfo, timeoutMs=12000)
    * What:  Wait for device to disconnect/reconnect and return the *new* SerialPort.
    * Notes: Uses native getPorts (not shims) and resolves on the first connect event
    *        whose port !== prevPort. Adds a short settle delay.
    * -------------------------------------------------------------------------- */
async function waitForReenumeration(prevPort, prevInfo, timeoutMs = 12000) {
    const nativeGetPorts =
    navigator.serial?.__nativeGetPorts ||
    (navigator.serial?.getPorts && navigator.serial.getPorts.bind(navigator.serial)) ||
    null;

    return new Promise((resolve) => {
    let done = false;

    const finish = async (cand) => {
        if (done) return;
        done = true;
        cleanup();
        try { await new Promise(r => setTimeout(r, 250)); } catch {}
        resolve(cand || null);
    };

    const onConnect = (ev) => {
        const cand = ev?.port;
        const sameObj = cand === prevPort;
        try {
        const info = cand?.getInfo?.();
        log('[rebind] connect event candidate:', info || '(no getInfo)', 'sameObj=', sameObj);
        } catch {
        log('[rebind] connect event candidate: (no getInfo) sameObj=', sameObj);
        }
        if (!sameObj && cand) finish(cand);
    };

    const cleanup = () => {
        try { navigator.serial?.removeEventListener?.('connect', onConnect); } catch {}
        clearTimeout(tmr);
    };

    // Listen for the OS connect event
    try { navigator.serial?.addEventListener?.('connect', onConnect); } catch {}

    // Poll with the *native* getter in case the event is missed
    (async function poll() {
        const end = Date.now() + timeoutMs;
        try { await new Promise(r => setTimeout(r, 150)); } catch {}
        while (!done && Date.now() < end) {
        try {
            const getList = navigator.serial?.__nativeGetPorts || navigator.serial?.getPorts;
            const list = await getList?.();
            const cand = Array.isArray(list) ? list.find(p => p && p !== prevPort) : null;
            if (cand) return finish(cand);
        } catch {}
        try { await new Promise(r => setTimeout(r, 200)); } catch {}
        }
        finish(null);
    })();

    const tmr = setTimeout(() => finish(null), timeoutMs + 500);
    });
} // END-Of_WaitforReenumeration

/* ----------------------------------------------------------------------------
    * function connect()
    * What:  Opens the Web Serial chooser, safely opens the port, preps esptool
    *        transport/loader, syncs with ROM bootloader, and updates UI state.
    * When:  Called by the Connect button. Single-flight guarded.
    * Ends:  Resolves with detected chip label; leaves `loader` ready for flashing.
    * -------------------------------------------------------------------------- */
async function connect() {
    const call = ++__connectCalls;
    if (__isConnecting) {
    log(`[connect #${call}] already running; ignoring.`);
    return;
    }
    __isConnecting = true;
    log(`[connect #${call}] start`);

    let openedHere = false;
    let connected  = false;

    try {
    // Environment checks
    if (!('serial' in navigator)) {
        alert('Web Serial not supported. Use Chrome/Edge desktop.');
        throw new Error('Web Serial unsupported');
    }
    if (!window.isSecureContext && location.protocol !== 'file:') {
        alert('Not a secure context. Use HTTPS, http://localhost, or open the file directly.');
        throw new Error('Insecure context');
    }
    try {
        const p = await navigator.permissions?.query?.({ name: 'serial' });
        log('[connect] Permission state:', p?.state);
    } catch {}

    // Always show the chooser
    setStatus('Opening serial chooser…');
    log('[connect] navigator.serial.requestPort()…');
    try {
        port = await navigator.serial.requestPort();
        log('[connect] Port chosen:', typeof port?.getInfo === 'function' ? port.getInfo() : '(no getInfo)');
        installPortShims(port);
        __shimSetSignals(port, 'port');
        __shimOpenAndBaud(port, 'port');

        if (typeof port.getInfo !== 'function') {
        try {
            Object.defineProperty(port, 'getInfo', {
            value: () => ({ usbVendorId: undefined, usbProductId: undefined })
            });
        } catch {}
        }

        // Expose for legacy/variant bundles
        globalThis.port         = port;
        globalThis.selectedPort = port;
        globalThis.SerialPort   = port;
        globalThis.esptoolPort  = port;
        globalThis.__PORT__     = port;

        // Extra aliases
        globalThis.serialPort            = port;
        globalThis.__serialPort          = port;
        globalThis.__selectedPort        = port;
        globalThis.WebSerialPort         = port;
        globalThis.ESPTOOL_PORT          = port;
        globalThis.__selectedRealPort    = port;
        globalThis.__CURRENT_SERIAL_PORT__ = port;

        // Let the shimmed getPorts() resolve to this port
        try { if (typeof __portResolve === 'function') __portResolve(port); } catch {}

    } catch (e) {
        if (e?.name === 'NotFoundError' || e?.name === 'AbortError') {
        setStatus('Connect cancelled.');
        log('[connect] chooser cancelled');
        return;
        }
        if (e?.name === 'SecurityError') {
        alert('Allow Serial in chrome://settings/content/serialPorts');
        throw e;
        }
        throw e;
    }

    // Open if not already open
    if (!port.readable) {
        log('[connect] Opening port @', BAUD, 'baud…');
        try {
        await port.open({ baudRate: BAUD });
        openedHere = true;
        } catch (e) {
        const msg = e?.message || '';
        if (e?.name === 'InvalidStateError' || /already open/i.test(msg)) {
            log('[connect] open(): already open — continuing.');
        } else if (/another app|in use/i.test(msg)) {
            setStatus('Port is already open in another app/tab.');
            throw new Error('Port is already open in another app/tab.');
        } else {
            throw e;
        }
        }
    } else {
        log('[connect] Port appears open already (port.readable present); continuing.');
    }

    // Nudge DTR/RTS (best effort)
    try {
        await port.setSignals({ dataTerminalReady: false, requestToSend: true  }); await new Promise(r => setTimeout(r, 100));
        await port.setSignals({ dataTerminalReady: true,  requestToSend: false }); await new Promise(r => setTimeout(r, 100));
        log('[connect] Toggled DTR/RTS');
    } catch (e) {
        log('[connect] setSignals warning:', e?.message || e);
    }

    // Idempotent-open shim — some bundles call port.open() again during connect()
    try {
        const nativeOpen = port.open?.bind(port);
        if (nativeOpen && !port.__openShim) {
        Object.defineProperty(port, '__openShim', { value: true });
        port.open = async function patchedOpen(opts) {
            if (port.readable) {
            log('[port.open shim] already open — ignoring duplicate open',
                opts ? JSON.stringify(opts) : '');
            return;
            }
            return nativeOpen(opts);
        };
        }
    } catch (e) {
        log('[port.open shim] warn:', e?.message || String(e));
    }

    // Lazy-load esptool bundle exactly once
    if (!esptoolPromise) {
        if (typeof importEsptoolFromBase64 !== 'function') {
        alert('Bundle helper importEsptoolFromBase64() missing.');
        throw new Error('importEsptoolFromBase64() is missing from the bundle.');
        }

        // Preflight visibility before import
        try {
        const gp = navigator.serial?.getPorts;
        log('[preflight] typeof getPorts =', typeof gp);
        log('[preflight] getPorts[0] type =', typeof gp?.[0],
            'ports[0] type =', typeof navigator.serial?.ports?.[0]);
        const idx0 = gp?.[0];
        if (idx0 && typeof idx0.getInfo === 'function') {
            try { log('[preflight] getPorts[0].getInfo():', idx0.getInfo()); }
            catch (e) { log('[preflight] getPorts[0].getInfo() threw:', e?.message); }
        }
        const arr = await gp?.();
        log('[preflight] await getPorts() len =',
            Array.isArray(arr) ? arr.length : '(n/a)',
            'first ok =', !!arr?.[0],
            'first.getInfo =', typeof arr?.[0]?.getInfo);
        } catch (e) {
        log('[preflight] probe error:', e?.message || String(e));
        }

        // Import while the selected port is exposed
        esptoolPromise = __withPortExposedForBundle(port, async () => {
        log('[connect] esptool bundle import initiated…');
        try {
            const mod = await importEsptoolFromBase64();
            log('[connect] esptool bundle import OK');
            return mod;
        } catch (e) {
            console.error('[connect] import failed:', e?.message || e, e?.stack || '(no stack)');
            try {
            const gp = navigator.serial?.getPorts;
            console.error('[import fail] typeof getPorts =', typeof gp,
                            'getPorts[0] =', typeof gp?.[0],
                            'ports[0] =', typeof navigator.serial?.ports?.[0]);
            } catch {}
            throw e;
        }
        });
    }

    const mod = await esptoolPromise;
    log('[connect] esptool bundle import OK');
    globalThis.__ESPTOOL_MOD__ = mod; // debug: allow flash() to inspect module if needed

    if (typeof prepareEsptool !== 'function') {
        throw new Error('prepareEsptool() is missing from the bundle.');
    }
    const { makeTransport, makeLoader } = prepareEsptool(mod);

    // Terminal used by esptool (and our debug log)
    const term = ensureTerminalAPI({ write: (s = '') => log(String(s).replace(/\r/g, '')) });

    // Build transport
    transport = makeTransport(port);
    log('[connect] transport created:', transport && (transport.constructor?.name || String(transport)));
    __shimSetSignals(transport, 'transport');
    __shimOpenAndBaud(transport, 'transport');

    // Ensure transport.port exists + make transport.open tolerant (before loader build)
    if (transport && !transport.port) {
        log('[connect] transport.port missing; patching with selected port.');
        try { Object.defineProperty(transport, 'port', { value: port, configurable: true }); } catch {}
    }

    try {
        if (transport && typeof transport.open === 'function' && !transport.open.__shim) {
        const nativeTOpen = transport.open.bind(transport);
        const shim = async (...args) => {
            try {
            if (port?.readable) {
                log('[transport.open shim] already open — skipping transport.open()');
                return;
            }
            return await nativeTOpen(...args);
            } catch (e) {
            const msg = e?.message || '';
            if (e?.name === 'InvalidStateError' || /already open/i.test(msg)) {
                log('[transport.open shim] already open — continuing.');
                return;
            }
            throw e;
            }
        };
        Object.defineProperty(shim, '__shim', { value: true });
        transport.open = shim;
        }
    } catch (e) {
        log('[transport.open shim] warn:', e?.message || String(e));
    }

    // === BUILD LOADER (robust + verbose) ===
    let _loader = null;
    try {
        _loader = await makeLoader(transport, BAUD, term);
        log('[connect] makeLoader(transport, …) OK:', _loader?.constructor?.name || typeof _loader);
    } catch (e1) {
        log('[connect] makeLoader threw:', e1?.message || String(e1));

        // Fallback 1: some bundles export makeLoader(port, baud, term)
        try {
        if (typeof mod.makeLoader === 'function') {
            _loader = await mod.makeLoader(port, BAUD, term);
            log('[connect] makeLoader(port, …) fallback OK');
        } else {
            throw e1;
        }
        } catch (e2) {
        // Fallback 2: construct ESPLoader ourselves
        try {
            const T = mod.Transport || mod.EsptoolTransport;
            const L = mod.ESPLoader || (mod.default && mod.default.ESPLoader);
            if (!T || !L) throw e2;
            const t2 = (transport && transport.port) ? transport : new T(port);
            _loader = new L(t2, BAUD, term);
            log('[connect] ESPLoader(new Transport(port), …) fallback OK');
        } catch (e3) {
            log('[connect] loader fallback failed:', e3?.message || String(e3));
            throw e1; // preserve original context
        }
        }
    }

    loader = _loader;
    if (!loader) throw new Error('Loader factory returned null/undefined.');
    loader.terminal = ensureTerminalAPI(loader.terminal);

    // Optional: try a bundle reset helper (best effort)
    try {
        if (mod.ClassicReset) {
        const Reset = mod.ClassicReset;
        const r = new Reset(transport);
        if (typeof r.run === 'function') {
            await r.run();
            log('[connect] ClassicReset run OK');
        }
        }
    } catch (e) {
        log('[connect] reset helper ignored:', e?.message || String(e));
    }

    // === Resolve entrypoint and sync ===
    const main = loader.main_fn || loader.main || loader.sync || loader.connect || loader.detect;
    log('[connect] resolved main =', main?.name || '(anonymous)');
    if (!main) throw new Error('Loader has no main function on this bundle.');

    setStatus('Syncing with ROM bootloader…');
    log('[connect] Calling loader main…');
    __connectAttemptTs = Date.now();

    // REBIND-SAFE handshake
    let detected;
    try {
        detected = await main.call(loader);
    } catch (e) {
        const msg = e?.message || String(e);
        if (/setSignals|NetworkError/i.test(msg)) {
        log('[rebind] Handshake interrupted (likely USB reboot). Waiting for new port…');
        const prevInfo = (typeof port?.getInfo === 'function') ? port.getInfo() : null;
        const newPort  = await waitForReenumeration(port, prevInfo, 8000);

        if (newPort) {
            // Adopt fresh handle
            port = newPort;
            installPortShims(port);
            __shimSetSignals(port, 'port');
            __shimOpenAndBaud(port, 'port');

            // Refresh global aliases
            globalThis.port = globalThis.selectedPort = globalThis.SerialPort =
            globalThis.esptoolPort = globalThis.__PORT__ = port;
            globalThis.__selectedRealPort = globalThis.__CURRENT_SERIAL_PORT__ = port;

            // Settle & reopen if needed
            try { await new Promise(r => setTimeout(r, 350)); } catch {}
            try {
            const nativeOpen = port.open?.bind(port);
            if (nativeOpen && !port.__openShim) {
                Object.defineProperty(port, '__openShim', { value: true });
                port.open = async function patchedOpen(opts) {
                const br = (opts && Number(opts.baudRate)) || BAUD;
                if (!br || br <= 0) {
                    log('[port.open shim] invalid baud=', br, '; using', BAUD);
                    opts = { ...(opts || {}), baudRate: BAUD };
                }
                if (port.readable) {
                    log('[port.open shim] already open — ignoring duplicate open',
                        opts ? JSON.stringify(opts) : '');
                    return;
                }
                return nativeOpen(opts);
                };
            }
            if (!port.readable) await port.open({ baudRate: BAUD });
            } catch (eOpen) {
            log('[rebind] open on new port failed:', eOpen?.message || String(eOpen));
            throw e;
            }

            // Rebuild transport
            try {
            transport = makeTransport(port);
            log('[rebind] new transport:', transport?.constructor?.name || typeof transport);
            if (!transport.port) { try { Object.defineProperty(transport, 'port', { value: port, configurable: true }); } catch {} }
            __shimSetSignals(transport, 'transport');
            __shimOpenAndBaud(transport, 'transport');

            if (typeof transport.open === 'function' && !transport.open.__shim) {
                const nativeTOpen = transport.open.bind(transport);
                const shim = async (...args) => {
                try {
                    if (port?.readable) {
                    log('[transport.open shim] already open — skipping transport.open()');
                    return;
                    }
                    return await nativeTOpen(...args);
                } catch (eTO) {
                    const m2 = eTO?.message || '';
                    if (eTO?.name === 'InvalidStateError' || /already open/i.test(m2)) {
                    log('[transport.open shim] already open — continuing.');
                    return;
                    }
                    throw eTO;
                }
                };
                Object.defineProperty(shim, '__shim', { value: true });
                transport.open = shim;
            }
            } catch (eT) {
            log('[rebind] transport rebuild failed:', eT?.message || String(eT));
            throw eT;
            }

            // Rebuild loader
            try {
            loader = await makeLoader(transport, BAUD, term);
            loader.terminal = ensureTerminalAPI(loader.terminal);
            log('[rebind] new loader:', loader?.constructor?.name || typeof loader);
            } catch (eL) {
            log('[rebind] loader rebuild failed:', eL?.message || String(eL));
            throw eL;
            }

            // Gentle DTR/RTS tickle
            try {
            await port.setSignals?.({ dataTerminalReady: false, requestToSend: true  }); await new Promise(r => setTimeout(r, 120));
            await port.setSignals?.({ dataTerminalReady: true,  requestToSend: false }); await new Promise(r => setTimeout(r, 120));
            } catch (eSig) {
            log('[rebind] post-toggle warning:', eSig?.message || String(eSig));
            }

            try { await new Promise(r => setTimeout(r, 250)); } catch {}
            log('[rebind] Retrying loader main on new port…');
            __connectAttemptTs = Date.now();
            detected = await (loader.main_fn || loader.main || loader.sync || loader.connect || loader.detect).call(loader);

        } else {
            log('[rebind] Timed out waiting for re-enumeration.');
            throw e;
        }
        } else {
        throw e;
        }
    }

    const label = detected || CHIP_LABEL;
    connected = true;

    log('[connect] Connected to', label, 'portInfo=',
        typeof port?.getInfo === 'function' ? port.getInfo() : '(no getInfo)');
    setStatus(`Connected (${label})`);
    updateFlashButtonState();
    return label;

    } catch (e) {
    log('[connect] ERROR:', e?.name || 'Error', '-', e?.message || String(e));
    const msg = e?.message || e?.name || String(e);
    if (/in another app|another application|in use/i.test(msg)) {
        alert('The selected serial port is already open in another app or tab. Close it there and try again.');
    } else if (/Web Serial unsupported|Insecure context/.test(msg)) {
        // Already alerted above
    } else {
        alert(msg);
    }
    throw e;

    } finally {
    // If connect failed and opened the port, best-effort close so next try works
    try {
        log('[connect] finally:', { openedHere, connected, readable: !!port?.readable });
        if (openedHere && !connected && port?.readable) {
        log('[connect] Closing port due to failure…');
        setFlashEnabled(false);
        await port.close();
        }
    } catch {}
    __isConnecting = false;
    log('[connect] end');
    }
} // end connect()

/* ----------------------------------------------------------------------------
    * function flashFile(file)
    * Always sends a DTR/RTS pulse after.
    * -------------------------------------------------------------------------- */
async function flashFile(file) {
    log('[flash] start');
    setProgress(0);
    if (!file)   throw new Error('No firmware selected.');
    if (!loader) throw new Error('Not connected. Click Connect first.');

    const bytes = new Uint8Array(await file.arrayBuffer());
    log('[flash] file:', file.name, 'size:', bytes.length, 'bytes');

    // Helper: detect chip name for reset gating
    const chipName = (() => {
    try {
        if (loader.chip?.CHIP_NAME) return String(loader.chip.CHIP_NAME);
        if (loader.chip?.name)      return String(loader.chip.name);
        if (typeof loader.getChip === 'function') return String(loader.getChip());
    } catch {}
    return '';
    })();
    const is8266 = /8266/i.test(chipName);

    // Progress helper
    const reportProgress = (sent, total) => {
    const pct = Math.floor((sent / total) * 100);
    if (!reportProgress.__last || pct - reportProgress.__last >= 10 || pct === 100) {
        reportProgress.__last = pct;
        log(`[flash] progress ${pct}% (${sent}/${total})`);
        setProgress(pct);
    }
    };

    // Best-effort reboot: only softReset on ESP8266; always DTR/RTS pulse
    const bestEffortReboot = async () => {
    if (is8266 && typeof loader.softReset === 'function') {
        try { await loader.softReset(); log('[flash] softReset (ESP8266) issued'); }
        catch (e) { log('[flash] softReset note:', e?.message || String(e)); }
    }
    try {
        await port?.setSignals?.({ dataTerminalReady: false, requestToSend: true  }); await new Promise(r => setTimeout(r, 80));
        await port?.setSignals?.({ dataTerminalReady: true,  requestToSend: false }); await new Promise(r => setTimeout(r, 80));
        await port?.setSignals?.({ dataTerminalReady: false, requestToSend: false });
        log('[flash] DTR/RTS pulse sent');
    } catch (e) {
        log('[flash] DTR/RTS pulse note:', e?.message || String(e));
    }
    };

    // Try 1: canonical write_flash([[addr, bytes]])
    if (typeof loader.write_flash === 'function') {
    setStatus('Flashing…');
    log('[flash] using loader.write_flash([[addr, bytes]]) at', FLASH_ADDR);
    await loader.write_flash([[FLASH_ADDR, bytes]]);
    setProgress(100);
    await bestEffortReboot();
    setStatus('Flash complete.');
    log('[flash] done via write_flash');
    return;
    }

    // Try 2: low-level flashBegin/flashBlock/flashFinish
    const fb   = loader.flashBegin   || loader.flash_begin;
    const fblk = loader.flashBlock   || loader.flashData  || loader.flash_data;
    const ff   = loader.flashFinish  || loader.flash_finish;

    if (typeof fb === 'function' && typeof fblk === 'function' && typeof ff === 'function') {
    setStatus('Flashing…');
    log('[flash] using low-level flashBegin/flashBlock/flashFinish at', FLASH_ADDR);

    const blockSize =
        loader.FLASH_WRITE_SIZE  ||
        loader.ESP_RAM_BLOCK     ||
        loader.FLASH_WRITE_CHUNK ||
        0x4000;

    const total  = bytes.length;
    const blocks = Math.ceil(total / blockSize);

    if (fb.length >= 4) {
        log('[flash] flashBegin(size, blocks, blockSize, offset)=', total, blocks, blockSize, FLASH_ADDR);
        await fb.call(loader, total, blocks, blockSize, FLASH_ADDR);
    } else {
        log('[flash] flashBegin(size, offset)=', total, FLASH_ADDR);
        await fb.call(loader, total, FLASH_ADDR);
    }

    let sent = 0;
    for (let seq = 0; sent < total; seq++) {
        const chunk = bytes.subarray(sent, Math.min(sent + blockSize, total));
        if (fblk.length >= 2) await fblk.call(loader, chunk, seq);
        else                  await fblk.call(loader, chunk);
        sent += chunk.length;
        reportProgress(sent, total);
    }

    try {
        if (ff.length >= 1) {
        await ff.call(loader, /*reboot*/ true);
        log('[flash] flashFinish(true) requested reboot');
        } else {
        await ff.call(loader);
        log('[flash] flashFinish() done');
        }
    } catch (e) {
        log('[flash] flashFinish note:', e?.message || String(e));
    }

    await bestEffortReboot();
    setStatus('Flash complete.');
    log('[flash] done via flashBegin/Block/Finish');
    return;
    }

    // Try 3: writeFlash(bytes, addr)
    if (typeof loader.writeFlash === 'function' && loader.writeFlash.length >= 2) {
    setStatus('Flashing…');
    log('[flash] using loader.writeFlash(bytes, addr) at', FLASH_ADDR);
    await loader.writeFlash(bytes, FLASH_ADDR);
    setProgress(100);
    await bestEffortReboot();
    setStatus('Flash complete.');
    log('[flash] done via writeFlash(bytes, addr)');
    return;
    }

    // Try 4: program() shapes
    if (typeof loader.program === 'function') {
    setStatus('Flashing…');
    log('[flash] trying loader.program variants…');
    try {
        await loader.program([[FLASH_ADDR, bytes]]);
        await bestEffortReboot();
        setStatus('Flash complete.');
        log('[flash] done via program([[addr,bytes]])');
        setProgress(100);
        return;
    } catch {}

    try {
        await loader.program([{ address: FLASH_ADDR, data: bytes }]);
        await bestEffortReboot();
        setStatus('Flash complete.');
        log('[flash] done via program([{address,data}])');
        setProgress(100);
        return;
    } catch {}

    try {
        await loader.program(bytes, FLASH_ADDR);
        await bestEffortReboot();
        setStatus('Flash complete.');
        log('[flash] done via program(bytes,addr)');
        setProgress(100);
        return;
    } catch {}
    }

    // No usable path found
    try {
    log('[flash] NO suitable flasher found. Own keys:', Object.keys(loader || {}));
    log('[flash] Proto keys:', Object.getOwnPropertyNames(Object.getPrototypeOf(loader) || {}));
    } catch {}
    throw new Error('No flash function found on loader (flashFile/write_flash).');
} // end flashFile()

/* ----------------------------------------------------------------------------
    * Bundle helpers (import + adapter)
    * What:  Provide the two functions expected by connect():
    *        - importEsptoolFromBase64(): dynamic-import the Base64 bundle
    *        - prepareEsptool(mod): map bundle exports to { makeTransport, makeLoader }
    * -------------------------------------------------------------------------- */
async function importEsptoolFromBase64() {
    try {
    // Preferred: import straight from a data: URL
    return await import(`data:application/javascript;base64,${ESPT_BUNDLE_BASE64}`);
    } catch {
    // Fallback: Blob URL (handles some CSPs/loaders)
    const blob = new Blob([atob(ESPT_BUNDLE_BASE64)], { type: 'text/javascript' });
    const url  = URL.createObjectURL(blob);
    try {
        return await import(url);
    } finally {
        URL.revokeObjectURL(url);
    }
    }
} // END importEsptoolFromBase64

function prepareEsptool(mod) {
    // Flatten default export if present
    const m = (mod && typeof mod === 'object' && mod.default && typeof mod.default === 'object')
    ? { ...mod, ...mod.default }
    : mod || {};

    // Transport factory: try common shapes
    function makeTransport(port) {
    if (typeof m.makeTransport === 'function')     return m.makeTransport(port);
    if (typeof m.Transport === 'function')         return new m.Transport(port);
    if (typeof m.EsptoolTransport === 'function')  return new m.EsptoolTransport(port);
    throw new Error('No transport factory available in esptool bundle.');
    }

    // Loader factory: try common shapes
    async function makeLoader(transport, baud, term) {
    if (typeof m.makeLoader === 'function')  return m.makeLoader(transport, baud, term);
    if (typeof m.ESPLoader === 'function')   return new m.ESPLoader(transport, baud, term);
    if (m.default && typeof m.default.ESPLoader === 'function') {
        return new m.default.ESPLoader(transport, baud, term);
    }
    throw new Error('No loader class/factory available in esptool bundle.');
    }

    return { makeTransport, makeLoader };
} // END prepareEsptool

/* ----------------------------------------------------------------------------
    * function wireUI()
    * What:  Attaches listeners to Connect/Flash buttons and firmware <input>.
    * When:  Run once on DOM ready. Prints probes so you can see what was found.
    * Ends:  Leaves buttons correctly typed and (dis)abled to match state.
    * -------------------------------------------------------------------------- */
function wireUI() {
    //log('dom: ready, wiring UI… (state=', document.readyState, ')');
    log('System ready for .bin');
    const btnConnect = $('#connect');
    const btnFlash   = $('#flash');
    const fileInput  = $('#firmware');

    // Refresh cached references now that DOM is guaranteed to exist
    statusEl = $('#status');
    debugEl  = $('#debug');

    // Progress nodes (in case the DOM changed)
    progressBar  = $('#progress-bar');
    progressText = $('#progress-text');

    // Probe what can be seen on the page
    /*log('[probe] elements',
        'connect=', !!btnConnect,
        'flash=',   !!btnFlash,
        'file=',    !!fileInput);*/

    if (btnConnect) btnConnect.type = 'button';
    if (btnFlash)   btnFlash.type   = 'button';

    let selectedFile = null;

    // File chooser -> remember and log size
    fileInput?.addEventListener('change', () => {
    selectedFile = fileInput.files?.[0] || null;
    if (selectedFile) {
        log('Firmware:', selectedFile.name, selectedFile.size, 'bytes');
    }
    if (btnFlash) btnFlash.disabled = !selectedFile || !loader;
    updateFlashButtonState();
    });

    // Connect button
    btnConnect?.addEventListener('click', async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    btnConnect.disabled = true;
    try {
        setStatus('Connecting…');
        await connect();
        updateFlashButtonState();
    } catch (e) {
        console.error('[WebSerial] connect error:', e);
        // alert handled inside connect()
    } finally {
        btnConnect.disabled = false;
        updateFlashButtonState();
    }
    });

    // Flash button
    btnFlash?.addEventListener('click', async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (!selectedFile) return alert('Choose a .bin first.');
    if (!loader)       return alert('Connect to the device first.');

    let succeeded = false;
    btnFlash.disabled = true;

    try {
        await flashFile(selectedFile);
        succeeded = true;
    } catch (e) {
        alert(e?.message || String(e));
    } finally {
        // Stay disabled after a successful flash; otherwise restore based on state
        if (succeeded) {
        btnFlash.disabled = true;
        // Optionally also force the styled state helper:
        // setFlashEnabled(false);
        } else {
        btnFlash.disabled = !selectedFile || !loader;
        }
    }
    });

    setStatus('Ready. Pick a firmware file, then click Connect.');
} // end wireUI()

/* Kick off UI wiring */
onReady(wireUI);