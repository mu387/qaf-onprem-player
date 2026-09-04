const { StepStatusReporter } = require('../../utils/stepStatusReporter');
const { api } = require('../../utils/api');
const { getSaveCloseUrl } = require('../../utils/endpoint');
const { getRuntimeConfig } = require('../../utils/runtimeConfig');
const { WebActions, removeActiveWebDriver, quitWithTimeout } = require('./webActions');
const { MobileActionsRouter } = require('./mobileActionsRouter');

const resolveStepKeyword = (step) => {
    const candidates = [
        step?.keyword?.name,
        step?.keyword,
        step?.keyword_name,
        step?.keywordName,
    ];
    for (const candidate of candidates) {
        if (candidate == null) {
            continue;
        }
        const text = String(candidate).trim();
        if (text !== '') {
            return candidate;
        }
    }
    return null;
};

const normalizeStepFailureReason = (error) => {
    const message = String(error?.message || '').trim();
    const lower = message.toLowerCase();

    if (!message) {
        return 'Step failed';
    }

    if (lower.includes('multiple elements matched')) {
        return 'Multiple elements matched locator';
    }

    if (lower.includes('element not found') || lower.includes('no such element')) {
        return 'Element not found';
    }

    if (lower.includes('not visible') || lower.includes('element not visible')) {
        return 'Element not visible';
    }

    if (lower.includes('iframe') && lower.includes('not found')) {
        return 'Iframe not found';
    }

    if (lower.includes('unsupported keyword action')) {
        return 'Unsupported helper keyword';
    }

    if (lower.includes('timed out waiting') || lower.includes('timeout')) {
        return 'Wait condition timed out';
    }

    if (lower.includes('invalid webdriver session') || lower.includes('session is not active')) {
        return 'Browser session is not active';
    }

    return message.split('\n')[0].trim() || 'Step failed';
};

const execution = {
    NOT_EXECUTED: 0,
    EXECUTING: 1,
    EXECUTED: 2,
    FAILED: 3,
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
class QafOnPremAutomation {
    testRunnerStepDataOriginal = null;
    testRunnerStepData = null;
    testRunnerSteps = null;
    mainWindow = null;
    testRunner = null;
    token = null;
    currentRunner = 0;
    currentStep = 0;
    isPaused = false;
    loopState = null;

    parseExplicitIndexedStepValue(rawValue) {
        const value = String(rawValue ?? '');
        const match = value.match(/^(\d+)\[\](.*)$/s);
        if (!match) {
            return null;
        }

        return {
            explicitTargetIndex: Number(match[1]),
            value: match[2],
        };
    }

    helperUsesOwnLocator(keywordName, rawValue) {
        const normalizedKeyword = String(keywordName || '').trim().toLowerCase();
        const value = String(rawValue || '');
        const entries = value
            .split('>>')
            .map(part => String(part || '').trim())
            .filter(Boolean)
            .map(part => {
                const separatorIndex = part.indexOf('=');
                return separatorIndex > 0
                    ? part.slice(0, separatorIndex).trim().toLowerCase()
                    : '';
            });
        const hasAnyKey = keys => keys.some(key => entries.includes(key));

        if (normalizedKeyword === 'waitforelement' || normalizedKeyword === 'waitfortext') {
            return hasAnyKey(['target', 'scope', 'xpath']);
        }

        if (normalizedKeyword === 'sendkey') {
            return hasAnyKey(['locator']);
        }

        if (normalizedKeyword === 'switchtoiframe') {
            return value.trim().length > 0;
        }

        return false;
    }

    applyExplicitTargetIndexToHelpers(stepCollection, explicitTargetIndex) {
        if (!Array.isArray(stepCollection) || explicitTargetIndex == null) {
            return;
        }

        stepCollection.forEach(helperStep => {
            if (!helperStep || this.helperUsesOwnLocator(helperStep?.keyword?.name, helperStep?.value)) {
                return;
            }
            helperStep.__explicitTargetIndex = explicitTargetIndex;
        });
    }

    normalizeExplicitIndexedStepValue(step) {
        if (!step || typeof step !== 'object') {
            return;
        }

        const parsed = this.parseExplicitIndexedStepValue(step.value);
        if (!parsed) {
            return;
        }

        step.value = parsed.value;
        step.__explicitTargetIndex = parsed.explicitTargetIndex;
        this.applyExplicitTargetIndexToHelpers(step.before_step, parsed.explicitTargetIndex);
        this.applyExplicitTargetIndexToHelpers(step.after_step, parsed.explicitTargetIndex);
    }

    getStepLoopDirective(step) {
        if (!step || typeof step !== 'object') {
            return null;
        }

        const candidateValues = [
            step.Loop,
            step?.loop?.value,
            step.loop,
            step.loop_value,
            step.loopValue,
            step.loop_directive,
            step.loopDirective,
        ];
        const rawValue = candidateValues.find(value => value !== undefined && value !== null && String(value).trim() !== '');
        if (rawValue === undefined || rawValue === null) {
            return null;
        }

        const text = String(rawValue).trim().replace(/^loop\s*=\s*/i, '').trim();
        const startMatch = text.match(/^:?Start-(.+)$/i);
        if (startMatch) {
            const arg = startMatch[1].trim();
            if (!arg) {
                return null;
            }
            return {
                type: 'start',
                raw: String(rawValue).trim(),
                arg,
                countSource: /^\d+$/.test(arg) ? 'fixed' : 'locator',
            };
        }

        if (/^:?End$/i.test(text)) {
            return {
                type: 'end',
                raw: String(rawValue).trim(),
            };
        }

        return null;
    }

    getHelperLoopDirective(step) {
        const keyword = String(resolveStepKeyword(step) || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        if (keyword !== 'loop') {
            return null;
        }
        return this.getStepLoopDirective({ Loop: step?.value });
    }

    findLoopEndStepIndex(steps, startStepIndex) {
        for (let index = startStepIndex + 1; index < steps.length; index += 1) {
            const directive = this.getStepLoopDirective(steps[index]);
            if (directive?.type === 'start') {
                throw new Error(`Nested loops are not supported. Loop start at step ${index + 1} is inside loop starting at step ${startStepIndex + 1}.`);
            }
            if (directive?.type === 'end') {
                return index;
            }
        }
        throw new Error(`Loop end is missing for loop starting at step ${startStepIndex + 1}.`);
    }

    findHelperLoopEndStepIndex(steps, startStepIndex) {
        for (let index = startStepIndex; index < steps.length; index += 1) {
            const step = steps[index];
            if (index > startStepIndex) {
                const directive = this.getStepLoopDirective(step);
                if (directive?.type === 'start') {
                    throw new Error(`Nested loops are not supported. Loop start at step ${index + 1} is inside loop starting at step ${startStepIndex + 1}.`);
                }
                if (directive?.type === 'end') {
                    return index;
                }
            }

            const helpers = [
                ...(Array.isArray(step?.before_step) ? step.before_step : []),
                ...(Array.isArray(step?.after_step) ? step.after_step : []),
            ];
            for (const helperStep of helpers) {
                const helperDirective = this.getHelperLoopDirective(helperStep);
                if (helperDirective?.type === 'start' && index > startStepIndex) {
                    throw new Error(`Nested loops are not supported. Loop start at step ${index + 1} is inside loop starting at step ${startStepIndex + 1}.`);
                }
                if (helperDirective?.type === 'end') {
                    return index;
                }
            }
        }
        throw new Error(`Loop end is missing for loop starting at step ${startStepIndex + 1}.`);
    }

    async resolveLoopMaxCount(directive) {
        if (directive?.countSource === 'fixed') {
            return Number.parseInt(directive.arg, 10) || 0;
        }

        const locator = String(directive?.arg || '').trim();
        if (!locator || typeof this.webDriver?.countVisibleElements !== 'function') {
            return 0;
        }

        return Number(await this.webDriver.countVisibleElements(locator)) || 0;
    }

    async initializeLoopIfNeeded({ directive, runner, stepIndex, endStepIndex = null }) {
        if (!directive || directive.type !== 'start') {
            return;
        }

        if (this.loopState?.active) {
            if (this.loopState.startStepIndex !== stepIndex) {
                throw new Error(`Nested loops are not supported. Step ${stepIndex + 1} attempted to start a second loop.`);
            }
            return;
        }

        const maxCount = await this.resolveLoopMaxCount(directive);
        this.loopState = {
            active: true,
            startStepIndex: stepIndex,
            endStepIndex: Number.isFinite(endStepIndex) ? endStepIndex : this.findLoopEndStepIndex(runner.steps, stepIndex),
            currentIteration: 1,
            maxCount,
            countSource: directive.countSource,
            countLocator: directive.countSource === 'locator' ? String(directive.arg || '').trim() : null,
        };
        console.log('[automation] loop initialized', this.loopState);
    }

    async handleHelperLoopIfNeeded({ helperStep, phase, runner, stepIndex }) {
        const directive = this.getHelperLoopDirective(helperStep);
        if (!directive) {
            return null;
        }

        if (directive.type === 'start') {
            if (phase !== 'before') {
                throw new Error('Loop Start is only supported in before_step.');
            }
            await this.initializeLoopIfNeeded({
                directive,
                runner,
                stepIndex,
                endStepIndex: this.findHelperLoopEndStepIndex(runner.steps, stepIndex),
            });
            return { type: 'start' };
        }

        if (phase !== 'after') {
            throw new Error('Loop End is only supported in after_step.');
        }

        return {
            type: 'end',
            nextStepIndex: this.handleLoopEndIfNeeded({ directive, stepIndex }),
        };
    }

    handleLoopEndIfNeeded({ directive, stepIndex }) {
        if (!directive || directive.type !== 'end') {
            return null;
        }

        if (!this.loopState?.active) {
            throw new Error(`Loop end at step ${stepIndex + 1} does not have an active loop start.`);
        }

        if (this.loopState.endStepIndex !== stepIndex) {
            throw new Error(`Loop end at step ${stepIndex + 1} does not match the active loop ending at step ${this.loopState.endStepIndex + 1}.`);
        }

        if (this.loopState.currentIteration < this.loopState.maxCount) {
            this.loopState.currentIteration += 1;
            console.log('[automation] loop continuing', {
                currentIteration: this.loopState.currentIteration,
                maxCount: this.loopState.maxCount,
                startStepIndex: this.loopState.startStepIndex,
            });
            return this.loopState.startStepIndex;
        }

        console.log('[automation] loop completed', this.loopState);
        this.loopState = null;
        return stepIndex + 1;
    }
    selectedScreen = null;
    isReExecuteFlag = false;
    webDriver = null;
    mobileDriver = null;
    testRunnerData = null;
    capturedData = null;
    executionDelayMs = 500;
    isDraftRun = false;
    stepStatusReporter = null;
    onProgress = null;
    recoveryState = null;
    onRecoveryPause = null;
    recoveryActionResolver = null;
    pauseResumeResolver = null;
    shouldCancel = null;
    cancelRequested = false;
    cancelReason = null;

    constructor({ testRunnerStepDataOriginal, testRunner, mainWindow, token, selectedScreen, isReExecuteFlag, testPlanItemId, recoveryState = null, onProgress = null, onRecoveryPause = null, shouldCancel = null }) {
        this.testRunnerStepDataOriginal = structuredClone(testRunnerStepDataOriginal);
        this.testRunnerSteps = structuredClone(testRunnerStepDataOriginal);
        this.testRunner = structuredClone(testRunner);
        this.isDraftRun = !this.testRunner?.id;
        this.token = token;
        this.testPlanItemId = testPlanItemId || testRunner?.test_plan_item_id || testRunner?.testPlanItemId || null;
        this.mainWindow = mainWindow;
        if (this.testRunnerSteps) {
            this.testRunnerData = this.testRunner || null;
            this.testRunnerStepData = this.splitGroupedKeywords(
                this.formatBeforeAfterSteps(this.makeConfigStep(this.markLastStep(this.testRunnerSteps))),
            );
        }
        this.webDriver = new WebActions();
        this.mobileDriver = new MobileActionsRouter();
        this.stepStatusReporter = new StepStatusReporter({
            flushIntervalMs: Number(process.env.STEP_STATUS_FLUSH_MS || 300),
            maxBatchSize: Number(process.env.STEP_STATUS_BATCH_SIZE || 25),
            maxInflight: Number(process.env.STEP_STATUS_MAX_INFLIGHT || 2),
        });
        this.selectedScreen = selectedScreen;
        this.isReExecuteFlag = isReExecuteFlag;
        this.onProgress = typeof onProgress === 'function' ? onProgress : null;
        this.onRecoveryPause = typeof onRecoveryPause === 'function' ? onRecoveryPause : null;
        this.recoveryState = recoveryState && typeof recoveryState === 'object' ? recoveryState : null;
        this.shouldCancel = typeof shouldCancel === 'function' ? shouldCancel : null;
        if (recoveryState && typeof recoveryState === 'object') {
            this.applyRecoveryState(recoveryState);
        }
    }

    resolveDriverMethod(driver, keywordNameRaw) {
        if (!driver || !keywordNameRaw) {
            return null;
        }

        const exactName = String(keywordNameRaw).trim();
        const aliasMap = {
            debugbrowser: 'launchDebugBrowser',
        };
        const aliasName = aliasMap[exactName.toLowerCase()];
        if (aliasName && typeof driver[aliasName] === 'function') {
            return aliasName;
        }
        if (exactName && typeof driver[exactName] === 'function') {
            return exactName;
        }

        const normalized = exactName.toLowerCase();
        if (!normalized) {
            return null;
        }

        const candidateNames = new Set();
        let current = driver;
        while (current && current !== Object.prototype) {
            Object.getOwnPropertyNames(current).forEach((name) => candidateNames.add(name));
            current = Object.getPrototypeOf(current);
        }

        for (const candidateName of candidateNames) {
            if (candidateName.toLowerCase() === normalized && typeof driver[candidateName] === 'function') {
                return candidateName;
            }
        }

        return null;
    }

    isCancellationRequested() {
        return this.cancelRequested || (typeof this.shouldCancel === 'function' && this.shouldCancel() === true);
    }

    throwIfCancellationRequested() {
        if (!this.isCancellationRequested()) return;
        const err = new Error(this.cancelReason || 'Automation run canceled.');
        err.code = 'RUN_CANCELED';
        throw err;
    }

    requestCancel(reason = 'canceled') {
        this.cancelRequested = true;
        this.cancelReason = String(reason || 'canceled');
        this.isPaused = true;
        if (typeof this.recoveryActionResolver === 'function') {
            this.resolveRecoveryAction('cancel');
        }
        if (typeof this.pauseResumeResolver === 'function') {
            this.pauseResumeResolver();
        }
        this.emitProgress('cancel_requested', { reason: this.cancelReason });
    }

    applyRecoveryState(recoveryState = {}) {
        const runnerIndex = Number(recoveryState.current_runner || 0);
        const stepIndex = Number(recoveryState.current_step || 0);
        if (Array.isArray(recoveryState.steps_snapshot)) {
            this.testRunnerSteps = structuredClone(recoveryState.steps_snapshot);
            this.testRunnerStepData = structuredClone(recoveryState.steps_snapshot);
        }
        this.currentRunner = Number.isFinite(runnerIndex) && runnerIndex >= 0 ? runnerIndex : 0;
        this.currentStep = Number.isFinite(stepIndex) && stepIndex >= 0 ? stepIndex : 0;
        this.isPaused = false;
        this.mainWindow.webContents.send('testRunnerStepData', {
            runner: this.testRunnerStepData,
            currentRunner: this.currentRunner,
        });
    }

    emitProgress(reason, extra = {}) {
        if (!this.onProgress) return;
        this.onProgress({
            reason,
            current_runner: this.currentRunner,
            current_step: this.currentStep,
            is_paused: this.isPaused,
            steps_snapshot: this.testRunnerSteps ? structuredClone(this.testRunnerSteps) : null,
            web_session_snapshot: this.webDriver?.getSessionSnapshot?.() || null,
            ...extra,
        });
    }

    waitForRecoveryAction() {
        if (this.isCancellationRequested()) {
            return Promise.resolve('cancel');
        }
        return new Promise(resolve => {
            this.recoveryActionResolver = resolve;
        });
    }

    resolveRecoveryAction(action) {
        if (typeof this.recoveryActionResolver === 'function') {
            const resolver = this.recoveryActionResolver;
            this.recoveryActionResolver = null;
            resolver(action);
        }
    }

    setExecutionDelay(ms) {
        const value = Number(ms);
        this.executionDelayMs = Number.isFinite(value) && value >= 0 ? value : 0;
    }

    async maybeDelay() {
        if (this.executionDelayMs <= 0) return;
        let remaining = this.executionDelayMs;
        while (remaining > 0) {
            this.throwIfCancellationRequested();
            const chunk = Math.min(100, remaining);
            await new Promise(resolve => setTimeout(resolve, chunk));
            remaining -= chunk;
        }
    }

    async destoryDrivers() {
        if (this.webDriver?.driver) {
            try {
                await quitWithTimeout(this.webDriver.driver);
            } catch (error) {
                console.log('web driver quit failed (ignored)', error.message || error);
            } finally {
                removeActiveWebDriver(this.webDriver.driver);
                this.webDriver.driver = null;
            }
        }
        if (this.mobileDriver?.driver && this?.mobileDriver?.driver?.capabilities) {
            try {
                await this.mobileDriver.driver.deleteSession();
            } catch (error) {
                console.log('mobile driver quit failed (ignored)', error.message || error);
            } finally {
                this.mobileDriver.driver = null;
            }
        }
    }
    async destorySession() {
        await this.destoryDrivers();
        await this.stepStatusReporter?.shutdown();
        this.testRunnerStepDataOriginal = null;
        this.testRunnerStepData = null;
        this.testRunnerSteps = null;
        this.mainWindow = null;
        this.testRunner = null;
        this.token = null;
        this.currentRunner = 0;
        this.currentStep = 0;
        this.isPaused = false;
        this.selectedScreen = null;
        this.isReExecuteFlag = false;
        this.webDriver = null;
        this.mobileDriver = null;
        this.stepStatusReporter = null;
        this.testRunnerData = null;
        this.isReExecuteFlag = false;
        this.isDraftRun = false;
        this.capturedData = null;
        this.cancelRequested = false;
        this.cancelReason = null;
    }

    canPersistRunnerLogs() {
        return !!this.testRunnerData?.id && !this.isDraftRun;
    }

    markLastStep(testRunnerSteps) {
        return testRunnerSteps.map(runner => {
            runner.steps = runner.steps.map((step, i) => {
                if (i === runner.steps.length - 1) {
                    return { ...step, lastStep: true };
                }
                return step;
            });
            return runner;
        });
    }

    splitGroupedKeywords(testRunnerSteps) {
        return testRunnerSteps.map(runner => {
            runner.steps = runner.steps.reduce((prev, curr) => {
                const { keyword_combination_names } = curr.keyword;
                if (keyword_combination_names && keyword_combination_names !== '') {
                    const newGroup = keyword_combination_names
                        .split(',')
                        .map((keyword, i) => {
                            return {
                                after_step: curr.after_step,
                                before_step: curr.before_step,
                                description: curr.description,
                                expected_output: curr.expected_output,
                                keyword: { name: keyword },
                                value: curr.value.split('||')[i],
                                xPath: curr.xPath.split('||')[i],
                                dataset_id: curr.dataset_id,
                                ...(i === 0 && { id: curr.id }),
                                ...(i === 0 && { actual_step: true }),
                                ...(i === 0 && { execution: execution.NOT_EXECUTED }),
                                ...(i !== 0 && { parent: curr.id }),
                            };
                        });
                    return [...prev, ...newGroup];
                }
                return [...prev, curr];
            }, []);
            return runner;
        });
    }

    formatBeforeAfterSteps(testRunnerSteps) {
        let x = testRunnerSteps.map(runner => {
            runner.steps = runner.steps.map(step => {
                const helperUsesOwnLocator = (keywordName, rawValue) => {
                    const normalizedKeyword = String(keywordName || '').trim().toLowerCase();
                    const value = String(rawValue || '');
                    const entries = value
                        .split('>>')
                        .map(part => String(part || '').trim())
                        .filter(Boolean)
                        .map(part => {
                            const separatorIndex = part.indexOf('=');
                            return separatorIndex > 0
                                ? part.slice(0, separatorIndex).trim().toLowerCase()
                                : '';
                        });
                    const hasAnyKey = keys => keys.some(key => entries.includes(key));

                    if (normalizedKeyword === 'waitforelement' || normalizedKeyword === 'waitfortext') {
                        return hasAnyKey(['target', 'scope', 'xpath']);
                    }

                    if (normalizedKeyword === 'sendkey') {
                        return hasAnyKey(['locator']);
                    }

                    if (normalizedKeyword === 'switchtoiframe') {
                        return value.trim().length > 0;
                    }

                    return false;
                };
                const mapStep = (stepProperty, xPath, explicitTargetIndex) => {
                    if (!stepProperty || stepProperty.length === 0) {
                        return stepProperty;
                    }

                    const rawEntries = Array.isArray(stepProperty) ? stepProperty : [stepProperty];
                    const helperSteps = [];

                    const appendHelperToken = (token) => {
                        const trimmedToken = String(token || '').trim();
                        if (!trimmedToken) {
                            return;
                        }

                        const separatorIndex = trimmedToken.indexOf('=:');
                        if (separatorIndex <= 0) {
                            return;
                        }

                        const name = trimmedToken.slice(0, separatorIndex).trim();
                        const value = trimmedToken.slice(separatorIndex + 2);
                        if (!name) {
                            return;
                        }

                        helperSteps.push({ keyword: { name }, value, xPath });
                    };

                    for (const entry of rawEntries) {
                        if (typeof entry === 'string') {
                            splitTopLevelSegments(entry, ';').forEach(appendHelperToken);
                            continue;
                        }

                        if (!entry || typeof entry !== 'object') {
                            continue;
                        }

                        const pair = Object.entries(entry)[0];
                        if (!pair) {
                            continue;
                        }

                        const [name, rawValue] = pair;
                        const helperParts = splitTopLevelSegments(rawValue, ';');
                        const firstValue = helperParts.shift()?.trim() ?? '';
                        const mappedStep = { keyword: { name }, value: firstValue, xPath };
                        if (
                            explicitTargetIndex !== undefined
                            && explicitTargetIndex !== null
                            && !helperUsesOwnLocator(name, firstValue)
                        ) {
                            mappedStep.__explicitTargetIndex = explicitTargetIndex;
                        }
                        helperSteps.push(mappedStep);
                        helperParts.forEach(appendHelperToken);
                    }

                    return helperSteps;
                };
                step.before_step = mapStep(step.before_step, step.xPath, step.__explicitTargetIndex);
                step.after_step = mapStep(step.after_step, step.xPath, step.__explicitTargetIndex);
                step.actual_step = true;
                step.execution = execution.NOT_EXECUTED;
                return step;
            });
            return runner;
        });
        this.mainWindow.webContents.send('testRunnerStepData', x);
        return x;
    }

    makeConfigStep(testRunnerSteps) {
        let x = testRunnerSteps.map(runner => {
            const suite = this.getSuite(runner);
            if (suite?.configuration) {
                const { configuration_variables } = suite?.configuration;
                const configSteps = [];
                const overrideStepValue = (keywordName, value) => {
                    const targets = runner.steps.filter(
                        step => step?.keyword?.name?.toLowerCase() === keywordName.toLowerCase(),
                    );
                    if (!targets.length) return false;
                    targets.forEach((step) => {
                        step.value = value;
                    });
                    return true;
                };
                const isBrowserVar = (name) =>
                    typeof name === 'string' && name.toLowerCase().includes('browser');
                const isMobileVar = (name) =>
                    typeof name === 'string' && name.toLowerCase().includes('mobile');
                configuration_variables.forEach(({ variable, value }) => {
                    const variableName = variable?.name ?? '';
                    if (isBrowserVar(variableName)) {
                        const browserValue = value?.name ?? value?.value ?? value;
                        if (overrideStepValue('launchBrowser', browserValue) || overrideStepValue('launchDebugBrowser', browserValue)) {
                            return;
                        }
                        const step = {
                            keyword: { name: 'launchBrowser' },
                            value: browserValue,
                            xPath: null,
                            actual_step: true,
                            execution: execution.NOT_EXECUTED,
                            description: 'Launch Browser',
                        };
                        configSteps.push(step);
                    }
                    if (isMobileVar(variableName)) {
                        const mobileValue = value?.name ?? value?.value ?? value;
                        if (overrideStepValue('launchMobile', mobileValue)) {
                            return;
                        }
                        const step = {
                            keyword: { name: 'launchMobile' },
                            value: mobileValue,
                            xPath: null,
                            actual_step: true,
                            execution: execution.NOT_EXECUTED,
                            description: 'Launch Mobile',
                        };
                        configSteps.push(step);
                    }
                });
                runner.steps.unshift(...configSteps);
                return runner;
            } else {
                return runner;
            }
        });
        return x;
    }

    getSuite(runner) {
        return runner?.test_suite ?? runner?.testSuite ?? null;
    }

    getSuiteId(runner) {
        const suite = this.getSuite(runner);
        return suite?.id ?? suite?.test_suite_id ?? suite?.testSuiteId ?? null;
    }

    
    async saveAndCloseSuite(runner) {
        const runtimeFlag = (getRuntimeConfig()?.enableMockUiFallback === true) || (getRuntimeConfig()?.enableMockUiFallback === 'true');
        const envFlag = (process.env.ENABLE_MOCK_UI_FALLBACK === 'true');
        const allowFallback = runtimeFlag || envFlag;
        if (!allowFallback) {
            return;
        }
        const testPlanItemId = this.testPlanItemId;
        const suiteId = this.getSuiteId(runner);
        if (!testPlanItemId || !this.testRunnerData?.id || !suiteId) {
            console.log('[automation] save/close skipped (missing ids)');
            return;
        }
        try {
            await api.request({
                url: getSaveCloseUrl(),
                method: 'post',
                data: {
                    test_runner_id: this.testRunnerData.id,
                    test_suite_id: suiteId,
                    test_plan_item_id: testPlanItemId,
                },
                token: this.token,
                    runtimeConfig: getRuntimeConfig(),
            });
            console.log('[automation] save/close ok', suiteId);
        } catch (err) {
            const status = err?.response?.status ?? 'unknown';
            console.log('[automation] save/close failed', status);
        }
    }
    async runAutomation() {
        console.log(`[automation] starting runAutomation with ${this.testRunnerSteps?.length || 0} runner(s)`);
        this.throwIfCancellationRequested();
        if (this.recoveryState?.web_session_snapshot) {
            const hasSession = await this.webDriver.hasValidSession();
            if (!hasSession) {
                const reattached = await this.webDriver.tryReconnectSession(this.recoveryState.web_session_snapshot);
                this.emitProgress(reattached ? 'session_reattached' : 'session_reattach_failed');
            }
        }

        while (true) {
            this.throwIfCancellationRequested();
            this.emitProgress('run_started');
            await this.iterateSteps();
            await this.stepStatusReporter?.flushAll({ timeoutMs: 5000 });
            if (!this.isPaused) {
                this.resetAutomationValues();
                console.log('[automation] completed all runners');
                this.emitProgress('run_completed');
                return { outcome: 'completed' };
            }

            // Never enter paused wait if cancellation is already requested.
            this.throwIfCancellationRequested();

            this.emitProgress('run_interrupted');
            await new Promise(resolve => {
                this.pauseResumeResolver = resolve;
            });
            this.pauseResumeResolver = null;
            this.throwIfCancellationRequested();
        }
    }

    async iterateSteps() {
        for (let i = this.currentRunner; i < this.testRunnerSteps.length; i++) {
            this.throwIfCancellationRequested();
            console.log(`[automation] runner index ${i} start`);
            if (this.isPaused) {
                console.log('[automation] paused; breaking runner loop');
                break;
            }
            this.currentRunner = i;
            const startStepIndex = this.currentStep || 0;
            if (this.selectedScreen) {
                const suiteId = this.getSuiteId(this.testRunnerSteps[this.currentRunner]);
                const testRunnerId = this.testRunnerData?.id ?? null;
                this.mainWindow.webContents.send('startScreenRecording', {
                    selectedScreen: this.selectedScreen,
                    testRunnerId,
                    suiteId,
                    token: this.token,
                    runtimeConfig: getRuntimeConfig(),
                });
            }

            const runner = this.testRunnerSteps[i];
            this.loopState = null;
            console.log('\n\n' + 'TEST CASE: ' + (this.currentRunner + 1));

            for (let j = startStepIndex; j < runner.steps.length; j++) {
                this.throwIfCancellationRequested();
                console.log(i, j);
                this.currentStep = j;
                const step = runner.steps[j];
                const isLastRunner = i === this.testRunnerSteps.length - 1;
                const isLastStepInRunner = j === runner.steps.length - 1;
                step.isLastStepInRunner = isLastStepInRunner;
                step.isLastTestCaseStep = isLastRunner && isLastStepInRunner;
                step.isLastRunner = isLastRunner;
                console.log(
                    'step : ' +
                        j +
                        '___Is_Actual____' +
                        (step.actual_step || false) +
                        '__ID___' +
                        step?.id +
                        '___' +
                        step?.description,
                );
                const keywordNameForLog = resolveStepKeyword(step) ?? 'undefined';
                console.log(
                    `[automation] executing step ${j} keyword=${keywordNameForLog} paused=${this.isPaused}`,
                );

                const loopDirective = this.getStepLoopDirective(step);
                if (loopDirective?.type === 'start') {
                    await this.initializeLoopIfNeeded({ directive: loopDirective, runner, stepIndex: j });
                }
                if (loopDirective?.type === 'end') {
                    const nextStepIndex = this.handleLoopEndIfNeeded({ directive: loopDirective, stepIndex: j });
                    if (step.actual_step || step.parent) {
                        if (step.parent) {
                            runner.steps.find(({ id }) => id === step.parent).execution = execution.EXECUTED;
                        }
                        step.execution = execution.EXECUTED;
                        this.mainWindow.webContents.send('testRunnerStepData', {
                            runner: this.testRunnerSteps,
                            currentRunner: this.currentRunner,
                        });
                        this.emitProgress('step_executed', {
                            step_id: step?.id || null,
                            dataset_id: step?.dataset_id || null,
                        });
                    }
                    j = nextStepIndex - 1;
                    continue;
                }

                if (step.actual_step) {
                    step.execution = execution.EXECUTING;
                    this.mainWindow.webContents.send('testRunnerStepData', {
                        runner: this.testRunnerSteps,
                        currentRunner: this.currentRunner,
                    });
                    this.emitProgress('step_executing', {
                        step_id: step?.id || null,
                        dataset_id: step?.dataset_id || null,
                    });
                }

                const previousVisibleOnlyLookup = this.webDriver?.getVisibleOnlyLookup?.() ?? false;
                let afterLoopNextStepIndex = null;
                try {
                    this.normalizeExplicitIndexedStepValue(step);

                    if (step.before_step && step.before_step.length > 0) {
                        const beforeSteps = step.before_step;
                        for (let beforeStepIndex = 0; beforeStepIndex < beforeSteps.length; beforeStepIndex++) {
                            const beforeStep = beforeSteps[beforeStepIndex];
                            beforeStep.isLastTestCaseStep = step.isLastTestCaseStep;
                            try {
                                const loopControlResult = await this.handleHelperLoopIfNeeded({
                                    helperStep: beforeStep,
                                    phase: 'before',
                                    runner,
                                    stepIndex: j,
                                });
                                if (loopControlResult) {
                                    continue;
                                }
                                await this.runStep(beforeStep);
                            } catch (error) {
                                if (error?.code === 'RUN_CANCELED') {
                                    throw error;
                                }
                                console.log(error);
                            }
                        }
                    }

                    try {
                        await this.runStep(step);
                        if (this.canPersistRunnerLogs()) {
                            const suiteId = this.getSuiteId(runner);
                            this.stepStatusReporter?.enqueue({
                                runnerId: this.testRunnerData.id,
                                testSuiteId: suiteId,
                                testPlanItemId: this.testPlanItemId,
                                stepId: step.id,
                                datasetId: step.dataset_id,
                                testRunnerSteps: this.testRunnerStepDataOriginal,
                                runnerIndex: this.currentRunner,
                                stepIndex: this.currentStep,
                                token: this.token,
                            runtimeConfig: getRuntimeConfig(),
                            });
                        }
                    } catch (error) {
                        if (error?.code === 'RUN_CANCELED') {
                            throw error;
                        }
                        console.log('[automation] step error', error);
                        if (this.isReExecuteFlag) {
                            console.log('failed');
                            this.isPaused = true;
                            if (step.actual_step || step.parent) {
                                if (step.parent) {
                                    runner.steps.find(({ id }) => id === step.parent).execution =
                                        execution.FAILED;
                                } else {
                                    step.execution = execution.FAILED;
                                }
                                this.mainWindow.webContents.send('testRunnerStepData', {
                                    runner: this.testRunnerSteps,
                                    currentRunner: this.currentRunner,
                                });
                                this.mainWindow.webContents.send('openReExecuteDataModal', {
                                    step,
                                    failureReason: normalizeStepFailureReason(error),
                                    runnerIndex: this.currentRunner,
                                    stepIndex: this.currentStep,
                                });
                            }
                            this.emitProgress('step_failed_waiting_user', {
                                step_id: step?.id || null,
                                dataset_id: step?.dataset_id || null,
                            });
                            if (this.onRecoveryPause) {
                                try {
                                    await this.onRecoveryPause({
                                        reason: 'waiting_recovery',
                                        runnerIndex: this.currentRunner,
                                        stepIndex: this.currentStep,
                                        stepId: step?.id || null,
                                    });
                                } catch (pauseErr) {
                                    console.log('[automation] recovery pause notify failed', pauseErr?.message || pauseErr);
                                }
                            }
                            const action = await this.waitForRecoveryAction();
                            if (action === 'cancel') {
                                this.throwIfCancellationRequested();
                            }
                            if (action === 'mark_pass' || action === 'mark_fail') {
                                this.isPaused = false;
                                try {
                                    await this.webDriver?.resetFrameContextIfNeeded?.();
                                } catch (resetErr) {
                                    if (resetErr?.code === 'RUN_CANCELED') {
                                        throw resetErr;
                                    }
                                    console.log('[automation] recovery context reset skipped', resetErr?.message || resetErr);
                                }
                                continue;
                            }
                            this.isPaused = false;
                            try {
                                await this.webDriver?.resetFrameContextIfNeeded?.();
                            } catch (resetErr) {
                                if (resetErr?.code === 'RUN_CANCELED') {
                                    throw resetErr;
                                }
                                console.log('[automation] re-execute context reset skipped', resetErr?.message || resetErr);
                            }
                            step.execution = execution.NOT_EXECUTED;
                            this.mainWindow.webContents.send('testRunnerStepData', {
                                runner: this.testRunnerSteps,
                                currentRunner: this.currentRunner,
                            });
                            j -= 1;
                            continue;
                        }

                        if (this.canPersistRunnerLogs()) {
                            const suiteId = this.getSuiteId(runner);
                            this.stepStatusReporter?.enqueue({
                                runnerId: this.testRunnerData.id,
                                testSuiteId: suiteId,
                                testPlanItemId: this.testPlanItemId,
                                stepId: step.id,
                                datasetId: step.dataset_id,
                                testRunnerSteps: this.testRunnerStepDataOriginal,
                                runnerIndex: this.currentRunner,
                                stepIndex: this.currentStep,
                                error,
                                token: this.token,
                            runtimeConfig: getRuntimeConfig(),
                            });
                        }
                    }

                    if (step.after_step && step.after_step.length > 0) {
                        const afterSteps = step.after_step;
                        for (let afterStepindex = 0; afterStepindex < afterSteps.length; afterStepindex++) {
                            const afterStep = afterSteps[afterStepindex];
                            afterStep.isLastTestCaseStep = step.isLastTestCaseStep;
                            try {
                                const loopControlResult = await this.handleHelperLoopIfNeeded({
                                    helperStep: afterStep,
                                    phase: 'after',
                                    runner,
                                    stepIndex: j,
                                });
                                if (loopControlResult) {
                                    afterLoopNextStepIndex = loopControlResult.nextStepIndex;
                                    continue;
                                }
                                await this.runStep(afterStep);
                            } catch (error) {
                                if (error?.code === 'RUN_CANCELED') {
                                    throw error;
                                }
                                console.log(error);
                            }
                        }
                    }
                } finally {
                    this.webDriver?.setVisibleOnlyLookup?.(previousVisibleOnlyLookup);
                }

                try {
                    await this.webDriver?.resetFrameContextIfNeeded?.();
                } catch (error) {
                    if (error?.code === 'RUN_CANCELED') {
                        throw error;
                    }
                    console.log('[automation] frame reset skipped', error?.message || error);
                }

                // teardown only after the final step of the final test case
                const shouldTeardownDrivers =
                    !this.isPaused &&
                    step.actual_step &&
                    // tear down at the end of every test case (runner), not just the final one
                    (step.isLastStepInRunner || step.isLastTestCaseStep || (step.lastStep && isLastRunner));
                if (shouldTeardownDrivers) {
                    try {
                        await this.destoryDrivers();
                    } catch (err) {
                        console.log('driver cleanup failed', err);
                    }
                    this.mainWindow.webContents.send('stopScreenRecording');
                }

                if (step.actual_step || step.parent) {
                    if (step.parent) {
                        runner.steps.find(({ id }) => id === step.parent).execution = execution.EXECUTED;
                    }
                    step.execution = execution.EXECUTED;
                    this.mainWindow.webContents.send('testRunnerStepData', {
                        runner: this.testRunnerSteps,
                        currentRunner: this.currentRunner,
                    });
                    this.emitProgress('step_executed', {
                        step_id: step?.id || null,
                        dataset_id: step?.dataset_id || null,
                    });
                }
                if (Number.isFinite(afterLoopNextStepIndex)) {
                    j = afterLoopNextStepIndex - 1;
                    continue;
                }
                if (this.isPaused) {
                    this.emitProgress('paused');
                    break;
                }
            }

            // Fallback stop recording when the runner ends
            try {
                this.mainWindow.webContents.send('stopScreenRecording');
            } catch (err) {
                console.log('failed to stop recording', err);
            }
            console.log(`[automation] runner index ${i} end`);
            if (!this.isPaused) {
                await this.stepStatusReporter?.flushAll({ timeoutMs: 3000 });

                await this.saveAndCloseSuite(runner);


            }
            // reset step index for next runner unless we paused mid-run
            if (!this.isPaused) {
                this.currentStep = 0;
                this.loopState = null;
            }
        }
    }

    async runStep(step) {
        this.throwIfCancellationRequested();
        await this.maybeDelay();
        this.throwIfCancellationRequested();
        const keywordNameRaw = resolveStepKeyword(step);
        console.log(`[automation] runStep keyword=${keywordNameRaw}`);
        // ensure recorder is not intercepting clicks during normal execution
        if (this.webDriver?.recorderActive && this.webDriver?.stopXPathRecorder) {
            try {
                await this.webDriver.stopXPathRecorder();
            } catch (err) {
                console.log('runStep recorder cleanup failed (ignored)', err?.message || err);
            }
        }
        if (!keywordNameRaw) {
            console.log('[automation] missing keyword for step', step);
            throw new Error('Step keyword is missing.');
        }
        const keywordName = String(keywordNameRaw).toLowerCase();
        const isMobileKeyword = keywordName.startsWith('mobile');
        const targetDriver = isMobileKeyword ? this.mobileDriver : this.webDriver;
        const keywordMethod = this.resolveDriverMethod(targetDriver, keywordNameRaw);
        if (!keywordMethod) {
            throw new Error(`Unsupported keyword action: ${keywordNameRaw}`);
        }
        const requiresWebSession = !isMobileKeyword && !['launchbrowser', 'launchdebugbrowser', 'debugbrowser', 'connectbrowser', 'closebrowser'].includes(keywordName);
        if (requiresWebSession) {
            const ok = await this.webDriver.hasValidSession();
            if (!ok) {
                console.log('[automation] invalid WebDriver session before step');
                throw new Error('WebDriver session is not active. Please launch the browser again.');
            }
        } else {
            const ok = await this.webDriver.hasValidSession();
            if (!ok && keywordName === 'closebrowser') {
                console.log('[automation] closeBrowser skipped: no valid session');
                return;
            }
        }
        console.log(keywordName.bgGreen);
        if (this.capturedData != null && typeof step.value === 'string' && step.value.includes('{{u_capture}}')) {
            step.value = step.value.replace('{{u_capture}}', this.capturedData);
        }
        this.normalizeExplicitIndexedStepValue(step);

        if (keywordName.startsWith('mobile')) {
            await this.mobileDriver[keywordMethod](step);
        } else {
            if (keywordName === 'getelementvalue') {
                this.capturedData = await this.webDriver[keywordMethod](step);
            } else {
                await this.webDriver[keywordMethod](step);
            }
        }
    }

    resetAutomationValues() {
        this.currentStep = 0;
        this.currentRunner = 0;
        this.isPaused = false;
        this.testRunnerStepData = null;
        this.mainWindow.webContents.send('testRunnerStepData', []);
        this.capturedData = null;
        this.loopState = null;
    }

    pauseExecution() {
        if (this.isCancellationRequested()) return;
        if (this.isPaused) return;
        console.log(
            'paused at: \ntest case: ' +
                this.currentRunner +
                '\nstep number: ' +
                this.currentStep,
        );
        this.currentStep++;
        this.isPaused = true;
        console.log(this.isPaused);
        this.emitProgress('paused');
    }
    resumeExecution() {
        if (this.isCancellationRequested()) return;
        console.log('in resume', this.isPaused);
        if (!this.isPaused) return;
        console.log(
            'resume from: \ntest case: ' +
                this.currentRunner +
                '\nstep number: ' +
                this.currentStep,
        );
        this.isPaused = false;
        this.emitProgress('resumed');
        if (typeof this.pauseResumeResolver === 'function') {
            this.pauseResumeResolver();
        }
    }

    reExecuteStep() {
        if (this.isCancellationRequested()) return;
        if (!this.isPaused) return;
        if (this.recoveryActionResolver) {
            this.resolveRecoveryAction('retry');
            return;
        }
        this.isPaused = false;
        this.emitProgress('reexecute_step');
        if (typeof this.pauseResumeResolver === 'function') {
            this.pauseResumeResolver();
        }
    }

    dataToReExecuteStep({ xPath, keyword, value }) {
        const currentStepObj = this.testRunnerStepData[this.currentRunner].steps[this.currentStep];
        const { parent } = currentStepObj;
        const updateStep = (step, idx) => {
            if (xPath) {
                const parts = xPath.split('||');
                step.xPath = parts[idx] || parts[0];
            }
            if (keyword) {
                if (step.keyword && typeof step.keyword === 'object') {
                    step.keyword.name = keyword;
                } else {
                    step.keyword = keyword;
                }
            }
            if (typeof value === 'string') {
                step.value = value;
            }
        };

        if (parent) {
            this.testRunnerStepData[this.currentRunner].steps
                .filter(step => step.id === parent || step.parent === parent)
                .forEach((step, i) => updateStep(step, i));
        } else {
            updateStep(currentStepObj, 0);
        }
        this.mainWindow.webContents.send('testRunnerStepData', {
            runner: this.testRunnerStepData,
            currentRunner: this.currentRunner,
        });
    }

    async markStepAsPass() {
        if (this.isCancellationRequested()) return;
        // ensure driver state is sane before attempting any driver-based actions
        if (this.webDriver && !(await this.webDriver.hasValidSession?.())) {
            console.log('markStepAsPass aborted: no valid WebDriver session');
        }
        const wasPaused = this.isPaused;
        const runner = this.testRunnerStepData?.[this.currentRunner];
        const step = runner?.steps?.[this.currentStep];
        if (!runner || !step) return;

        const isLastRunner = this.currentRunner === (this.testRunnerSteps?.length || 0) - 1;
        const isLastStepInRunner = this.currentStep === (runner?.steps?.length || 0) - 1;
        const isFinalStep = step.isLastTestCaseStep || (isLastRunner && isLastStepInRunner);

        const runtimeFlag = (getRuntimeConfig()?.enableMockUiFallback === true) || (getRuntimeConfig()?.enableMockUiFallback === 'true');
        const envFlag = (process.env.ENABLE_MOCK_UI_FALLBACK === 'true');
        const allowFallback = runtimeFlag || envFlag;
        const stepsForLog = allowFallback ? this.testRunnerStepData : this.testRunnerStepDataOriginal;

        const stepIdForLog = step.id ?? step.parent;
        const datasetIdForLog = step.dataset_id ?? runner?.steps?.find(({ id }) => id === step.parent)?.dataset_id;
        const shouldLog = !!stepIdForLog || (allowFallback && this.currentStep !== null && this.currentStep !== undefined);
        if (shouldLog && this.canPersistRunnerLogs()) {
            try {
                await this.stepStatusReporter?.flushImmediate({
                    runnerId: this.testRunnerData?.id,
                    testSuiteId: this.getSuiteId(runner),
                    testPlanItemId: this.testPlanItemId,
                    stepId: stepIdForLog,
                    datasetId: datasetIdForLog,
                    testRunnerSteps: stepsForLog,
                    runnerIndex: this.currentRunner,
                        stepIndex: this.currentStep,
                    token: this.token,
                    runtimeConfig: getRuntimeConfig(),
                });
            } catch (err) {
                console.log('step pass log call failed', err);
            }
        }

        if (step.parent) {
            const parentStep = runner.steps.find(({ id }) => id === step.parent);
            if (parentStep) parentStep.execution = execution.EXECUTED;
        }
        step.execution = execution.EXECUTED;
        this.mainWindow.webContents.send('testRunnerStepData', {
            runner: this.testRunnerStepData,
            currentRunner: this.currentRunner,
        });
        this.emitProgress('step_marked_pass', {
            step_id: stepIdForLog || null,
            dataset_id: datasetIdForLog || null,
        });
        this.mainWindow.webContents.send('openReExecuteDataModal', null);
        if (wasPaused) {
            if (this.recoveryActionResolver) {
                this.isPaused = false;
                this.resolveRecoveryAction('mark_pass');
                return;
            }
            this.isPaused = false;
            if (isFinalStep) {
                try {
                    await this.saveAndCloseSuite(runner);
                } catch (err) {
                    console.log('save/close failed after markStepAsPass', err?.message || err);
                }
                try {
                    await this.destoryDrivers();
                } catch (err) {
                    console.log('driver cleanup failed on markStepAsPass', err);
                }
                try {
                    this.mainWindow.webContents.send('stopScreenRecording');
                } catch (err) {
                    console.log('failed to stop recording on markStepAsPass', err);
                }
                this.resetAutomationValues();
            } else {
                this.currentStep += 1;
                this.runAutomation();
            }
        }
    }

    async markStepAsFail() {
        if (this.isCancellationRequested()) return;
        const wasPaused = this.isPaused;
        const runner = this.testRunnerStepData?.[this.currentRunner];
        const step = runner?.steps?.[this.currentStep];
        if (!runner || !step) return;

        const runtimeFlag = (getRuntimeConfig()?.enableMockUiFallback === true) || (getRuntimeConfig()?.enableMockUiFallback === 'true');
        const envFlag = (process.env.ENABLE_MOCK_UI_FALLBACK === 'true');
        const allowFallback = runtimeFlag || envFlag;
        const stepsForLog = allowFallback ? this.testRunnerStepData : this.testRunnerStepDataOriginal;

        const stepIdForLog = step.id ?? step.parent;
        const datasetIdForLog = step.dataset_id ?? runner?.steps?.find(({ id }) => id === step.parent)?.dataset_id;

        if (step.parent) {
            const parentStep = runner.steps.find(({ id }) => id === step.parent);
            if (parentStep) parentStep.execution = execution.FAILED;
        }
        step.execution = execution.FAILED;

        this.mainWindow.webContents.send('testRunnerStepData', {
            runner: this.testRunnerStepData,
            currentRunner: this.currentRunner,
        });

        if ((stepIdForLog || (allowFallback && this.currentStep !== null && this.currentStep !== undefined)) && this.canPersistRunnerLogs()) {
            try {
                await this.stepStatusReporter?.flushImmediate({
                    runnerId: this.testRunnerData?.id,
                    testSuiteId: this.getSuiteId(runner),
                    testPlanItemId: this.testPlanItemId,
                    stepId: stepIdForLog,
                    datasetId: datasetIdForLog,
                    testRunnerSteps: stepsForLog,
                    runnerIndex: this.currentRunner,
                    stepIndex: this.currentStep,
                    error: new Error('Marked as failed by user'),
                    token: this.token,
                    runtimeConfig: getRuntimeConfig(),
                });
            } catch (err) {
                console.log('step fail log call failed', err);
            }
        }

        this.emitProgress('step_marked_fail', {
            step_id: stepIdForLog || null,
            dataset_id: datasetIdForLog || null,
        });

        this.mainWindow.webContents.send('openReExecuteDataModal', null);

        if (wasPaused) {
            if (this.recoveryActionResolver) {
                this.isPaused = false;
                this.resolveRecoveryAction('mark_fail');
                return;
            }
            this.isPaused = false;
            this.currentStep += 1;
            this.runAutomation();
        }
    }

    getRecoveryBrowserName() {
        try {
            const runner = this.testRunnerSteps?.[this.currentRunner];
            const launchStep = Array.isArray(runner?.steps)
                ? runner.steps.find(step => String(resolveStepKeyword(step) || '').toLowerCase() === 'launchbrowser')
                : null;
            const value = String(launchStep?.value || '').trim();
            return value || 'chrome';
        } catch (_) {
            return 'chrome';
        }
    }

    async relaunchBrowserForRecovery() {
        this.throwIfCancellationRequested();
        const browserName = this.getRecoveryBrowserName();
        await this.webDriver.launchBrowser({
            value: browserName,
            implicitWait: 10000,
            forceCleanup: true,
        });
        this.emitProgress('recovery_browser_relaunched', { browser: browserName });
        return { browser: browserName };
    }
}

module.exports = {
    QafOnPremAutomation,
};



