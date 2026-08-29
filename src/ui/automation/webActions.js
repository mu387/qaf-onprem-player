const { PDFDocument } = require('pdf-lib');
const axios = require('axios');
const fsSync = require('fs');
const fs = require('fs').promises;
const pdfParse = require('pdf-parse'); // Make sure this line is present
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
// Module-level variable to store PDF text
let pdfText = null;
//const mysql = require('mysql');
const mysql = require('mysql2/promise'); // Use mysql2/promise for async/await support

const {
    Builder,
    Browser,
    By,
    Key,
    until,
    Select,
} = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const edge = require('selenium-webdriver/edge');
const { WebDriver } = require('selenium-webdriver/lib/webdriver');
const { Session } = require('selenium-webdriver/lib/session');
const seleniumHttp = require('selenium-webdriver/http');
const { table } = require('console');

// Track all Selenium drivers started by WebActions so we can close them all on demand.
const activeWebDrivers = new Set();
let lastWebActionsInstance = null;
const clearLastWebActionsInstance = () => {
    lastWebActionsInstance = null;
};
const removeActiveWebDriver = driverRef => {
    if (!driverRef) return;
    try {
        activeWebDrivers.delete(driverRef);
    } catch (_) {}
};
const quitWithTimeout = async (driverRef, ms = 5000) => {
    if (!driverRef) return false;
    let completed = false;
    try {
        await Promise.race([
            driverRef.quit(),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`quit timeout after ${ms}ms`)), ms),
            ),
        ]);
        completed = true;
    } catch (err) {
        console.log('driver quit timeout/err (ignored)', err?.message || err);
        try { await driverRef.close(); } catch (_) {}
    } finally {
        removeActiveWebDriver(driverRef);
    }
    return completed;
};
const resetRecorderGlobals = () => {
    return {
        setupScript: function () {
            window.__qaRecorderActive = false;
            if (window.__qaRecorderMouseOver && window.__qaRecorderHandlersAttached) {
                document.removeEventListener('mouseover', window.__qaRecorderMouseOver, true);
            }
            if (window.__qaRecorderClick && window.__qaRecorderHandlersAttached) {
                document.removeEventListener('click', window.__qaRecorderClick, true);
            }
            window.__qaRecorderHandlersAttached = false;
            if (window.__qaRecorderLastEl) {
                window.__qaRecorderLastEl.style.outline = window.__qaRecorderLastOutline || '';
                window.__qaRecorderLastEl = null;
                window.__qaRecorderLastOutline = null;
            }
            window.__qaRecorderQueue = [];
        },
    };
};

const splitTopLevelSegments = (rawValue, delimiter) => {
    const text = String(rawValue || '');
    const segments = [];
    let current = '';
    let quote = '';
    let roundDepth = 0;
    let squareDepth = 0;
    let curlyDepth = 0;

    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        const next = text.slice(index, index + delimiter.length);

        if (quote) {
            current += char;
            if (char === quote && text[index - 1] !== '\\') {
                quote = '';
            }
            continue;
        }

        if (char === '"' || char === '\'') {
            quote = char;
            current += char;
            continue;
        }

        if (char === '(') roundDepth += 1;
        else if (char === ')' && roundDepth > 0) roundDepth -= 1;
        else if (char === '[') squareDepth += 1;
        else if (char === ']' && squareDepth > 0) squareDepth -= 1;
        else if (char === '{') curlyDepth += 1;
        else if (char === '}' && curlyDepth > 0) curlyDepth -= 1;

        if (
            next === delimiter &&
            roundDepth === 0 &&
            squareDepth === 0 &&
            curlyDepth === 0
        ) {
            const normalized = current.trim();
            if (normalized) {
                segments.push(normalized);
            }
            current = '';
            index += delimiter.length - 1;
            continue;
        }

        current += char;
    }

    const normalized = current.trim();
    if (normalized) {
        segments.push(normalized);
    }

    return segments;
};

const splitHelperValueParts = rawValue => splitTopLevelSegments(rawValue, '>>');

const parseNamedHelperValue = rawValue => {
    const parts = splitHelperValueParts(rawValue);
    const entries = [];
    for (const part of parts) {
        const separatorIndex = part.indexOf('=');
        if (separatorIndex <= 0) {
            entries.push({ key: '', value: part });
            continue;
        }

        entries.push({
            key: part.slice(0, separatorIndex).trim().toLowerCase(),
            value: part.slice(separatorIndex + 1).trim(),
        });
    }

    return entries;
};

const helperHasNamedLocatorOption = (step, allowedKeys) => {
    const keys = new Set(
        parseNamedHelperValue(step?.value)
            .map(entry => entry.key)
            .filter(Boolean),
    );
    return allowedKeys.some(key => keys.has(key));
};

const helperUsesOwnLocator = step => {
    const keywordName = String(step?.keyword?.name || step?.keyword || '').trim().toLowerCase();

    if (keywordName === 'waitforelement' || keywordName === 'waitfortext') {
        return helperHasNamedLocatorOption(step, ['target', 'scope', 'xpath']);
    }

    if (keywordName === 'sendkey') {
        return helperHasNamedLocatorOption(step, ['locator']);
    }

    if (keywordName === 'switchtoiframe') {
        return String(step?.value || '').trim().length > 0;
    }

    return false;
};

const applyExplicitTargetIndex = (target, explicitTargetIndex) => {
    const normalizedTarget = String(target || '').trim();
    if (!normalizedTarget) {
        return normalizedTarget;
    }

    const normalizedIndex = Number(explicitTargetIndex);
    if (!Number.isInteger(normalizedIndex) || normalizedIndex < 0) {
        return normalizedTarget;
    }

    if (/\[\d+\]$/.test(normalizedTarget)) {
        return normalizedTarget;
    }

    return `${normalizedTarget}[${normalizedIndex}]`;
};

const resolveSendKeyConfig = step => {
    const entries = parseNamedHelperValue(step?.value);
    const config = {
        action: '',
        target: String(step?.xPath || '').trim(),
    };

    for (const entry of entries) {
        if (!entry.key) {
            config.action = entry.value.trim().toLowerCase().replace(/^:+/, '');
            continue;
        }

        switch (entry.key) {
            case 'locator':
            case 'target':
            case 'scope':
            case 'xpath':
                config.target = entry.value.trim();
                break;
            default:
                throw new Error(`Unknown sendkey option: ${entry.key}`);
        }
    }

    return config;
};

const normalizeWhitespace = value => String(value || '').replace(/\s+/g, ' ').trim();

const normalizeDebugBrowserName = value => {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return 'chrome';
    if (['chrome', 'google chrome', 'chromium'].includes(normalized)) return 'chrome';
    if (['edge', 'microsoft edge', 'msedge'].includes(normalized)) return 'edge';
    if (['firefox', 'ff'].includes(normalized)) return 'firefox';
    if (normalized === 'safari') return 'safari';
    return normalized;
};

const inferDebugBrowserName = metadata => {
    const browserText = String(metadata?.Browser || metadata?.browser || '').toLowerCase();
    if (browserText.includes('edg')) return 'edge';
    if (browserText.includes('chrome')) return 'chrome';
    return '';
};

const resolveDebugBrowserConfig = step => {
    const entries = parseNamedHelperValue(step?.value);
    const config = {
        browser: 'chrome',
        port: 9222,
        userDataDir: '',
        implicitWait: 10000,
    };

    for (const entry of entries) {
        if (!entry.key) {
            if (/^\d+$/.test(entry.value)) {
                config.port = Number(entry.value);
            } else if (entry.value) {
                config.browser = normalizeDebugBrowserName(entry.value);
            }
            continue;
        }

        switch (entry.key) {
            case 'browser':
            case 'name':
                config.browser = normalizeDebugBrowserName(entry.value);
                break;
            case 'port': {
                const parsedPort = Number(entry.value);
                if (Number.isFinite(parsedPort) && parsedPort > 0) {
                    config.port = parsedPort;
                }
                break;
            }
            case 'profile':
            case 'userdatadir':
                config.userDataDir = entry.value.trim();
                break;
            case 'implicitwait':
            case 'timeout': {
                const parsedWait = Number(entry.value);
                if (Number.isFinite(parsedWait) && parsedWait > 0) {
                    config.implicitWait = parsedWait;
                }
                break;
            }
            default:
                throw new Error(`Unknown debug browser option: ${entry.key}`);
        }
    }

    return config;
};

const resolveDebugBrowserExecutable = browser => {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const candidatesByBrowser = {
        chrome: [
            process.env.CHROME_BIN,
            path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        ],
        edge: [
            process.env.EDGE_BIN,
            path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        ],
    };

    for (const candidate of candidatesByBrowser[browser] || []) {
        const trimmed = String(candidate || '').trim();
        if (!trimmed) continue;
        try {
            if (fsSync.existsSync(trimmed)) {
                return trimmed;
            }
        } catch (_) {}
    }

    return '';
};

const resolveDebugBrowserProfileDir = config => {
    if (config.userDataDir) {
        return config.userDataDir;
    }

    return path.join(
        process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
        'QAF-OnPremPlayer',
        'BrowserDebugProfiles',
        `${config.browser}-${config.port}`,
    );
};

const queryDebugBrowserMetadata = async port => {
    try {
        const response = await axios.get(`http://127.0.0.1:${port}/json/version`, {
            timeout: 1500,
            validateStatus: status => status >= 200 && status < 500,
        });
        return response.status === 200 && response.data && typeof response.data === 'object'
            ? response.data
            : null;
    } catch (_) {
        return null;
    }
};

const waitForDebugBrowserMetadata = async (port, timeoutMs = 10000) => {
    const start = Date.now();
    while ((Date.now() - start) < timeoutMs) {
        const metadata = await queryDebugBrowserMetadata(port);
        if (metadata) {
            return metadata;
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    return null;
};

const resolveWaitForElementConfig = step => {
    const entries = parseNamedHelperValue(step?.value);
    const config = {
        state: '',
        timeout: 10000,
        target: String(step?.xPath || '').trim(),
    };

    for (const entry of entries) {
        if (!entry.key) {
            config.state = entry.value.toLowerCase();
            continue;
        }

        switch (entry.key) {
            case 'state':
                config.state = entry.value.toLowerCase();
                break;
            case 'timeout': {
                const parsedTimeout = Number(entry.value);
                if (!Number.isNaN(parsedTimeout) && parsedTimeout > 0) {
                    config.timeout = parsedTimeout;
                }
                break;
            }
            case 'target':
            case 'scope':
            case 'xpath':
                config.target = entry.value;
                break;
            default:
                throw new Error(`Unknown waitForElement option: ${entry.key}`);
        }
    }

    return config;
};

const resolveWaitForTextConfig = step => {
    const entries = parseNamedHelperValue(step?.value);
    const config = {
        text: '',
        scope: '',
        match: 'contains',
        timeout: 10000,
    };

    for (const entry of entries) {
        if (!entry.key) {
            config.text = entry.value;
            continue;
        }

        switch (entry.key) {
            case 'text':
                config.text = entry.value;
                break;
            case 'scope':
            case 'target':
            case 'xpath':
                config.scope = entry.value;
                break;
            case 'match':
                config.match = entry.value.toLowerCase();
                break;
            case 'timeout': {
                const parsedTimeout = Number(entry.value);
                if (!Number.isNaN(parsedTimeout) && parsedTimeout > 0) {
                    config.timeout = parsedTimeout;
                }
                break;
            }
            default:
                throw new Error(`Unknown waitForText option: ${entry.key}`);
        }
    }

    return config;
};

const resolveInFunctionWaitConfig = rawValue => {
    const entries = parseNamedHelperValue(rawValue);
    const config = {
        delayMs: 0,
    };

    for (const entry of entries) {
        if (!entry.key) {
            continue;
        }

        switch (entry.key) {
            case 'setinfuncwait':
            case 'infuncwait':
            case 'wait': {
                const rawDelay = String(entry.value || '').trim().replace(/^:+/, '');
                const parsedDelay = Number(rawDelay);
                if (Number.isFinite(parsedDelay) && parsedDelay > 0) {
                    config.delayMs = parsedDelay;
                }
                break;
            }
            default:
                break;
        }
    }

    return config;
};

const resolvePrimaryHelperValue = rawValue => {
    const entries = parseNamedHelperValue(rawValue);
    const positional = entries.find(entry => !entry.key);
    if (positional) {
        return positional.value;
    }

    return String(rawValue || '').trim();
};

const resolveSelectConfig = rawValue => {
    const entries = parseNamedHelperValue(rawValue);
    const config = {
        method: 'text',
        value: '',
    };

    for (const entry of entries) {
        if (!entry.key) {
            config.value = entry.value;
            continue;
        }

        switch (entry.key) {
            case 'text':
            case 'value':
            case 'index':
                config.method = entry.key;
                config.value = entry.value;
                break;
            case 'setinfuncwait':
            case 'infuncwait':
            case 'wait':
            case 'timeout':
            case 'waittimeout':
                break;
            default:
                break;
        }
    }

    return config;
};

const resolveRequestedToggleState = rawValue => {
    const normalized = String(resolvePrimaryHelperValue(rawValue) || '').trim().toLowerCase();
    if (!normalized) {
        return null;
    }

    if (['on', 'true', 'yes', '1', 'selected'].includes(normalized)) {
        return true;
    }

    if (['off', 'false', 'no', '0', 'unselected'].includes(normalized)) {
        return false;
    }

    return null;
};

class WebActions {
    driver = null;
    visibleOnlyLookup = false;
    recorderActive = false;
    highlightEnabled = false;
    sessionSnapshot = null;
    frameSwitched = false;
    currentContext = null;
    contextSwitched = false;

    setHighlightEnabled(enabled) {
        this.highlightEnabled = !!enabled;
    }

    getVisibleOnlyLookup() {
        return this.visibleOnlyLookup === true;
    }

    setVisibleOnlyLookup(enabled) {
        this.visibleOnlyLookup = enabled === true;
    }

    async visible() {
        this.visibleOnlyLookup = true;
        return 'Visible-only lookup enabled for current step.';
    }

    async hasValidSession() {
        if (!this.driver) return false;
        try {
            const session = await this.driver.getSession();
            return !!session?.getId?.() || !!session?.id_ || !!session?.id;
        } catch (err) {
            return false;
        }
    }

    resolveExecutorUrl() {
        try {
            const opts = this.driver?.executor_?.client_?.options_;
            if (!opts) return null;
            const protocol = String(opts.protocol || 'http:').replace(/:$/, '');
            const host = opts.host || opts.hostname || '127.0.0.1';
            const port = opts.port ? `:${opts.port}` : '';
            const basePath = opts.pathname || opts.path || '';
            const normalizedPath = basePath && basePath !== '/' ? String(basePath).replace(/\/$/, '') : '';
            return `${protocol}://${host}${port}${normalizedPath}`;
        } catch (_) {
            return null;
        }
    }

    async captureSessionSnapshot() {
        const hasSession = await this.hasValidSession();
        if (!hasSession) {
            this.sessionSnapshot = null;
            return null;
        }
        try {
            const session = await this.driver.getSession();
            const sessionId = session?.getId?.() || session?.id_ || session?.id || null;
            const executorUrl = this.resolveExecutorUrl();
            if (!sessionId || !executorUrl) {
                this.sessionSnapshot = null;
                return null;
            }
            this.sessionSnapshot = {
                session_id: String(sessionId),
                executor_url: String(executorUrl),
                captured_at: new Date().toISOString(),
            };
            return { ...this.sessionSnapshot };
        } catch (_) {
            this.sessionSnapshot = null;
            return null;
        }
    }

    getSessionSnapshot() {
        return this.sessionSnapshot ? { ...this.sessionSnapshot } : null;
    }

    getLookupContext() {
        return this.currentContext || this.driver;
    }

    clearLookupContext() {
        this.currentContext = null;
        this.contextSwitched = false;
    }

    async resetFrameContextIfNeeded() {
        if (!this.frameSwitched && !this.contextSwitched) {
            return false;
        }

        const hasSession = await this.hasValidSession();
        if (!hasSession) {
            this.frameSwitched = false;
            this.clearLookupContext();
            return false;
        }

        if (this.frameSwitched) {
            await this.driver.switchTo().defaultContent();
            console.log('Switched to default content');
        }
        this.frameSwitched = false;
        this.clearLookupContext();
        return true;
    }

    async tryReconnectSession(snapshot) {
        const sessionId = String(snapshot?.session_id || '').trim();
        const executorUrl = String(snapshot?.executor_url || '').trim();
        if (!sessionId || !executorUrl) return false;
        try {
            const executor = new seleniumHttp.Executor(new seleniumHttp.HttpClient(executorUrl));
            const attached = new WebDriver(new Session(sessionId, {}), executor);
            // Probe to validate session liveness.
            await attached.getCurrentUrl();
            this.driver = attached;
            activeWebDrivers.add(this.driver);
            lastWebActionsInstance = this;
            this.sessionSnapshot = {
                session_id: sessionId,
                executor_url: executorUrl,
                captured_at: new Date().toISOString(),
            };
            return true;
        } catch (error) {
            console.log('[recovery] session reconnect failed', error?.message || error);
            return false;
        }
    }

    async destroyTrackedDrivers() {
        const driversToClose = new Set(activeWebDrivers);
        if (this.driver) {
            driversToClose.add(this.driver);
        }
        if (driversToClose.size === 0) {
            this.driver = null;
            return;
        }
        for (const d of driversToClose) {
            await quitWithTimeout(d);
        }
        this.driver = null;
        this.sessionSnapshot = null;
    }

    async ensureSessionOrThrow() {
        const ok = await this.hasValidSession();
        if (!ok) {
            throw new Error('WebDriver session is not active. Please launch the browser again.');
        }
    }

    async launchBrowser(step, implicitWait = 10000) {
        // Browser.CHROME
        // Browser.FIREFOX
        // Browser.EDGE
        // Browser.INTERNET_EXPLORER
        // Browser.SAFARI
        if (step?.forceCleanup) {
            await this.destroyTrackedDrivers();
        }
        const browserKey = typeof step?.value === 'string' ? step.value.trim().toUpperCase() : '';
        const browserName = Browser[browserKey] || (typeof step?.value === 'string' ? step.value.trim().toLowerCase() : '');
        if (!browserName) {
            const expected = Object.keys(Browser).join(', ');
            throw new Error(`Invalid browser value '${step?.value}'. Expected one of: ${expected}`);
        }
        console.log(`[launchBrowser] browser=${browserName}`);

        // ensure any prior recorder state/handlers are cleared before new session
        try {
            await this.driver?.executeScript(resetRecorderGlobals().setupScript);
        } catch (e) {}

        const resolveChromeDriverPath = () => {
            const candidates = [
                process.env.CHROMEDRIVER_PATH,
                process.env.WEBDRIVER_CHROME_DRIVER,
                process.env.CHROME_DRIVER_PATH,
                'C:\\chromedriver-win64\\chromedriver-win64\\chromedriver.exe',
                'C:\\chromedriver\\chromedriver.exe',
                path.join(process.cwd(), 'chromedriver.exe'),
            ]
                .map(value => String(value || '').trim())
                .filter(Boolean);

            for (const candidate of candidates) {
                try {
                    if (fsSync.existsSync(candidate)) {
                        return candidate;
                    }
                } catch (_) {}
            }
            return '';
        };

        let builder = new Builder()
            .forBrowser(browserName)
            .setCapability('unhandledPromptBehavior', 'ignore');

        const requestedChrome = String(browserName).toLowerCase() === String(Browser.CHROME).toLowerCase();
        const explicitChromeDriverPath = resolveChromeDriverPath();
        if (requestedChrome && explicitChromeDriverPath) {
            console.log(`[launchBrowser] using CHROMEDRIVER_PATH=${explicitChromeDriverPath}`);
            builder = builder.setChromeService(new chrome.ServiceBuilder(explicitChromeDriverPath));
        }

        try {
            this.driver = await builder.build();
        } catch (error) {
            const message = String(error?.message || '');
            const normalized = message.toLowerCase();
            if (requestedChrome && normalized.includes('this version of chromedriver only supports chrome version')) {
                const guidance = [
                    'ChromeDriver/Chrome major version mismatch.',
                    'If your network blocks selenium-manager, set CHROMEDRIVER_PATH to a matching chromedriver.exe.',
                    'Example: CHROMEDRIVER_PATH=C:\\drivers\\chromedriver-147\\chromedriver.exe',
                ].join(' ');
                throw new Error(`${message} ${guidance}`);
            }
            if (
                requestedChrome &&
                (normalized.includes('unable to obtain browser driver') ||
                    normalized.includes('error decoding response body') ||
                    normalized.includes('selenium-manager.exe'))
            ) {
                const guidance = [
                    'ChromeDriver auto-resolution failed (selenium-manager).',
                    'Set CHROMEDRIVER_PATH (or WEBDRIVER_CHROME_DRIVER) to a local matching chromedriver.exe.',
                    'Detected fallback path:',
                    explicitChromeDriverPath || 'none',
                ].join(' ');
                throw new Error(`${message} ${guidance}`);
            }
            throw error;
        }

        activeWebDrivers.add(this.driver);
        lastWebActionsInstance = this;
        this.driver.manage().window().minimize();
        await this.driver.sleep(100);
        this.driver.manage().window().maximize();
        await this.driver.manage().setTimeouts({ implicit: implicitWait });
        await this.captureSessionSnapshot();
    };
    async launchDebugBrowser(step) {
        const config = resolveDebugBrowserConfig(step);
        if (!['chrome', 'edge'].includes(config.browser)) {
            throw new Error(`launchDebugBrowser only supports Chrome and Edge. Received: ${config.browser}`);
        }

        const existingMetadata = await queryDebugBrowserMetadata(config.port);
        if (existingMetadata) {
            console.log(`[launchDebugBrowser] debug browser already available on port ${config.port}; connecting`);
            return await this.connectBrowser(step, { config, metadata: existingMetadata });
        }

        const executable = resolveDebugBrowserExecutable(config.browser);
        if (!executable) {
            throw new Error(`Could not find a local ${config.browser} executable for launchDebugBrowser.`);
        }

        const profileDir = resolveDebugBrowserProfileDir(config);
        fsSync.mkdirSync(profileDir, { recursive: true });

        const args = [
            `--remote-debugging-port=${config.port}`,
            `--user-data-dir=${profileDir}`,
            '--disable-popup-blocking',
            '--no-first-run',
            '--no-default-browser-check',
        ];

        const child = spawn(executable, args, {
            detached: true,
            stdio: 'ignore',
        });
        child.unref();

        const metadata = await waitForDebugBrowserMetadata(config.port, 10000);
        if (!metadata) {
            throw new Error(`Timed out waiting for ${config.browser} debug browser on port ${config.port}.`);
        }

        return await this.connectBrowser(step, { config, metadata });
    };
    async debugBrowser(step) {
        return await this.launchDebugBrowser(step);
    };
    async connectBrowser(step, options = {}) {
        const config = options?.config || resolveDebugBrowserConfig(step);
        const metadata = options?.metadata || await queryDebugBrowserMetadata(config.port);
        if (!metadata) {
            throw new Error(`No debug browser is listening on port ${config.port}. Start launchDebugBrowser first.`);
        }

        const inferredBrowser = inferDebugBrowserName(metadata);
        const browser = inferredBrowser || config.browser;
        if (!['chrome', 'edge'].includes(browser)) {
            throw new Error(`connectBrowser only supports Chrome and Edge. Detected: ${browser || 'unknown'}`);
        }

        const debuggerAddress = `127.0.0.1:${config.port}`;
        let builder = new Builder()
            .forBrowser(browser === 'edge' ? Browser.EDGE : Browser.CHROME)
            .setCapability('unhandledPromptBehavior', 'ignore');

        if (browser === 'chrome') {
            const driverPath = [
                process.env.CHROMEDRIVER_PATH,
                process.env.WEBDRIVER_CHROME_DRIVER,
                process.env.CHROME_DRIVER_PATH,
            ].map(value => String(value || '').trim()).find(Boolean);
            const chromeOptions = new chrome.Options();
            chromeOptions.options_.debuggerAddress = debuggerAddress;
            chromeOptions.addArguments('--start-maximized');
            builder = builder.setChromeOptions(chromeOptions);
            if (driverPath) {
                builder = builder.setChromeService(new chrome.ServiceBuilder(driverPath));
            }
        } else {
            const driverPath = [
                process.env.EDGEDRIVER_PATH,
                process.env.WEBDRIVER_EDGE_DRIVER,
                process.env.MSEDGEDRIVER_PATH,
            ].map(value => String(value || '').trim()).find(Boolean);
            const edgeOptions = new edge.Options();
            edgeOptions.options_.debuggerAddress = debuggerAddress;
            edgeOptions.addArguments('--start-maximized');
            builder = builder.setEdgeOptions(edgeOptions);
            if (driverPath) {
                builder = builder.setEdgeService(new edge.ServiceBuilder(driverPath));
            }
        }

        this.driver = await builder.build();
        activeWebDrivers.add(this.driver);
        lastWebActionsInstance = this;
        await this.driver.manage().setTimeouts({ implicit: config.implicitWait });
        await this.captureSessionSnapshot();
    };
    async navigate(step) {
        await this.ensureSessionOrThrow();
        const url = (step.value || '').trim();
        if (!url) {
            throw new Error('Navigate URL is empty.');
        }
        console.log(url);
        await this.driver.get(url);
        try {
            await this.driver.wait(
                async () => {
                    const state = await this.driver.executeScript('return document.readyState');
                    return state === 'complete';
                },
                5000,
            );
        } catch (_) {
            // ignore readyState timeout to avoid breaking existing flows
        }
    };
    findStrategy(path) {
        if (/^id=(.*)(\[\d+\])?$/.test(path)) {
            return 'id';
        } else if (/^name=(.*)(\[\d+\])?$/.test(path)) {
            return 'name';
        } else if (/^css=(.*)(\[\d+\])?$/.test(path)) {
            return 'css';
        } else if (/^linkText=(.*)(\[\d+\])?$/.test(path)) {
            return 'linkText';
        } else if (/^partialLinkText=(.*)(\[\d+\])?$/.test(path)) {
            return 'partialLinkText';
        } else if (/^tagName=(.*)(\[\d+\])?$/.test(path)) {
            return 'tagName';
        } else {
            return 'xPath';
        }
    };
    findElementBy(path) {
        const strategy = this.findStrategy(path);
        console.log({ strategy, path });

        //The regular expression /(.*)(\[\d+\])$/ is used to match any string that ends with a positive number enclosed in square brackets (arrayindex).
        const parts = path.match(/(.*)(\[\d+\])$/);
        // console.log({ strategy, parts });
        let elAddress = Array.isArray(parts) && parts.length > 0 ? parts[1] : path;

        if (elAddress.includes(`${strategy}=`)) {
            elAddress = elAddress.replace(`${strategy}=`, '');
        }
        // elAddress = elAddress.replace(/^["']|["']$/g, ''); // Remove quotes
        // console.log({ elAddress });
        try {
            switch (strategy) {
                case 'id':
                    return By.id(elAddress);
                case 'name':
                    return By.name(elAddress);
                case 'css':
                    return By.css(elAddress);
                case 'linkText':
                    return By.linkText(elAddress);
                case 'partialLinkText':
                    return By.partialLinkText(elAddress);
                case 'tagName':
                    return By.tagName(elAddress);
                default:
                    console.log('xPath', elAddress);
                    return By.xpath(elAddress);
            }
        } catch (error) {
            console.log(error);
            console.log(
                `Failed in findElementBy strategy: ${strategy} path:  '${path}'`.bgRed,
            );
            return null;
        }
    };

    async highlightElement(element) {
        try {
            // Save original styles so the temporary highlight can be reverted cleanly.
            const originalOutline = await this.driver.executeScript("return arguments[0].style.outline;", element);
            const originalBackgroundColor = await this.driver.executeScript("return arguments[0].style.backgroundColor;", element);
            // Apply a soft fill highlight without changing the existing timing behavior.
            await this.driver.executeScript(
                "arguments[0].style.backgroundColor = 'rgb(226, 205, 178)'; arguments[0].style.outline = '2px solid rgb(160, 120, 82)';",
                element,
            );
            // Wait for 200ms
            await this.driver.sleep(200);
            // Restore original styles
            await this.driver.executeScript(
                "arguments[0].style.outline = arguments[1]; arguments[0].style.backgroundColor = arguments[2];",
                element,
                originalOutline,
                originalBackgroundColor,
            );
        } catch (error) {
            console.log('error in highlight element', error);
        }
    }
    // NOTE: Current indexing uses JS array positions for trailing [n] and may be 1-off vs XPath.
    // Example: //div[1] maps to elements[1] (second element). Tests rely on this today.
    // Recommendation: add a compatibility flag before switching to true XPath indexing.
    async findElement(path, step = null) {
        try {
            console.log(path);
            console.log(this.driver.findElements)
            console.log(this.findElementBy(path))
            let element;
            let elements = await this.getLookupContext().findElements(this.findElementBy(path));
            if (this.visibleOnlyLookup && Array.isArray(elements) && elements.length > 0) {
                const visibleMatches = [];
                for (const candidate of elements) {
                    try {
                        if (await candidate.isDisplayed()) {
                            visibleMatches.push(candidate);
                        }
                    } catch (_) {}
                }
                elements = visibleMatches;
            }
            console.log(elements);
            if (Array.isArray(elements) && elements.length > 1) {
                //The regular expression /(.*)(\[\d+\])$/ is used to match any string that ends with a positive number enclosed in square brackets (arrayindex).
                const parts = path.match(/(.*)(\[\d+\])$/);
                element = elements[parseInt(parts[2].replace('[', '').replace(']', ''))];
            }else if (elements[0]) {
                element = elements[0];
            } else {
                throw new Error(this.visibleOnlyLookup ? 'No visible element found' : 'Element not found');
            }
            const shouldHighlight = step?.highlight === true || this.highlightEnabled === true;
            if (shouldHighlight) {
                await this.highlightElement(element);
            }
            return element;
        } catch (error) {
            console.log(`Element not found using expression '${path}'`.bgRed);
            throw new Error(this.visibleOnlyLookup ? 'No visible element found' : 'Element not found');
        }
    };
    async sendKeys(step) {
        const el = await this.findElement(step.xPath, step);
        const result = await el.sendKeys(resolvePrimaryHelperValue(step?.value));
        await this.applyInFunctionWait(step);
        return result;
    };
    async sendKey(step) {
        const config = resolveSendKeyConfig(step);
        const scopedStep = config.target && config.target !== step?.xPath
            ? { ...step, xPath: config.target }
            : step;
        const action = config.action;
        switch (action) {
            case 'selectall':
                await this.selectAll(scopedStep);
                break;
            case 'tab': {
                const el = await this.findElement(scopedStep.xPath, scopedStep);
                await el.sendKeys(Key.TAB);
                break;
            }
            case 'clear':
                await this.clearInput(scopedStep);
                break;
            case 'escape':
            case 'esc': {
                const el = await this.findElement(scopedStep.xPath, scopedStep);
                await el.sendKeys(Key.ESCAPE);
                break;
            }
            case 'home': {
                const el = await this.findElement(scopedStep.xPath, scopedStep);
                await el.sendKeys(Key.HOME);
                break;
            }
            case 'backspace': {
                const el = await this.findElement(scopedStep.xPath, scopedStep);
                await el.sendKeys(Key.BACK_SPACE);
                break;
            }
            case 'enter': {
                const el = await this.findElement(scopedStep.xPath, scopedStep);
                await el.sendKeys(Key.ENTER);
                break;
            }
            case 'keyup':
            case 'arrowup': {
                const el = await this.findElement(scopedStep.xPath, scopedStep);
                await el.sendKeys(Key.ARROW_UP);
                break;
            }
            case 'keydown':
            case 'arrowdown': {
                const el = await this.findElement(scopedStep.xPath, scopedStep);
                await el.sendKeys(Key.ARROW_DOWN);
                break;
            }
            case 'click': {
                const el = await this.findElement(scopedStep.xPath, scopedStep);
                await el.click();
                break;
            }
            case 'focusout':
                await this.focusOut(scopedStep);
                break;
            case 'dismissalert':
                await this.alertDismiss();
                break;
            case 'acceptalert':
                await this.alertAccept();
                break;
            case 'hover':
                await this.hoverElement(scopedStep);
                break;
            default:
                throw new Error(`Unknown sendkey action: ${step?.value}`);
        }
    };
    async selectAll(step) {
        const el = await this.findElement(step.xPath, step);
        await el.click(); // Ensure the element is focused
        return await el.sendKeys(Key.chord(Key.CONTROL, 'a'));
    };
    async copy(step) {
        const el = await this.findElement(step.xPath, step);
        return await el.sendKeys(Key.chord(Key.CONTROL, 'c'));
    };
    async paste(step) {
        const el = await this.findElement(step.xPath, step);
        return await el.sendKeys(Key.chord(Key.CONTROL, 'v'));
    };
    async multiKeyboardActions(step) {
        const el = await this.findElement(step.xPath, step);
    
        // Check if multiple actions are provided using '>>'
        const raw = String(step?.value || '');
        const actions = splitHelperValueParts(raw).map(action => action.trim().toLowerCase());
    
        // Loop through each action and execute the corresponding key event
        for (const action of actions) {
            switch (action) {
                case 'selectall':
                    await el.click(); // Ensure the element is focused
                    await el.sendKeys(Key.chord(Key.CONTROL, 'a'));
                    break;
    
                case 'copy':
                    await el.sendKeys(Key.chord(Key.CONTROL, 'c'));
                    break;
    
                case 'paste':
                    await el.sendKeys(Key.chord(Key.CONTROL, 'v'));
                    break;
    
                case 'cut':
                    await el.sendKeys(Key.chord(Key.CONTROL, 'x'));
                    break;
    
                case 'tab':
                    await el.sendKeys(Key.TAB);
                    break;
    
                case 'enter':
                    await el.sendKeys(Key.ENTER);
                    break;
    
                case 'keydown':
                    await el.sendKeys(Key.ARROW_DOWN);
                    break;
    
                case 'keyup':
                    await el.sendKeys(Key.ARROW_UP);
                    break;
    
                case 'esc':
                case 'escape':
                    await el.sendKeys(Key.ESCAPE);
                    break;
    
                case 'delete':
                    await el.sendKeys(Key.DELETE);
                    break;
    
                case 'backspace':
                    await el.sendKeys(Key.BACK_SPACE);
                    break;
    
                case 'clear':
                    await el.clear();
                    break;
                case 'click':
                    await el.click();
                    break;

                default:
                    throw new Error(`Unknown action: ${action}`);
            }
        }
    };
    async click(step) {
        const el = await this.findElement(step.xPath, step);
        const requestedState = resolveRequestedToggleState(step?.value);
        if (requestedState !== null) {
            const currentState = await this.resolveElementToggleState(el);
            if (currentState === requestedState) {
                await this.applyInFunctionWait(step);
                return `element already ${requestedState ? 'selected' : 'unselected'}`;
            }
        }
        await el.click();
        await this.applyInFunctionWait(step);
        return 'element clicked';
    };
    // NOTE: No current keyword mapping uses setSecure in this engine.
    async setSecure(step) {
        return setText(step);
    };
    async wait(step) {
        await this.driver.sleep(step.value);
    };
    async applyInFunctionWait(step) {
        const config = resolveInFunctionWaitConfig(step?.value);
        if (!config.delayMs) {
            return;
        }
        await this.driver.sleep(config.delayMs);
    };
    async resolveElementToggleState(element) {
        try {
            return await element.isSelected();
        } catch (_) {
            // fall through to DOM attribute inspection below
        }

        try {
            return await this.driver.executeScript(
                `
                    const el = arguments[0];
                    if (!el) return false;

                    if (typeof el.checked === 'boolean') {
                        return el.checked;
                    }

                    const ariaPressed = el.getAttribute('aria-pressed');
                    if (ariaPressed === 'true') return true;
                    if (ariaPressed === 'false') return false;

                    const ariaSelected = el.getAttribute('aria-selected');
                    if (ariaSelected === 'true') return true;
                    if (ariaSelected === 'false') return false;

                    const ariaChecked = el.getAttribute('aria-checked');
                    if (ariaChecked === 'true') return true;
                    if (ariaChecked === 'false') return false;

                    return el.classList.contains('active')
                        || el.classList.contains('selected')
                        || el.classList.contains('checked')
                        || el.classList.contains('on');
                `,
                element,
            );
        } catch (_) {
            return false;
        }
    };
    async waitForElement(step) {
        const config = resolveWaitForElementConfig(step);
        const target = String(config.target || '').trim();
        const state = String(config.state || '').trim().toLowerCase();
        const useInheritedParentLocator = !helperUsesOwnLocator(step);
        const indexedInheritedTarget = useInheritedParentLocator
            ? applyExplicitTargetIndex(target, step?.__explicitTargetIndex)
            : target;

        if (!target) {
            throw new Error('waitForElement requires a target XPath or the step XPath.');
        }

        if (!state) {
            throw new Error('waitForElement requires a state value.');
        }

        await this.driver.wait(async () => {
            let elements = [];
            if (useInheritedParentLocator && indexedInheritedTarget !== target) {
                try {
                    const element = await this.findElement(indexedInheritedTarget, {
                        ...step,
                        xPath: indexedInheritedTarget,
                        highlight: false,
                    });
                    elements = element ? [element] : [];
                } catch (_) {
                    elements = [];
                }
            } else {
                elements = await this.getLookupContext().findElements(this.findElementBy(target));
            }

            switch (state) {
                case 'exist':
                    return elements.length > 0;
                case 'notexist':
                    return elements.length === 0;
                case 'visible':
                    return (await Promise.all(elements.map(async element => {
                        try {
                            return await element.isDisplayed();
                        } catch (_) {
                            return false;
                        }
                    }))).some(Boolean);
                case 'hidden': {
                    if (elements.length === 0) {
                        return true;
                    }

                    const visibleStates = await Promise.all(elements.map(async element => {
                        try {
                            return await element.isDisplayed();
                        } catch (_) {
                            return false;
                        }
                    }));
                    return visibleStates.every(isVisible => !isVisible);
                }
                case 'enabled':
                    return (await Promise.all(elements.map(async element => {
                        try {
                            return await element.isEnabled();
                        } catch (_) {
                            return false;
                        }
                    }))).some(Boolean);
                case 'disabled': {
                    if (elements.length === 0) {
                        return false;
                    }

                    const enabledStates = await Promise.all(elements.map(async element => {
                        try {
                            return await element.isEnabled();
                        } catch (_) {
                            return false;
                        }
                    }));
                    return enabledStates.every(isEnabled => !isEnabled);
                }
                case 'selected':
                    return (await Promise.all(elements.map(async element => {
                        try {
                            return await element.isSelected();
                        } catch (_) {
                            return false;
                        }
                    }))).some(Boolean);
                case 'notselected': {
                    if (elements.length === 0) {
                        return false;
                    }

                    const selectedStates = await Promise.all(elements.map(async element => {
                        try {
                            return await element.isSelected();
                        } catch (_) {
                            return false;
                        }
                    }));
                    return selectedStates.every(isSelected => !isSelected);
                }
                default:
                    throw new Error(`Unsupported waitForElement state: ${config.state}`);
            }
        }, config.timeout, `waitForElement timed out waiting for ${state} on ${indexedInheritedTarget}`);
    };
    async waitForText(step) {
        const config = resolveWaitForTextConfig(step);
        const text = normalizeWhitespace(config.text);
        const match = String(config.match || 'contains').trim().toLowerCase();

        if (!text) {
            throw new Error('waitForText requires a text value.');
        }

        if (match !== 'contains' && match !== 'exact') {
            throw new Error(`Unsupported waitForText match: ${config.match}`);
        }

        await this.driver.wait(async () => {
            const scopeElement = config.scope
                ? await this.findElement(config.scope, step)
                : this.currentContext && this.currentContext !== this.driver
                    ? this.currentContext
                    : null;
            return await this.driver.executeScript(
                `
                    const root = arguments[0] || document.body;
                    const expectedText = arguments[1];
                    const matchMode = arguments[2];
                    const normalize = value => String(value || '').replace(/\\s+/g, ' ').trim();
                    const expected = normalize(expectedText);
                    if (!expected) {
                        return false;
                    }

                    const nodes = [root, ...Array.from(root.querySelectorAll('*'))];
                    return nodes.some(node => {
                        const textValue = normalize(node.innerText || node.textContent || '');
                        if (!textValue) {
                            return false;
                        }

                        return matchMode === 'exact'
                            ? textValue === expected
                            : textValue.includes(expected);
                    });
                `,
                scopeElement,
                text,
                match,
            );
        }, config.timeout, `waitForText timed out waiting for text ${text}`);
    };
    async existold(step) {
        return await this.findElement(step.xPath, step);
    };
    async exist(step) {
        try {
            await this.findElement(step.xPath, step);
            console.log("Element found");
            return true; // Element found
        } catch (error) {
            console.log("Element not found");
            throw new Error(`Element not found for locator: ${step.xPath}`);
        }
    };
    async maxBrowser() {
        await this.driver.manage().window().maximize();
    };
    async minBrowser() {
        await this.driver.manage().window().minimize();
    };
    async openTab(step) {
        await this.driver.switchTo().newWindow('tab');
        //if no value then just opens the new tab
        if ((step.value ?? '') !== '' && isValidUrl(step.value)) {
            await this.navigate(step);
        }
    };
    async closeTab(step) {
        //if no value then closes  the current tab
        console.log(step.value.bgRed);
        if (step.value ?? '' !== '') {
            const windows = await this.driver.getAllWindowHandles();
            console.log(windows);
            await this.driver.switchTo().window(windows[parseInt(step.value)]);
            await this.driver.close();
            const updatedWindows = await this.driver.getAllWindowHandles();
            console.log(updatedWindows);
            if (updatedWindows.length >= 1) {
                console.log('in condition');
                console.log(updatedWindows[updatedWindows.length - 1]);
                await this.driver.switchTo().window(updatedWindows[updatedWindows.length - 1]);
                return;
            }
            return;
        }

        await this.driver.close();
    };
    async openWindow(step) {
        await this.driver.switchTo().newWindow('window');
        console.log(await this.driver.getAllWindowHandles());
        //if no value then just opens the new window
        if ((step.value ?? '') !== '' && this.isValidUrl(step.value)) {
            await this.navigate(step);
        }
    };

    async closeBrowser(step = {}) {
        const hasSession = await this.hasValidSession();
        if (!hasSession) {
            console.log('[webActions] closeBrowser: no valid driver session; clearing tracked refs');
            try { removeActiveWebDriver(this.driver); } catch (_) {}
            this.driver = null;
            this.sessionSnapshot = null;
            return;
        }
        const shouldDestroySession =
            step?.isLastTestCaseStep ?? (step?.isLastTestCase && step?.lastStep) ?? true;
        let shouldClear = false;
        try {
            const handles = await this.driver.getAllWindowHandles();
            const idx = parseInt(step?.value, 10);
            console.log('closeBrowser handles:', handles, 'idx:', idx, 'destroy:', !!shouldDestroySession);
            if (idx && idx >= 1 && idx <= handles.length) {
                await this.driver.switchTo().window(handles[idx - 1]);
            }
            if (shouldDestroySession) {
                await quitWithTimeout(this.driver);
                shouldClear = true;
                return;
            }
            if (handles.length > 1) {
                await this.driver.close();
                const remaining = await this.driver.getAllWindowHandles().catch(() => []);
                console.log('closeBrowser remaining after close:', remaining);
                if (remaining.length) {
                    await this.driver.switchTo().window(remaining[0]);
                }
                return;
            }
            await quitWithTimeout(this.driver);
            shouldClear = true;
        } catch (err) {
            console.log('closeBrowser error (ignored)', err?.message || err);
        } finally {
            if (shouldClear) {
                try { removeActiveWebDriver(this.driver); } catch (_) {}
                this.driver = null;
                this.sessionSnapshot = null;
            }
        }
    };

    async switchBrowser(step) {
        const windows = await this.driver.getAllWindowHandles();
        await this.driver.switchTo().window(windows[parseInt(step.value) - 1]);
    };
    async alertAccept() {
        await this.driver.wait(until.alertIsPresent(), 5000);
        let alert = await this.driver.switchTo().alert();
        await alert.accept();
    };
    async alertDismiss() {
        await this.driver.wait(until.alertIsPresent(), 5000);
        let alert = await this.driver.switchTo().alert();
        await alert.dismiss();
    };  
    async alertSetText(step) {
        await this.driver.wait(until.alertIsPresent(), 10000); // Timeout of 10 seconds
        let alert = await this.driver.switchTo().alert();
        await alert.sendKeys(step.value);
      //  await alert.accept();
    };
    async clearInput(step) {
        try {
            // Try finding the element
            const el = await this.findElement(step.xPath, step);
            if (el) {
                console.log("Element found, clearing data.");
                await el.clear();
                return "Element found and data cleared.";
            }
            throw new Error("Element not found.");
        } catch (error) {
            console.log("Error occurred while finding or clearing data:", error);
            throw error;
        }
    };

    async scrollToElementold(step) {
        const el = await this.findElement(step.xPath, step);
        await this.driver.actions().scroll(0, 0, 0, 0, el).perform();
    };
    async scrollToElement(step) {
        try {
            const el = await this.findElement(step.xPath, step);
            if (el) {
                console.log("Element found, scrolling to it.");
                await this.driver.actions().scroll(0, 0, 0, 0, el).perform();
                return "Element found and scrolled to.";
            }
            throw new Error("Element not found.");
        } catch (error) {
            console.log("Error occurred while finding or scrolling to element:", error);
            throw error;
        }
    };
    async scrollToTextold(step) {
        const scrollToTextScript = `
          const text = "${step.value}";
          const element = Array.from(document.querySelectorAll('body, body *'))
              .find(e => e.textContent.trim() === text);
              console.log(element)
          if (element) {
              element.scrollIntoView({ behavior: 'smooth', block: 'center' });
              return true;
          } else {
              return false;
          }
      `;
        await this.driver.executeScript(scrollToTextScript);
    };

    async scrollToText(step) {
  try {
    const text = String(step?.value || '');
    if (!text) {
      throw new Error('Text is empty.');
    }
    const result = await this.driver.executeScript(
      `
        const text = arguments[0];
        const element = Array.from(document.querySelectorAll('body, body *'))
          .find(e => (e.textContent || '').trim() === text);
        if (element) {
          element.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return true;
        }
        return false;
      `,
      text
    );

    if (result) {
      console.log("Text found, scrolled to element.");
      return "Text found and scrolled to element.";
    }
    throw new Error("Text not found.");
  } catch (error) {
    console.log("Error occurred while scrolling to text:", error);
    throw error;
  }
};
    // LEGACY: uses raw text injection; kept for reference/testing only.
    async scrollToTexlastworkingt(step) {
        try {
            const scrollToTextScript = `
              const text = "${step.value}";
              const element = Array.from(document.querySelectorAll('body, body *'))
                  .find(e => e.textContent.trim() === text);
              if (element) {
                  element.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  return true;
              } else {
                  return false;
              }
            `;
            const result = await this.driver.executeScript(scrollToTextScript);
    
            if (result) {
                console.log("Text found, scrolled to element.");
                return "Text found and scrolled to element.";
            }
            throw new Error("Text not found.");
        } catch (error) {
            console.log("Error occurred while scrolling to text:", error);
            throw error;
        }
    };
    
    async isValidUrl(str) {
        try {
            new URL(str);
            return true;
        } catch (err) {
            console.log('isValidUrl', err);
            return false;
        }
    };
    async executeSQL(step) {
        // Parse step.value to get connectionConfigString and sqlStatement
        const [connectionConfigStr, sqlStatementStr] = step.value.split('||').map(part => part.trim());
        // Parse the connection configuration string into an object
        const connectionConfig = JSON.parse(connectionConfigStr);
        const connection = await mysql.createConnection(connectionConfig);
        try {
            console.log('Connected to database successfully.');
            await connection.execute(sqlStatementStr);
        } finally {
            await connection.end();
        }
    };
    async connectPDF(step) {
        try {
            // url = "file:///C:/Users/Dell/Downloads/payment-receipt.pdf";
            // url = "C:\Users\Dell\Downloads\payment-receipt.pdf";    
            // url = "https://pdf-lib.js.org/assets/with_large_page_count.pdf";

            let buffer;
            let url = step.value; // Assuming step.value contains the URL or file path

            if (url.startsWith('http') || url.startsWith('https')) {
                // Fetch the PDF from the URL
                const response = await axios.get(url, { responseType: 'arraybuffer' });
                buffer = response.data;
            } else {
                // Handle local PDF file
                const filePath = url.startsWith('file://') ? decodeURIComponent(url.replace('file:///', '')) : url;
                buffer = await fs.readFile(filePath);
            }
            // Load the PDF document using pdf-lib
            const pdfDoc = await PDFDocument.load(buffer);
            console.log('PDF loaded successfully.');
            // Extract text from the PDF using pdf-parse
            const data = await pdfParse(buffer);
            console.log('PDF content:');
            console.log(data.text);

            // Store PDF text in module-level variable
            pdfText = data.text;
            return `PDF Connection established : ${step.value}`;

        } catch (error) {
            console.error('Error loading PDF:', error);
        }
    };
    async verifyPDFText(step) {
        try {
            let textToVerify = step.value;
            if (!pdfText) {
                throw new Error('PDF text not loaded. Call connectPDF first.');
            }
            // Check if the text to verify is present in the PDF text
            if (pdfText.includes(textToVerify)) {
                console.log(`Text "${textToVerify}" found in the PDF.`);
                return `${textToVerify} value matched! Value Passed: ${textToVerify} | Value Found: ${textToVerify}`;
            } else {
                throw new Error(`Text "${textToVerify}" not found in the PDF.`);
            }
        } catch (error) {
            console.error('Error verifying PDF text:', error.message);
            throw error; // Rethrow the error to be handled by the calling function
        }
    };
    async disconnectPDF(step) {
        // Clear the reference to the PDF document to allow for garbage collection
        pdfText = null;
        console.log('PDF connection disconnected and object destroyed.');
        // Reconnect to the new PDF if step parameter is provided
        // if (step) {
        //     console.log('Pdf disconnected');
        //     await connectPDF(step);
        // }
        return `PDF Connection Disconnected`;
    };
    async deletePDFFile(step) {
        let filePath = step.value;

        console.log(`Attempting to delete file at path: "${filePath}"`);

        try {
            // Check if the file exists
            const fileExists = await fs.access(filePath)
                .then(() => true)
                .catch(() => false);

            if (fileExists) {
                // File exists, proceed with deletion
                await fs.unlink(filePath);
                console.log('File deleted successfully!');
            } else {
                console.log(`File at path "${filePath}" does not exist.`);
            }
        } catch (err) {
            console.error('Error deleting file:', err);
        }
        console.log('deletePDFFile function executed.');
    };
    async getDBValue(step) {
        // Parse step.value to get connectionConfigString and sqlStatement
        const [connectionConfigStr, sqlStatementStr] = step.value.split('||').map(part => part.trim());
        console.log(`Connection string. ${connectionConfigStr}`);
        console.log(`Connection string. ${sqlStatementStr}`);
        // Parse the connection configuration string into an object
        const connectionConfig = JSON.parse(connectionConfigStr);
        const connection = await mysql.createConnection(connectionConfig);
        try {
            console.log('Connected to database successfully.');
            const [rows] = await connection.execute(sqlStatementStr);
            return rows;
        } finally {
            await connection.end();
        }
    };
    async getCookieValue(step) {
        try {

            // Get all cookies
            const cookies = await this.driver.manage().getCookies();
            // Find the cookie by name
            const cookie = cookies.find(c => c.name === step.value);
            if (cookie) {
                console.log(`Value of cookie '${step.value}':`, cookie.value);
                return cookie.value;
            } else {
                console.log(`Cookie '${step.value}' not found.`);
                return null;
            }
        } catch (error) {
            console.error('Error getting cookie value:', error);
            return null;
        }
    };
    async dragDrop(step) {
        //User will pass both xpath using locators on component
        const inputString = step.xPath;

        // Split the string using the delimiter '||'
        const parts = inputString.split('||');

        try {
            const sourceElement = await this.findElement(parts[0], step);
            const targetElement = await this.findElement(parts[1], step);
            // Perform drag and drop
            await this.driver.actions({ bridge: true })
                .dragAndDrop(sourceElement, targetElement)
                .perform();
            console.log(`Dragged element from '${sourceElement}' to '${targetElement}' successfully.`);
        } catch (error) {
            console.error('Error performing drag and drop:', error);
        }
    };
    async switchToIframe(step) {
        try {
            //Input Param
            //Before or after step xpath switchToIframe=//*[@id='frame1']
            //Revert to default content (Do not Pass Parameter)

            const rawValue = String(step?.value || '').trim();
            const value = rawValue.startsWith(':') ? rawValue.slice(1).trim() : rawValue;
            if (!value) {
                throw new Error('switchToIframe: missing iframe selector');
            }
            console.log(`Switched to iframe: ${value}`);
            if (value === 'default') {
                await this.driver.switchTo().defaultContent();
                this.frameSwitched = false;
                this.clearLookupContext();
                console.log('Switched to default content');
                return `switched back to default context`;
            } else {
                const frames = value.split('>>').map(part => part.trim()).filter(Boolean);
                if (frames.length === 0) {
                    throw new Error('switchToIframe: missing iframe selector');
                }

                for (const frameSelector of frames) {
                    const el = await this.findElement(frameSelector, step);
                    await this.driver.switchTo().frame(el);
                    this.clearLookupContext();
                }
                this.frameSwitched = true;
                console.log(`Switched to iframe: ${value}`);
                return `Switched to iframe: ${value}`;
            }
        } catch (error) {
            console.log(`Failed to switch to iframe: ${step?.value}`);
            console.error(error);
        }
    };
    async defaultContext() {
        await this.driver.switchTo().defaultContent();
        this.frameSwitched = false;
        this.clearLookupContext();
        console.log('Switched to default content');
        return 'switched back to default context';
    };
    async switchdom(step) {
        const rawValue = String(step?.value || '').trim();
        const value = rawValue.startsWith(':') ? rawValue.slice(1).trim() : rawValue;
        if (!value) {
            throw new Error('switchdom: missing shadow host selector');
        }

        const selectors = value.split('>>').map(part => part.trim()).filter(Boolean);
        if (selectors.length === 0) {
            throw new Error('switchdom: missing shadow host selector');
        }

        let context = this.getLookupContext();
        for (const selector of selectors) {
            const shadowHost = await context.findElement(By.css(selector));
            context = await shadowHost.getShadowRoot();
        }

        this.currentContext = context;
        this.contextSwitched = true;
        return `Switched to shadow context: ${value}`;
    };
    async switchdom1(step) {
        return await this.switchdom(step);
    };
    async switchToContext(step) {
        const rawValue = String(step?.value || '').trim();
        const value = rawValue.startsWith(':') ? rawValue.slice(1).trim() : rawValue;
        if (!value) {
            throw new Error('switchToContext: missing context path');
        }

        await this.driver.switchTo().defaultContent();
        this.frameSwitched = false;
        this.clearLookupContext();

        const pathSteps = value.split('<<').map(part => part.trim()).filter(Boolean);
        if (pathSteps.length === 0) {
            throw new Error('switchToContext: missing context path');
        }

        let context = this.driver;
        for (const pathStep of pathSteps) {
            const separatorIndex = pathStep.indexOf('=');
            if (separatorIndex <= 0) {
                throw new Error(`switchToContext: invalid path step '${pathStep}'`);
            }

            const stepName = pathStep.slice(0, separatorIndex).trim().toLowerCase();
            const stepValue = pathStep.slice(separatorIndex + 1).trim();

            if (!stepValue) {
                throw new Error(`switchToContext: missing value for '${stepName}'`);
            }

            if (stepName === 'switchframe' || stepName === 'switchtoiframe') {
                const frames = stepValue.split('>>').map(part => part.trim()).filter(Boolean);
                for (const frameSelector of frames) {
                    const frameElement = await context.findElement(this.findElementBy(frameSelector));
                    await this.driver.switchTo().frame(frameElement);
                    context = this.driver;
                    this.frameSwitched = true;
                    this.clearLookupContext();
                }
                continue;
            }

            if (stepName === 'switchdom') {
                const selectors = stepValue.split('>>').map(part => part.trim()).filter(Boolean);
                for (const selector of selectors) {
                    const shadowHost = await context.findElement(By.css(selector));
                    context = await shadowHost.getShadowRoot();
                }
                this.currentContext = context;
                this.contextSwitched = true;
                continue;
            }

            if (stepName === 'defaultcontext') {
                await this.defaultContext();
                context = this.driver;
                continue;
            }

            throw new Error(`switchToContext: unsupported path step '${stepName}'`);
        }

        if (context === this.driver) {
            this.clearLookupContext();
        }

        return `Switched to context: ${value}`;
    };
    async switchtopath(step) {
        return await this.switchToContext(step);
    };
    async hoverElement(step) {
        // Sample step.value: //*[text="Click Me"]
        try {
            const elementToHover = await this.findElement(step.xPath, step);
            try {
                // Wait until the element is visible
                await this.driver.wait(until.elementIsVisible(elementToHover), 10000);
                // Perform the hover action using the actions method on the driver instance
                const actions = this.driver.actions({ bridge: true });
                await actions.move({ origin: elementToHover }).perform();

                console.log(`Hovered over element: ${step.xPath}`);
                return `Hovered over element: ${step.xPath}`;
            } catch (visibilityError) {
                console.log(`Element found but not visible: ${step.xPath}`);
                throw new Error(`Element found but not visible: ${step.xPath}`);
            }
        } catch (locateError) {
            console.log(`Failed to locate element: ${step.xPath}`);
            throw new Error(`Failed to locate element: ${step.xPath}`);
        }
    };
    async select(step) {
        // Sample step.value: "value=1"
        // Sample step.value: "text=Green"
        // Sample step.value: "index=2"
        // Sample step.value: "Green"
        let method = '';
        let value = '';
        try {
            // Wait for the element to be located
            const el = await this.findElement(step.xPath, step);

            const select = new Select(el);
            const config = resolveSelectConfig(step?.value);
            if (!config.value) {
                throw new Error('Select value is empty.');
            }
            method = config.method.toLowerCase();
            value = config.value;
            switch (method) {
                case 'value':
                    await select.selectByValue(value);
                    break;
                case 'index':
                    await select.selectByIndex(parseInt(value, 10));
                    break;
                case 'text':
                    await select.selectByVisibleText(value);
                    break;
                default:
                    await select.selectByVisibleText(value);
                    break;
            }
            await this.applyInFunctionWait(step);

            console.log(`Selected option using ${method} with value: ${value}`);
        } catch (error) {
            console.error(`Failed to select option using ${method} with value: ${value}`);
            console.error(error);
            throw error;
        }
    };
    async rightClick(step) {
        try {
            const element = await this.findElement(step.xPath, step);

            await this.driver.wait(until.elementIsVisible(element), 10000);

            // Create a new action sequence and move the mouse to the element
            const actions = this.driver.actions({ bridge: true });
            await actions.move({ origin: element }).perform();
            console.log(`Moved to element: ${step.xPath}`);

            await actions.contextClick(element).perform();
            console.log(`Right Clicked on element: ${step.xPath}`);
            return `Move to Element and Right Clicked on element: ${step.xPath}`;
        } catch (error) {
            console.error(`Failed to right-click on element: ${step.xPath}`);
            console.error(error);
            throw error;
        }
    };
    async doubleClick(step) {
        try {
            const element = await this.findElement(step.xPath, step);
            await this.driver.wait(until.elementIsVisible(element), 10000);

            // Create a new action sequence and move the mouse to the element
            const actions = this.driver.actions({ bridge: true });
            await actions.doubleClick(element).perform();
            console.log(`Double Clicked on element: ${step.xPath}`);
            return `Double Clicked on element: ${step.xPath}`;
        } catch (error) {
            console.error(`Failed to Double-click on element: ${step.xPath}`);
            throw error;
        }
    };
    async verifyTextOnAlert(step) {
        try {
            await this.driver.wait(until.alertIsPresent(), 5000);
            const alert = await this.driver.switchTo().alert();
            const alertText = await alert.getText();
            console.log('Alert text:', alertText);
            if (alertText === step.value) {
                console.log(`Alert text "${step.value}" matches the expected text.`);
                return `${alertText} value matched! Value Passed: ${step.value} | Value Found: ${alertText}`;
            }
            throw new Error(`Alert text "${alertText}" does not match expected "${step.value}"`);
        } catch (error) {
            console.error('Error verifying text on alert:', error);
            throw error;
        }
    };
    normalizeElementValidationValue(value) {
        return String(value ?? '')
            .replace(/\u00a0/g, ' ')
            .replace(/[\n\r]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    };
    parseElementValidationRule(rawValue, contains = false) {
        const rawText = String(rawValue ?? '');
        const modeMatch = rawText.match(/^\s*(contains)\s*:(.*)$/is);
        const normalizedText = modeMatch ? modeMatch[2] : rawText;
        const separatorIndex = normalizedText.indexOf('=');
        const attr = separatorIndex >= 0 ? normalizedText.slice(0, separatorIndex).trim() : 'innerText';
        const expectedRaw = separatorIndex >= 0 ? normalizedText.slice(separatorIndex + 1) : normalizedText;
        const expectedValue = String(expectedRaw ?? '').trim().toLowerCase() === 'null'
            ? ''
            : expectedRaw;
        return {
            attr,
            attrKey: attr.toLowerCase(),
            expected: this.normalizeElementValidationValue(expectedValue),
            contains: contains || Boolean(modeMatch),
        };
    };
    resolveElementValidationContains(step, options = {}) {
        if (typeof options?.contains === 'boolean') {
            return options.contains;
        }
        if (String(step?.__validationMode || '').toLowerCase() === 'contains') {
            return true;
        }
        return false;
    };
    async readElementValidationValue(el, rule) {
        switch (rule.attrKey) {
            case 'isselected':
                return await el.isSelected();
            case 'isenabled':
                return await el.isEnabled();
            case 'isdisplayed':
                return await el.isDisplayed();
            case 'gettext':
            case 'innertext':
            case 'text':
                return await el.getText();
            case 'selection':
                return await el.findElement(By.css('option:checked')).getText();
            default:
                return await el.getAttribute(rule.attr);
        }
    };
    async validateElement(step, options = {}) {
        const contains = this.resolveElementValidationContains(step, options);
        const el = await this.findElement(step.xPath, step);
        const rule = this.parseElementValidationRule(step.value, contains);
        const rawActualValue = await this.readElementValidationValue(el, rule);

        if (rawActualValue === null || rawActualValue === undefined) {
            throw new Error(`Attribute "${rule.attr}" was not found on ${step?.xPath || 'the target element'}`);
        }

        const actual = this.normalizeElementValidationValue(rawActualValue);
        const matched = rule.contains ? actual.includes(rule.expected) : actual === rule.expected;

        if (!matched) {
            const comparison = rule.contains ? 'did not contain' : 'did not match';
            throw new Error(`${rule.attr} value ${comparison}. Expected: "${rule.expected}" | Actual: "${actual}"`);
        }

        const comparison = rule.contains ? 'contained' : 'matched';
        return `${rule.attr} value ${comparison}! Value Passed: ${rule.expected} | Value Found: ${actual}`;
    };
    async digitalSignature(step) {
        try {
            // Find the element using the locator
            const el = await this.findElement(step.xPath, step);
            // Create an Actions instance
            const actions = this.driver.actions({ bridge: true });
            // Perform the actions: move to element, click and hold, move by offset, release
            await actions.move({ origin: el })
                .press()
                .move({ x: 10, y: 50 })
                .release()
                .perform();
            // Wait for 1 second
            await this.driver.sleep(1000);
        } catch (error) {
            if (error.name === 'NoSuchElementError') {
                console.error('Element not found:', step?.xPath);
            } else {
                console.error('Error performing digital signature:', error);
            }
        }
    };
    async getElementValue(step) {
        try {
            const el = await this.findElement(step.xPath, step);

            const mainStr = 'isselected isenabled isdisplayed gettext'; // lookup string
            let attr = step.value;

            if (mainStr.includes(attr.toLowerCase())) { // if value in passed to function matches one of the substrings in mainStr then
                attr = attr.toLowerCase();
            }

            let attrValue;
            switch (attr) {
                case 'isselected':
                    attrValue = await el.isSelected();
                    break;
                case 'isenabled':
                    attrValue = await el.isEnabled();
                    break;
                case 'isdisplayed':
                    attrValue = await el.isDisplayed();
                    break;
                case 'gettext':
                    attrValue = await el.getText();
                    break;
                case 'selection':
                    attrValue = await el.findElement(By.css('option:checked')).getText();
                    break;
                default:
                    attrValue = await el.getAttribute(attr);
                    if (attrValue !== null && attrValue !== undefined && attrValue.includes('\n')) {
                        attrValue = attrValue.replace(/[\n\r]/g, ''); // Remove newline characters
                    }
            }
            console.log({ attrValue });
            return attrValue;
        } catch (error) {
            console.error(`Error capturing attribute value: ${error.message}`);
            return null; // Return null or handle the error as needed
        }
    };


    async focusOut(step) {
        console.log(`Value is :  '${step.value}' `);
        const xpathLiteral = value => {
            const text = String(value || '');
            if (!text.includes("'")) {
                return `'${text}'`;
            }
            if (!text.includes('"')) {
                return `"${text}"`;
            }
            const parts = text.split("'");
            const quoted = parts.map(part => `'${part}'`).join(`, "'", `);
            return `concat(${quoted})`;
        };
        const vXpath = `//*[contains(text(),${xpathLiteral(step.value)})]`;
        console.log(`xpath is :  '${vXpath}' `);
        // Find the element using the correct XPath
        const el = await this.findElement(vXpath, step);
        // Click a neutral element to blur the input
        await el.click();
        // Send ESC to ensure overlays like date pickers close
        try {
            const actions = this.driver.actions({ async: true });
            await actions.sendKeys(Key.ESCAPE).perform();
        } catch (err) {
            console.log('focusOut ESC failed (ignored)', err?.message || err);
        }
    };

    async startXPathRecorder() {
        try {
            lastWebActionsInstance = this;
            // reset any old recorder state before attaching fresh handlers
            await this.driver.executeScript(resetRecorderGlobals().setupScript);
            await this.driver.executeScript(function () {
                const rootWindow = (() => {
                    try {
                        return window.top || window;
                    } catch (_) {
                        return window;
                    }
                })();
                const shared = rootWindow.__qaRecorderShared || (rootWindow.__qaRecorderShared = {});

                const dedupe = arr => Array.from(new Set((arr || []).filter(Boolean)));
                const toXPathLiteral = text => {
                    const value = String(text || '');
                    if (!value.includes("'")) {
                        return `'${value}'`;
                    }
                    if (!value.includes('"')) {
                        return `"${value}"`;
                    }
                    const parts = value.split("'");
                    return `concat(${parts.map(part => `'${part}'`).join(`, "'", `)})`;
                };
                const escapeCssValue = value => {
                    const raw = String(value || '');
                    if (rootWindow.CSS && typeof rootWindow.CSS.escape === 'function') {
                        return rootWindow.CSS.escape(raw);
                    }
                    return raw.replace(/([#.;,:+*~'"!^$\[\]()=>|/@])/g, '\\$1');
                };
                const collectPaths = el => {
                    if (!el || el.nodeType !== Node.ELEMENT_NODE) {
                        return [];
                    }

                    const results = [];
                    const tagName = String(el.tagName || '').toLowerCase();
                    const addAttr = (attr, tpl = "//*[@%a=%v]") => {
                        if (el.hasAttribute && el.hasAttribute(attr)) {
                            const val = el.getAttribute(attr);
                            if (val) {
                                results.push(tpl.replace('%a', attr).replace('%v', toXPathLiteral(val)));
                            }
                        }
                    };

                    addAttr('data-testid');
                    addAttr('aria-label');
                    addAttr('id');
                    addAttr('name');

                    if (tagName && el.id) {
                        results.push(`${tagName}#${escapeCssValue(el.id)}`);
                    }

                    const text = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
                    if (text && text.length < 80) {
                        results.push(`//*[normalize-space(text())=${toXPathLiteral(text)}]`);
                    }

                    const absolute = (() => {
                        const segments = [];
                        let node = el;
                        while (node && node.nodeType === Node.ELEMENT_NODE) {
                            let idx = 1;
                            let sib = node.previousElementSibling;
                            while (sib) {
                                if (sib.tagName === node.tagName) idx++;
                                sib = sib.previousElementSibling;
                            }
                            segments.unshift(`${node.tagName.toLowerCase()}[${idx}]`);
                            node = node.parentElement;
                        }
                        return '/' + segments.join('/');
                    })();
                    if (absolute !== '/') {
                        results.push(absolute);
                    }

                    const cssParts = [];
                    let node = el;
                    while (node && node.nodeType === Node.ELEMENT_NODE && cssParts.length < 5) {
                        let selector = node.tagName.toLowerCase();
                        if (node.id) {
                            selector += `#${escapeCssValue(node.id)}`;
                            cssParts.unshift(selector);
                            break;
                        }
                        if (node.classList && node.classList.length) {
                            selector += '.' + Array.from(node.classList)
                                .slice(0, 2)
                                .map(name => escapeCssValue(name))
                                .join('.');
                        }
                        cssParts.unshift(selector);
                        node = node.parentElement;
                    }
                    if (cssParts.length) {
                        results.push(`css=${cssParts.join(' > ')}`);
                    }

                    return dedupe(results).slice(0, 5);
                };

                const getDocumentState = doc => {
                    const targetWindow = doc?.defaultView;
                    if (!targetWindow) {
                        return null;
                    }
                    targetWindow.__qaRecorderState = targetWindow.__qaRecorderState || {
                        attached: false,
                        lastEl: null,
                        lastOutline: '',
                        mouseOver: null,
                        click: null,
                    };
                    return targetWindow.__qaRecorderState;
                };

                const cleanupDocument = doc => {
                    if (!doc) {
                        return;
                    }
                    const state = getDocumentState(doc);
                    if (state?.mouseOver && state.attached) {
                        doc.removeEventListener('mouseover', state.mouseOver, true);
                    }
                    if (state?.click && state.attached) {
                        doc.removeEventListener('click', state.click, true);
                    }
                    if (state?.lastEl) {
                        state.lastEl.style.outline = state.lastOutline || '';
                        state.lastEl = null;
                        state.lastOutline = '';
                    }
                    if (state) {
                        state.attached = false;
                        state.mouseOver = null;
                        state.click = null;
                    }

                    const frames = Array.from(doc.querySelectorAll('iframe,frame'));
                    for (const frameEl of frames) {
                        try {
                            const childDoc = frameEl.contentDocument || frameEl.contentWindow?.document;
                            if (childDoc) {
                                cleanupDocument(childDoc);
                            }
                        } catch (_) {}
                    }
                };

                const attachDocument = (doc, frameChain) => {
                    if (!doc) {
                        return;
                    }
                    const state = getDocumentState(doc);
                    if (!state) {
                        return;
                    }

                    const highlight = el => {
                        if (!el || el.nodeType !== Node.ELEMENT_NODE) {
                            return;
                        }
                        if (state.lastEl && state.lastEl !== el) {
                            state.lastEl.style.outline = state.lastOutline || '';
                        }
                        state.lastEl = el;
                        state.lastOutline = el.style.outline;
                        el.style.outline = '2px solid red';
                    };

                    if (state.attached && state.mouseOver) {
                        doc.removeEventListener('mouseover', state.mouseOver, true);
                    }
                    if (state.attached && state.click) {
                        doc.removeEventListener('click', state.click, true);
                    }

                    state.mouseOver = evt => {
                        if (!shared.active) return;
                        highlight(evt.target);
                    };

                    state.click = evt => {
                        if (!shared.active) return;
                        evt.preventDefault();
                        evt.stopPropagation();
                        if (typeof evt.stopImmediatePropagation === 'function') {
                            evt.stopImmediatePropagation();
                        }
                        const paths = collectPaths(evt.target);
                        if (paths && paths.length) {
                            shared.queue.push({
                                contextType: frameChain.length > 0 ? 'iframe' : 'default',
                                frameCandidates: frameChain.map(entry => entry.candidates || []),
                                framePaths: frameChain.map(entry => entry.primary || '').filter(Boolean),
                                paths,
                            });
                        }
                    };

                    doc.addEventListener('mouseover', state.mouseOver, true);
                    doc.addEventListener('click', state.click, true);
                    state.attached = true;

                    const frameEls = Array.from(doc.querySelectorAll('iframe,frame'));
                    frameEls.forEach((frameEl, index) => {
                        const frameCandidates = collectPaths(frameEl);
                        const primary = frameCandidates[0] || `iframe[index=${index}]`;
                        try {
                            const childDoc = frameEl.contentDocument || frameEl.contentWindow?.document;
                            if (childDoc) {
                                attachDocument(childDoc, frameChain.concat([{ primary, candidates: frameCandidates }]));
                            }
                        } catch (error) {
                            shared.inaccessibleFrames = shared.inaccessibleFrames || [];
                            shared.inaccessibleFrames.push(primary);
                        }
                    });
                };

                shared.refresh = () => {
                    const rootDocument = rootWindow.document || document;
                    cleanupDocument(rootDocument);
                    shared.inaccessibleFrames = [];
                    attachDocument(rootDocument, []);
                };

                shared.active = true;
                shared.queue = [];
                shared.refresh();
            });
            this.recorderActive = true;
        } catch (error) {
            console.error('Error starting XPath recorder:', error);
        }
    }

    async stopXPathRecorder() {
        if (!this.recorderActive) return;
        const hasSession = await this.hasValidSession();
        if (!hasSession) return;
        try {
            await this.driver.executeScript(function () {
                const rootWindow = (() => {
                    try {
                        return window.top || window;
                    } catch (_) {
                        return window;
                    }
                })();
                const shared = rootWindow.__qaRecorderShared;
                if (!shared) {
                    return;
                }

                const cleanupDocument = doc => {
                    if (!doc) {
                        return;
                    }
                    const state = doc.defaultView?.__qaRecorderState;
                    if (state?.mouseOver && state.attached) {
                        doc.removeEventListener('mouseover', state.mouseOver, true);
                    }
                    if (state?.click && state.attached) {
                        doc.removeEventListener('click', state.click, true);
                    }
                    if (state?.lastEl) {
                        state.lastEl.style.outline = state.lastOutline || '';
                        state.lastEl = null;
                        state.lastOutline = '';
                    }
                    if (state) {
                        state.attached = false;
                        state.mouseOver = null;
                        state.click = null;
                    }

                    const frames = Array.from(doc.querySelectorAll('iframe,frame'));
                    for (const frameEl of frames) {
                        try {
                            const childDoc = frameEl.contentDocument || frameEl.contentWindow?.document;
                            if (childDoc) {
                                cleanupDocument(childDoc);
                            }
                        } catch (_) {}
                    }
                };

                shared.active = false;
                shared.queue = [];
                cleanupDocument(rootWindow.document || document);
            });
        } catch (error) {
            // swallow unexpected alerts so normal steps keep running
            if (error?.name === 'UnexpectedAlertOpenError' || (error?.message || '').includes('unexpected alert open')) {
                try {
                    const alert = await this.driver.switchTo().alert();
                    await alert.dismiss().catch(async () => await alert.accept());
                } catch (_) {
                    // ignore if no alert or dismiss/accept failed
                }
            } else {
                console.error('Error stopping XPath recorder:', error);
            }
        } finally {
            this.recorderActive = false;
        }
    }

    async fetchRecordedXPath() {
        try {
            const result = await this.driver.executeScript(function () {
                const rootWindow = (() => {
                    try {
                        return window.top || window;
                    } catch (_) {
                        return window;
                    }
                })();
                const shared = rootWindow.__qaRecorderShared;
                if (!shared) {
                    return [];
                }
                if (typeof shared.refresh === 'function' && shared.active) {
                    shared.refresh();
                }
                if (shared.queue && shared.queue.length) {
                    return shared.queue.shift();
                }
                return [];
            });
            return result || [];
        } catch (error) {
            console.error('Error fetching recorded XPath:', error);
            return [];
        }
    }

}

module.exports = {
    WebActions,
    activeWebDrivers,
    getLastWebActionsInstance: () => lastWebActionsInstance,
    clearLastWebActionsInstance,
    removeActiveWebDriver,
    quitWithTimeout,
}

