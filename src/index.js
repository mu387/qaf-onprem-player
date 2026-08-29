const { app, BrowserWindow, ipcMain, desktopCapturer, Menu } = require('electron');
app.disableHardwareAcceleration();
const fs = require('fs');
const net = require('net');
const { execSync } = require('child_process');
const path = require('path');
const os = require('os');
const dotenv = require('dotenv');
const {
  nowIso,
  readJsonSafe,
  writeJsonAtomic,
  clearFileSafe,
  normalizeJournal,
  buildCanceledJournal,
  buildInitialJournal,
} = require('./utils/runJournal');
const { createExecutionStateTracker } = require('./utils/executionState');

const envName = process.env.APP_ENV || 'staging';
const appRoot = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
dotenv.config({ path: path.join(appRoot, `.env.${envName}`) });
const disableTlsCertValidation = String(process.env.DISABLE_TLS_CERT_VALIDATION || '').trim() === 'true';
if (disableTlsCertValidation) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  app.commandLine.appendSwitch('ignore-certificate-errors');
}
const queueWorkerConfigPath = () => path.join(app.getPath('userData'), 'queue-worker-config.json');
const runJournalPath = () => path.join(app.getPath('userData'), 'active-run-journal.json');
const RUNNER_PROTOCOL = 'qaf-onprem-runner';

const normalizeStoredApiBaseUrl = value => String(value || '').trim().replace(/\/+$/, '');
const normalizeQueueWorkerProfileKey = value => {
  const normalized = normalizeStoredApiBaseUrl(value).toLowerCase();
  return normalized || 'default';
};
const QUEUE_WORKER_SHARED_KEYS = new Set(['allowRecovery', 'reExecuteOnFail']);
const QUEUE_WORKER_PROFILE_KEYS = new Set(['enabled', 'token', 'apiBaseUrl', 'pollMs', 'useRunnerSession', 'runnerId']);

const { Browser } = require('selenium-webdriver');
const { expressApp } = require('./express');
const { stepLogCall } = require('./utils/stepLog');
const { getStepLogUrl, getUploadVideoUrl } = require('./utils/endpoint');
const { setRuntimeConfig, getRuntimeConfig } = require('./utils/runtimeConfig');
const { LocalQueueWorker } = require('./utils/localQueueWorker');
const { QafOnPremAutomation } = require('../src/ui/automation/index');
const { WebActions, activeWebDrivers, getLastWebActionsInstance, clearLastWebActionsInstance, removeActiveWebDriver } =require('./ui/automation/webActions');
const { generateSeleniumScripts } = require('./utils/seleniumExporter');
const {
  launchBrowser,
  navigate,
  sendKeys,
  sendKey,
  waitForElement,
  waitForText,
  setSecure,
  click,
  select,
  wait,
  exist,
  rightClick,
  doubleClick,
  maxBrowser,
  minBrowser,
  openTab,
  closeTab,
  openWindow,
  closeBrowser,
  validateElement,
  clearInput,
  getElementValue,
  scrollToElement,
  scrollToText,
  selectAll,
  copy,
  paste,
 
  switchToIframe, //Haven't Tested this keyword
  hoverElement, //Haven't Tested this keyword
  digitalSignature,
  alertAccept,
  alertDismiss,
  verifyTextOnAlert,
  alertSetText,
  switchBrowser,
  connectPDF,
  verifyPDFText,
  disconnectPDF,
  deletePDFFile,
  getCookieValue,
  removeCookie,
  dragDrop,
  getDBValue,
  executeSQL
} = require('./utils/keywordFunction');
const {
  //launchMobileDriver,
  //mobileTap,
  //mobileDoubleTap,
  //mobileLongPress,
  //mobileSetInputValue,
  //mobileBack,
  //mobileScrollToText,
  //mobileElementExists,
  //mobileElementNotExists,
  //mobileInputExistsAndValidate,
  //mobileHideKeyboard




//updated by Ayaz
mobileOpenApp,
mobileTap,
mobileDoubleTap,
mobileLongPress,
mobileFill,
mobileBack,
mobileSwipe,

//mobileScrollForward,
//mobileScrollBackward,
mobileScrollToText,
//mobileScrollToElement,
mobileElementExist,
mobileElementNotExist,
mobileElementValidate,
mobileSwitchContext,
mobileHideKeyboard,
mobilePinch,
//mobileCloseApp,
mobileDigitalSignature

} = require('./utils/appiumKeywordFunctionsRouter');
colors = require('colors');

let expressListen = null;
let driver = null;
let currentStep = 0;
let currentRunner = 0;
let isPaused = false;
let testRunnerStepData = null;
let testRunnerStepDataOriginal = null;
let testRunnerData = null;
let isReExecuteFlag = false;
let isServerRunning = false;
let routesRegistered = false;
let lastRunPayload = null;
let highlightEnabled = false;
let executionDelayMs = 500;
const execution = {
  NOT_EXECUTED: 0,
  EXECUTING: 1,
  EXECUTED: 2,
  FAILED: 3,
};
let token = '';
let selectedScreen = null;
let capturedData = null;
let QAFOnPremAutomation = null;
let selectScreenHandlerRegistered = false;
let screenSelected = false;
let lastRunAt = null;
let lastRunStatus = 'idle';
let isAutomationExecuting = false;
let activeRunStartedAt = null;
let activeRunHeartbeatAt = null;
let activeRunWatchdogTimer = null;
let shuttingDown = false;
let recoveryDecisionPending = false;
let pendingRecoveryJournal = null;
let activeCancelPromise = null;
let activeRunId = null;
const RUN_STALE_TIMEOUT_MS = Number(process.env.RUN_STALE_TIMEOUT_MS || 0);

const executionState = createExecutionStateTracker({
  onTransition: ({ from, to, trigger, reason, runId, at }) => {
    console.log(
      `[execution-state] ${from} -> ${to} trigger=${trigger} reason=${reason || '-'} runId=${runId || '-'} at=${at}`,
    );
  },
});

const syncRuntimeFromState = () => {
  const state = executionState.getState();
  const activeStates = new Set(['starting', 'running', 'paused', 'reexecute_prompt', 'canceling']);
  isAutomationExecuting = activeStates.has(state);
  if (state !== 'paused' && state !== 'reexecute_prompt') {
    isPaused = false;
  }
};

const transitionExecutionState = (nextState, { trigger = 'unknown', reason = null } = {}) => {
  const moved = executionState.transition(nextState, {
    trigger,
    reason,
    runId: activeRunId,
  });
  if (!moved) {
    console.log(
      `[execution-state] blocked transition ${executionState.getState()} -> ${nextState} trigger=${trigger} reason=${reason || '-'} runId=${activeRunId || '-'}`,
    );
  }
  syncRuntimeFromState();
  return moved;
};

const forceExecutionState = (nextState, { trigger = 'force', reason = null } = {}) => {
  executionState.forceTransition(nextState, {
    trigger,
    reason,
    runId: activeRunId,
  });
  syncRuntimeFromState();
};

const persistCanceledRunJournal = ({ source = 'unknown', reason = 'canceled' } = {}) => {
  const journal = loadRunJournal();
  const canceled = buildCanceledJournal({
    existing: journal,
    source,
    reason,
  });
  persistRunJournal(canceled);
};

const clearRendererExecutionLogs = ({ source = 'unknown', reason = 'canceled' } = {}) => {
  try {
    mainWindow?.webContents?.send('testRunnerStepData', []);
    mainWindow?.webContents?.send('openReExecuteDataModal', null);
    mainWindow?.webContents?.send('clearExecutionLogs', { source, reason });
    mainWindow?.webContents?.send('noActiveTest', { message: 'No active test is running.' });
  } catch (_) {}
};

const cancelActiveQueueExecution = async ({ queueId, queueItemId } = {}) => {
  const workerStatus = localQueueWorker.status();
  const activeQueueId = Number(workerStatus?.currentQueueId || 0);
  const activeQueueItemId = Number(workerStatus?.currentQueueItemId || 0);
  const requestedQueueId = Number(queueId || 0);
  const requestedQueueItemId = Number(queueItemId || 0);
  const journal = pendingRecoveryJournal || loadRunJournal();
  const journalQueueId = Number(journal?.meta?.queue_id || 0);
  const journalQueueItemId = Number(journal?.meta?.queue_item_id || 0);
  const matchesJournalContext =
    requestedQueueId > 0 &&
    journalQueueId === requestedQueueId &&
    (requestedQueueItemId <= 0 || journalQueueItemId === requestedQueueItemId);

  if ((!activeQueueId || !activeQueueItemId) && !matchesJournalContext) {
    return { ok: true, engaged: false, message: 'No active local queue run is engaged.' };
  }

  if (activeQueueId > 0 && requestedQueueId > 0 && activeQueueId !== requestedQueueId) {
    return { ok: true, engaged: false, message: 'Requested queue is not the active local run.' };
  }

  if (activeQueueItemId > 0 && requestedQueueItemId > 0 && activeQueueItemId !== requestedQueueItemId) {
    return { ok: true, engaged: false, message: 'Requested queue item is not the active local run item.' };
  }

  const resolvedQueueId = activeQueueId || journalQueueId || requestedQueueId || null;
  if (!resolvedQueueId) {
    throw new Error('Active queue stop is missing queue context.');
  }

  await requestRunCancel({
    source: 'queue_cancel_active',
    reason: 'queue_cancelled_by_request',
    clearRecoveryJournal: true,
  });

  await localQueueWorker.request('post', `/execution-queue/${Number(resolvedQueueId)}/cancel`, {});

  localQueueWorker.clearActiveExecution('queue_cancelled_by_request');
  forceExecutionState('idle', { trigger: 'queue_cancel_active', reason: 'queue_cancelled_by_request' });

  return {
    ok: true,
    engaged: true,
    queue_id: resolvedQueueId,
    queue_item_id: activeQueueItemId || journalQueueItemId || requestedQueueItemId || null,
    message: 'Active local queue run canceled and reset.',
  };
};

const requestRunCancel = async ({
  source = 'unknown',
  reason = 'canceled',
  clearRecoveryJournal = false,
} = {}) => {
  if (activeCancelPromise) {
    return activeCancelPromise;
  }

  activeCancelPromise = (async () => {
    executionState.requestCancel({ trigger: source, reason, runId: activeRunId });
    syncRuntimeFromState();
    lastRunAt = new Date().toISOString();
    lastRunStatus = 'canceled';

    try {
      QAFOnPremAutomation?.requestCancel?.(reason);
    } catch (_) {}

    try {
      await QAFOnPremAutomation?.pauseExecution?.();
    } catch (_) {}

    // Cancellation should always force recorder stop, even when run exits early.
    try {
      mainWindow?.webContents?.send('stopScreenRecording');
    } catch (_) {}

    try {
      await QAFOnPremAutomation?.destorySession?.();
    } catch (_) {}

    QAFOnPremAutomation = null;
    activeRunStartedAt = null;
    activeRunHeartbeatAt = null;
    stopActiveRunWatchdog();
    clearRendererExecutionLogs({ source, reason });

    updateRunJournalProgress({
      reason,
      is_paused: true,
    });
    persistCanceledRunJournal({ source, reason });
    if (clearRecoveryJournal) {
      clearRunJournal(`cancel:${source}`);
    }

    transitionExecutionState('canceled', { trigger: source, reason });
  })();

  try {
    await activeCancelPromise;
  } finally {
    activeCancelPromise = null;
  }
};

const markRunHeartbeat = () => {
  activeRunHeartbeatAt = Date.now();
};

const startActiveRunWatchdog = () => {
  if (!Number.isFinite(RUN_STALE_TIMEOUT_MS) || RUN_STALE_TIMEOUT_MS <= 0) {
    return;
  }
  stopActiveRunWatchdog();
  const checkEveryMs = Math.max(5000, Math.floor(RUN_STALE_TIMEOUT_MS / 3));
  activeRunWatchdogTimer = setInterval(async () => {
    if (!isAutomationExecuting) return;
    const heartbeat = Number(activeRunHeartbeatAt || 0);
    if (!heartbeat) return;
    const idleForMs = Date.now() - heartbeat;
    if (idleForMs <= RUN_STALE_TIMEOUT_MS) return;

    console.log(`[runner-watchdog] stale run detected after ${idleForMs}ms, forcing cleanup`);
    await requestRunCancel({
      source: 'watchdog',
      reason: 'watchdog_stale_timeout',
    });
  }, checkEveryMs);
};

const stopActiveRunWatchdog = () => {
  if (activeRunWatchdogTimer) {
    clearInterval(activeRunWatchdogTimer);
    activeRunWatchdogTimer = null;
  }
};

const gracefulShutdown = async reason => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[runner] shutdown begin: ${reason || 'unknown'}`);

  try {
    stopActiveRunWatchdog();
    localQueueWorker.stop();
  } catch (_) {}

  try {
    await requestRunCancel({
      source: 'shutdown',
      reason: reason || 'shutdown',
      clearRecoveryJournal: true,
    });
  } catch (_) {}

  try {
    if (expressListen) {
      expressListen.close();
      expressListen = null;
    }
  } catch (_) {}

  try {
    if (QAFOnPremAutomation) {
      await QAFOnPremAutomation.destorySession();
      QAFOnPremAutomation = null;
    }
  } catch (_) {}

  try {
    if (testDriver?.driver) {
      await testDriver.driver.quit();
      testDriver = null;
    }
  } catch (_) {}

  isAutomationExecuting = false;
  activeRunStartedAt = null;
  activeRunHeartbeatAt = null;
  forceExecutionState('idle', { trigger: 'shutdown', reason: reason || 'unknown' });
  console.log(`[runner] shutdown complete: ${reason || 'unknown'}`);
};
const localQueueWorker = new LocalQueueWorker({
  canClaim: () => !isAutomationExecuting && !isPaused && !recoveryDecisionPending && executionState.getState() !== 'canceling',
  shouldSkipFinalize: () => {
    const state = executionState.getState();
    return state === 'canceling' || state === 'canceled';
  },
  onExecute: async (payload, meta) => {
    await executeAutomationPayload(payload, {
      token: meta?.token,
      apiBaseUrl: meta?.apiBaseUrl,
      source: 'queue-local',
      queue: meta?.queue || null,
      item: meta?.item || null,
      claimToken: meta?.claimToken || meta?.claim_token || null,
      reportInterrupted: meta?.reportInterrupted || null,
    });
  },
  onQueueKilled: ({ message }) => {
    console.log('[queue-local] queue killed override', message || '');
    void requestRunCancel({
      source: 'queue_killed',
      reason: message || 'queue_killed',
      clearRecoveryJournal: true,
    });
  },
});
// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
  app.quit();
}
let mainWindow;
let webServerPort = parseInt(process.env.WEBDRIVER_PORT, 10) || 3009;
let pendingProtocolUrl = null;
let rendererBootstrapped = false;
let relaunchInProgress = false;
let lastServerStartFailure = null;

const notifyServerStatus = payload => {
  try {
    mainWindow?.webContents?.send?.('getServerStatus', {
      port: webServerPort,
      ...payload,
    });
  } catch (err) {
    console.log('notifyServerStatus error', err?.message || err);
  }
};

const clearServerStartFailure = () => {
  lastServerStartFailure = null;
};

const setServerStartFailure = (details = {}) => {
  const code = String(details.code || 'SERVER_LISTEN_FAILED').trim() || 'SERVER_LISTEN_FAILED';
  const message = String(details.message || `Runner server could not start on port ${webServerPort}.`).trim();
  lastServerStartFailure = {
    code,
    message,
    port: Number(details.port || webServerPort) || webServerPort,
    failureAt: nowIso(),
  };
  console.log('[runner] server startup failed', lastServerStartFailure);
  notifyServerStatus({
    status: false,
    reason: lastServerStartFailure.message,
    code: lastServerStartFailure.code,
    failureAt: lastServerStartFailure.failureAt,
  });
  return lastServerStartFailure;
};

const extractProtocolFromArgv = (argv = []) =>
  (argv || []).find(arg => String(arg || '').toLowerCase().startsWith(`${RUNNER_PROTOCOL}://`)) || null;

const focusMainWindow = () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
};

const registerRunnerProtocolClient = () => {
  try {
    if (process.defaultApp && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(RUNNER_PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
    } else {
      app.setAsDefaultProtocolClient(RUNNER_PROTOCOL);
    }
  } catch (err) {
    console.log('[protocol] registration failed', err?.message || err);
  }
};

const handleRunnerProtocolUrl = url => {
  if (!url || !String(url).toLowerCase().startsWith(`${RUNNER_PROTOCOL}://`)) return;
  focusMainWindow();
  if (!isServerRunning && mainWindow) {
    startServer(mainWindow, undefined, { forceTakeover: false });
  }
};

const relaunchLatestSingleInstance = reason => {
  if (relaunchInProgress) return;
  relaunchInProgress = true;
  console.log(`[runner] relaunching latest single instance reason=${reason || 'unknown'}`);
  void gracefulShutdown(`relaunch:${reason || 'unknown'}`)
    .catch(() => {})
    .finally(() => {
      try {
        app.relaunch();
      } catch (_) {}
      app.exit(0);
    });
};

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    pendingProtocolUrl = extractProtocolFromArgv(argv) || pendingProtocolUrl;
    relaunchLatestSingleInstance('second-instance');
  });
}

app.on('open-url', (event, url) => {
  event.preventDefault();
  pendingProtocolUrl = url;
  if (mainWindow) {
    handleRunnerProtocolUrl(url);
    pendingProtocolUrl = null;
  }
});

const loadPersistedQueueWorkerConfig = () => {
  try {
    const file = queueWorkerConfigPath();
    if (!fs.existsSync(file)) return {};
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    return typeof parsed === 'object' && parsed ? parsed : {};
  } catch (err) {
    console.log('[queue-local] load persisted config failed', err?.message || err);
    return {};
  }
};

const normalizeQueueWorkerStore = raw => {
  const source = typeof raw === 'object' && raw ? raw : {};
  const shared = {};
  const profiles = {};

  const copyShared = candidate => {
    for (const key of QUEUE_WORKER_SHARED_KEYS) {
      if (Object.prototype.hasOwnProperty.call(candidate, key)) {
        shared[key] = candidate[key];
      }
    }
  };

  const normalizeProfile = candidate => {
    const next = {};
    for (const key of QUEUE_WORKER_PROFILE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(candidate, key)) {
        next[key] = candidate[key];
      }
    }
    if (Object.prototype.hasOwnProperty.call(next, 'apiBaseUrl')) {
      next.apiBaseUrl = normalizeStoredApiBaseUrl(next.apiBaseUrl);
    }
    next.useRunnerSession = true;
    return next;
  };

  if (source.version === 2 && typeof source.profiles === 'object' && source.profiles) {
    copyShared(typeof source.shared === 'object' && source.shared ? source.shared : {});
    for (const [profileKey, profileValue] of Object.entries(source.profiles)) {
      if (!profileValue || typeof profileValue !== 'object') continue;
      const normalizedProfile = normalizeProfile(profileValue);
      const normalizedKey = normalizeQueueWorkerProfileKey(normalizedProfile.apiBaseUrl || profileKey);
      if (!normalizedProfile.apiBaseUrl && normalizedKey !== 'default') {
        normalizedProfile.apiBaseUrl = normalizeStoredApiBaseUrl(profileKey);
      }
      profiles[normalizedKey] = normalizedProfile;
    }

    const requestedActiveKey = normalizeQueueWorkerProfileKey(source.activeProfileKey);
    const availableKeys = Object.keys(profiles);
    return {
      version: 2,
      activeProfileKey: profiles[requestedActiveKey] ? requestedActiveKey : (availableKeys[0] || 'default'),
      shared,
      profiles,
    };
  }

  copyShared(source);
  const legacyProfile = normalizeProfile(source);
  if (Object.keys(legacyProfile).length > 0) {
    const legacyKey = normalizeQueueWorkerProfileKey(legacyProfile.apiBaseUrl);
    profiles[legacyKey] = legacyProfile;
    return {
      version: 2,
      activeProfileKey: legacyKey,
      shared,
      profiles,
    };
  }

  return {
    version: 2,
    activeProfileKey: 'default',
    shared,
    profiles,
  };
};

const loadPersistedQueueWorkerStore = () => normalizeQueueWorkerStore(loadPersistedQueueWorkerConfig());

const writePersistedQueueWorkerStore = store => {
  try {
    const file = queueWorkerConfigPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(store, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.log('[queue-local] save persisted config failed', err?.message || err);
    return false;
  }
};

const getPersistedQueueWorkerConfig = preferredApiBaseUrl => {
  const store = loadPersistedQueueWorkerStore();
  const profileKey = preferredApiBaseUrl
    ? normalizeQueueWorkerProfileKey(preferredApiBaseUrl)
    : store.activeProfileKey;
  return {
    ...(store.profiles[profileKey] || {}),
    ...store.shared,
    profileKey,
  };
};

const savePersistedQueueWorkerConfig = (patch, preferredApiBaseUrl) => {
  const store = loadPersistedQueueWorkerStore();
  const sharedPatch = {};
  const profilePatch = {};

  for (const [key, value] of Object.entries(patch || {})) {
    if (QUEUE_WORKER_SHARED_KEYS.has(key)) {
      sharedPatch[key] = value;
    } else if (QUEUE_WORKER_PROFILE_KEYS.has(key)) {
      profilePatch[key] = value;
    }
  }

  if (Object.keys(sharedPatch).length > 0) {
    store.shared = { ...store.shared, ...sharedPatch };
  }

  const profileKey = normalizeQueueWorkerProfileKey(
    Object.prototype.hasOwnProperty.call(profilePatch, 'apiBaseUrl')
      ? profilePatch.apiBaseUrl
      : (preferredApiBaseUrl || store.activeProfileKey)
  );

  if (Object.keys(profilePatch).length > 0) {
    const currentProfile = store.profiles[profileKey] || {};
    const nextProfile = {
      ...currentProfile,
      ...profilePatch,
      useRunnerSession: true,
    };
    if (Object.prototype.hasOwnProperty.call(nextProfile, 'apiBaseUrl')) {
      nextProfile.apiBaseUrl = normalizeStoredApiBaseUrl(nextProfile.apiBaseUrl);
    }
    store.profiles[profileKey] = nextProfile;
    store.activeProfileKey = profileKey;
  }

  if (!store.activeProfileKey) {
    store.activeProfileKey = profileKey;
  }

  return writePersistedQueueWorkerStore(normalizeQueueWorkerStore(store));
};

const getPersistedRecoveryEnabled = () => {
  const persisted = getPersistedQueueWorkerConfig();
  return persisted.allowRecovery === true || persisted.allowRecovery === 'true';
};

const getPersistedReExecuteEnabled = () => {
  const persisted = getPersistedQueueWorkerConfig();
  return persisted.reExecuteOnFail === true || persisted.reExecuteOnFail === 'true';
};

// Keep queue behavior deterministic across app restarts.
isReExecuteFlag = getPersistedReExecuteEnabled();

const loadRunJournal = () => {
  const raw = readJsonSafe(runJournalPath());
  if (!raw) return null;
  const normalized = normalizeJournal(raw);
  if (!normalized) return null;
  try {
    if (JSON.stringify(raw) !== JSON.stringify(normalized)) {
      writeJsonAtomic(runJournalPath(), normalized);
    }
  } catch (_) {}
  return normalized;
};

const persistRunJournal = payload => {
  try {
    writeJsonAtomic(runJournalPath(), payload);
    return true;
  } catch (err) {
    console.log('[recovery] persist journal failed', err?.message || err);
    return false;
  }
};

const clearRunJournal = reason => {
  const cleared = clearFileSafe(runJournalPath());
  if (reason) {
    console.log(`[recovery] journal cleared: ${reason}`);
  }
  if (cleared) {
    try {
      mainWindow?.webContents?.send('recoveryCleared', { reason: reason || 'cleared' });
    } catch (_) {}
  }
  pendingRecoveryJournal = null;
  recoveryDecisionPending = false;
  return cleared;
};

const updateRunJournalProgress = patch => {
  const journal = loadRunJournal();
  if (!journal) return;
  const next = {
    ...journal,
    updated_at: nowIso(),
    progress: {
      ...(journal.progress || {}),
      ...(patch || {}),
    },
  };
  persistRunJournal(next);
};

const maybePromptRecovery = () => {
  const allowRecovery = getPersistedRecoveryEnabled();
  if (!allowRecovery) return;
  const journal = loadRunJournal();
  if (!journal) return;
  if (journal.state && ['completed', 'failed', 'canceled', 'discarded'].includes(journal.state)) {
    clearRunJournal('terminal_journal_cleanup');
    return;
  }
  pendingRecoveryJournal = journal;
  recoveryDecisionPending = true;
  transitionExecutionState('recovery_prompt', {
    trigger: 'recovery',
    reason: 'journal_found',
  });
  try {
    if (
      Array.isArray(journal?.progress?.steps_snapshot) &&
      Number.isFinite(Number(journal?.progress?.current_runner))
    ) {
      mainWindow?.webContents?.send('testRunnerStepData', {
        runner: journal.progress.steps_snapshot,
        currentRunner: Number(journal.progress.current_runner) || 0,
      });
    }
  } catch (_) {}
  try {
    mainWindow?.webContents?.send('recoveryPrompt', journal);
  } catch (_) {}
};

const reconcileStaleQueueRunWithoutRecovery = async () => {
  if (getPersistedRecoveryEnabled()) return { ok: true, skipped: true, reason: 'recovery_enabled' };
  const journal = loadRunJournal();
  if (!journal) return { ok: true, skipped: true, reason: 'no_journal' };
  if (journal.state && ['completed', 'failed', 'canceled', 'discarded'].includes(journal.state)) {
    clearRunJournal('terminal_journal_cleanup');
    return { ok: true, skipped: true, reason: 'terminal_journal' };
  }

  const meta = journal?.meta || {};
  const queueId = Number(meta.queue_id || 0);
  const queueItemId = Number(meta.queue_item_id || 0);
  const claimToken = String(meta.claim_token || '').trim();
  const testSuiteId = Number(meta.test_suite_id || 0);
  const executionId = Number(meta.execution_id || 0);
  if (!queueId || !queueItemId || !claimToken || !testSuiteId || !executionId) {
    clearRunJournal('stale_journal_missing_interrupt_keys');
    return { ok: true, skipped: true, reason: 'missing_interrupt_keys' };
  }

  try {
    await localQueueWorker.reportInterruptedFromJournalMeta(meta, 'runner_restarted_recovery_disabled');
    localQueueWorker.clearActiveExecution('stale_queue_interrupted_after_restart');
    clearRunJournal('stale_queue_interrupted_after_restart');
    forceExecutionState('idle', { trigger: 'recovery', reason: 'stale_queue_interrupted_after_restart' });
    lastRunAt = new Date().toISOString();
    lastRunStatus = 'interrupted';
    activeRunStartedAt = null;
    activeRunHeartbeatAt = null;
    stopActiveRunWatchdog();
    clearRendererExecutionLogs({
      source: 'recovery_disabled_restart',
      reason: 'stale_queue_interrupted_after_restart',
    });
    return { ok: true, reconciled: true };
  } catch (err) {
    console.log('[queue-local] stale recovery-off reconciliation failed', err?.message || err);
    return { ok: false, message: err?.message || 'Failed to reconcile stale interrupted queue run.' };
  }
};
const createWindow = () => {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: true, // like here
      webSecurity: false,
      zoomFactor: 0.9, // keep UI scale consistent across DPI/packaged builds
    },
  });

  // and load the index.html of the app.
  mainWindow.loadFile(path.join(__dirname, 'ui/home.html'));
  mainWindow.webContents.on('did-finish-load', function () {
    if (rendererBootstrapped) {
      relaunchLatestSingleInstance('renderer-refresh');
      return;
    }
    rendererBootstrapped = true;

    startServer(mainWindow, undefined, { forceTakeover: true });

    // DevTools disabled for stability/perf
    desktopCapturer.getSources({ types: ['screen'] }).then(async sources => {
      const screens = sources?.map(({ name, id }) => ({ name, id }));
      mainWindow.webContents.send('setScreenOptions', { screens });
      if (!selectScreenHandlerRegistered) {
        ipcMain.handle('selectScreen', (e, id) => {
          selectedScreen = id || null;
          screenSelected = !!selectedScreen;
        });
        selectScreenHandlerRegistered = true;
      }
    });
    maybePromptRecovery();
  });

  const forceReload = () => {
    try {
      mainWindow?.webContents?.reloadIgnoringCache();
      return true;
    } catch (err) {
      console.log('forceReload failed', err?.message || err);
      return false;
    }
  };

  const toggleDevTools = () => {
    try {
      if (!mainWindow?.webContents) return false;
      if (mainWindow.webContents.isDevToolsOpened()) {
        mainWindow.webContents.closeDevTools();
        return false;
      } else {
        mainWindow.webContents.openDevTools({ mode: 'right' }); // docked vertically on the right
        return true;
      }
    } catch (err) {
      console.log('toggleDevTools failed', err?.message || err);
      return false;
    }
  };

  // Minimal app menu: keep only force reload and devtools toggles.
  const menu = Menu.buildFromTemplate([
  ]);
  Menu.setApplicationMenu(menu);
  // Open the DevTools.

  // ipcMain.handle('gettestRunnerStepData', () => 'pong')

  ipcMain.handle('startServer', (_e, port) => startServer(mainWindow, port));
  ipcMain.handle('stopServer', stopServer);
  ipcMain.handle('freePort', (_e, port) => {
    killPort(parseInt(port, 10));
    return true;
  });
  ipcMain.handle('checkPort', async (_e, port) => {
    const p = parseInt(port, 10);
    if (!p || p < 1 || p > 65535) return null;
    return await isPortAvailable(p);
  });
  ipcMain.handle('exportLastRun', async (_e, language = 'js') => {
    try {
      const runners =
        structuredClone(QAFOnPremAutomation?.testRunnerStepData) ||
        structuredClone(lastRunPayload?.test_runner_steps);
      if (!Array.isArray(runners) || runners.length === 0) {
        return { ok: false, message: 'No recent run data to export.' };
      }
      const outDir = path.join(appRoot, 'exports');
      fs.mkdirSync(outDir, { recursive: true });
      const scripts = generateSeleniumScripts(runners, {
        language,
        testRunner: lastRunPayload?.test_runner,
      });
      if (!scripts.length) {
        return { ok: false, message: 'No scripts generated from the last run.' };
      }
      const files = [];
      scripts.forEach(({ filename, content }) => {
        const filePath = path.join(outDir, filename);
        fs.writeFileSync(filePath, content, 'utf8');
        files.push(filePath);
      });
      return { ok: true, files };
    } catch (err) {
      console.log('exportLastRun failed', err?.message || err);
      return { ok: false, message: err?.message || 'Export failed' };
    }
  });
  ipcMain.handle('setHighlightEnabled', (_e, enabled) => {
    highlightEnabled = !!enabled;
    const wa = getActiveWebActions();
    if (wa?.setHighlightEnabled) {
      wa.setHighlightEnabled(highlightEnabled);
    }
    return highlightEnabled;
  });
  ipcMain.handle('setExecutionSpeed', (_e, mode = 'slow') => {
    executionDelayMs = mode === 'fast' ? 0 : 500;
    if (QAFOnPremAutomation) {
      QAFOnPremAutomation.setExecutionDelay?.(executionDelayMs);
    }
    return { mode, delayMs: executionDelayMs };
  });
  ipcMain.handle('testLaunchBrowser', testLaunchBrowser);
  ipcMain.handle('testExecute', testExecute);
  ipcMain.handle('closeTestBrowser', closeTestBrowser);

  ipcMain.handle('pauseExecution', pauseExecution);
  ipcMain.handle('stopExecution', stopExecution);
  ipcMain.handle('resumeExecution', resumeExecution);

  ipcMain.handle('reExecuteStep', reExecuteStep);
  ipcMain.handle('markStepAsPass', () => QAFOnPremAutomation?.markStepAsPass());
  ipcMain.handle('markStepAsFail', () => QAFOnPremAutomation?.markStepAsFail());
  ipcMain.handle('relaunchRunBrowser', async () => {
    if (!QAFOnPremAutomation) {
      return { ok: false, message: 'No active automation run.' };
    }
    try {
      const result = await QAFOnPremAutomation.relaunchBrowserForRecovery();
      return { ok: true, ...result };
    } catch (err) {
      return { ok: false, message: err?.message || 'Failed to relaunch run browser.' };
    }
  });
  ipcMain.handle('recordXpathStart', recordXpathStart);
  ipcMain.handle('recordXpathStop', recordXpathStop);
  ipcMain.on('uploadVideoLog', (event, payload) => {
    try {
      console.log('[video-upload]', payload);
    } catch (err) {
      console.log('[video-upload] log failed', err?.message || err);
    }
  });
  ipcMain.handle('recordXpathFetch', recordXpathFetch);
  ipcMain.handle('forceReload', () => forceReload());
  ipcMain.handle('toggleDevTools', () => toggleDevTools());
  ipcMain.handle('getRecoverySettings', () => ({
    allowRecovery: getPersistedRecoveryEnabled(),
    reExecuteOnFail: isReExecuteFlag === true,
  }));
  ipcMain.handle('setRecoverySettings', (_e, settings = {}) => {
    const next = {
      allowRecovery: settings.allowRecovery === true || settings.allowRecovery === 'true',
    };
    savePersistedQueueWorkerConfig(next);
    if (!next.allowRecovery) {
      recoveryDecisionPending = false;
      pendingRecoveryJournal = null;
      if (executionState.getState() === 'recovery_prompt') {
        forceExecutionState('idle', { trigger: 'settings', reason: 'recovery_disabled' });
      }
    }
    return { ok: true, ...next };
  });
  ipcMain.handle('decideRecovery', async (_e, decision) => {
    const journal = pendingRecoveryJournal || loadRunJournal();
    if (!journal) {
      recoveryDecisionPending = false;
      return { ok: false, message: 'No recovery journal found.' };
    }
    const action = typeof decision === 'string' ? decision : String(decision?.action || '').trim();
    if (action === 'discard') {
      clearRunJournal('user_discarded_recovery');
      forceExecutionState('idle', { trigger: 'recovery', reason: 'discarded' });
      return { ok: true, action: 'discarded' };
    }
    if (action !== 'resume') {
      return { ok: false, message: 'Unsupported recovery decision.' };
    }
    const requestedRunnerIndex = Number(decision?.runnerIndex);
    const requestedStepIndex = Number(decision?.stepIndex);
    const recoveryState = {
      ...(journal.progress || {}),
    };
    if (Number.isFinite(requestedRunnerIndex) && requestedRunnerIndex >= 0) {
      recoveryState.current_runner = requestedRunnerIndex;
    }
    if (Number.isFinite(requestedStepIndex) && requestedStepIndex >= 0) {
      recoveryState.current_step = requestedStepIndex;
    }
    recoveryDecisionPending = false;
    pendingRecoveryJournal = null;
    try {
      await executeAutomationPayload(journal.payload, {
        token: journal?.payload?.token || '',
        source: 'recovery-resume',
        recoveryState: recoveryState,
        queue: journal?.meta?.queue_id ? { id: journal.meta.queue_id } : null,
        item: {
          id: journal?.meta?.queue_item_id || null,
          attempts: journal?.meta?.attempt_no || null,
          test_suite_id: journal?.meta?.test_suite_id || null,
          test_plan_item_id: journal?.meta?.test_plan_item_id || null,
        },
        claimToken: journal?.meta?.claim_token || null,
        isRecoveryResume: true,
      });
      return { ok: true, action: 'resumed' };
    } catch (err) {
      console.log('[recovery] resume failed', err?.message || err);
      return { ok: false, message: err?.message || 'Recovery resume failed.' };
    }
  });
  ipcMain.on('isReExecute', (event, value) => {
   
    console.log('isReExecute', value)
    isReExecuteFlag = value === true || value === 'true';
    savePersistedQueueWorkerConfig({ reExecuteOnFail: isReExecuteFlag });
    if(QAFOnPremAutomation){
      QAFOnPremAutomation.isReExecuteFlag = isReExecuteFlag;
    }
  });
  ipcMain.handle('dataToReExecuteStep', (event, payload) => QAFOnPremAutomation.dataToReExecuteStep(payload));

  // startServer()
  if (pendingProtocolUrl) {
    handleRunnerProtocolUrl(pendingProtocolUrl);
    pendingProtocolUrl = null;
  }
};
// ipcMain.on('gettestRunnerStepData', (event, testRunnerStepData) => {
//   event.webContents.send('gettestRunnerStepData',testRunnerStepData)
//   console.log(event)
//   console.log(testRunnerStepData)
//  })

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', () => {
  registerRunnerProtocolClient();
  pendingProtocolUrl = extractProtocolFromArgv(process.argv) || pendingProtocolUrl;
  createWindow();
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', async () => {
 

  // if (process.platform !== 'darwin') {
  //   app.quit();
  // }
  app.quit();
});
app.on('before-quit', async () => {
  await gracefulShutdown('before-quit');
});

process.on('SIGINT', () => {
  void gracefulShutdown('SIGINT').finally(() => process.exit(0));
});

process.on('SIGTERM', () => {
  void gracefulShutdown('SIGTERM').finally(() => process.exit(0));
});

process.on('uncaughtException', err => {
  console.error('[runner] uncaughtException', err?.message || err);
  void gracefulShutdown('uncaughtException').finally(() => process.exit(1));
});

process.on('unhandledRejection', reason => {
  console.error('[runner] unhandledRejection', reason);
  void gracefulShutdown('unhandledRejection').finally(() => process.exit(1));
});

const isPortAvailable = port =>
  new Promise(resolve => {
    const server = net.createServer();
    server.once('error', err => {
      if (err && err.code === 'EADDRINUSE') return resolve(false);
      return resolve(false);
    });
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });

const killPort = port => {
  if (!port) return;
  try {
    execSync(
      `for /f "tokens=5" %a in ('netstat -ano ^| findstr :${port}') do taskkill /PID %a /F`,
      { stdio: 'ignore', shell: true },
    );
  } catch (err) {
    // best-effort
  }
};


app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.

const buildRuntimeFromPayload = (input = {}) => {
  const payloadRuntime =
    input?.runtimeConfig && typeof input.runtimeConfig === 'object'
      ? input.runtimeConfig
      : {};
  const apiBaseUrl =
    payloadRuntime.apiBaseUrl ||
    input?.apiBaseUrl ||
    input?.api_base_url ||
    input?.baseUrl ||
    process.env.REACT_APP_API_BASE_URL ||
    '';
  const enableMockUiFallback =
    payloadRuntime.enableMockUiFallback ??
    input?.enableMockUiFallback ??
    null;
  const runtime = {
    ...payloadRuntime,
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
  };
  if (enableMockUiFallback !== null) {
    runtime.enableMockUiFallback = enableMockUiFallback;
  }
  return runtime;
};

const executeAutomationPayload = async (payload, options = {}) => {
  if (isAutomationExecuting) {
    const conflictError = new Error('Runner is already executing another test.');
    conflictError.code = 'RUN_ALREADY_EXECUTING';
    throw conflictError;
  }

  const isRecoveryResume = options?.isRecoveryResume === true;
  if (!isRecoveryResume) {
    // Keep a single-slot journal and start clean for each new execution payload.
    clearRunJournal('new_execution_start');
  }

  activeRunId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  transitionExecutionState('starting', {
    trigger: options?.source || 'manual',
    reason: isRecoveryResume ? 'recovery_resume' : 'new_run',
  });
  activeRunStartedAt = Date.now();
  markRunHeartbeat();
  startActiveRunWatchdog();
  try {
    lastRunStatus = 'running';
    transitionExecutionState('running', {
      trigger: options?.source || 'manual',
      reason: 'execution_started',
    });
    let interruptedReported = false;
    const reportInterruptedIfNeeded = async reason => {
      if (interruptedReported) return;
      if (typeof options?.reportInterrupted !== 'function') return;
      interruptedReported = true;
      try {
        await options.reportInterrupted(reason || 'paused_by_user');
        lastRunStatus = 'interrupted';
        transitionExecutionState('paused', {
          trigger: 'queue_report',
          reason: reason || 'paused_by_user',
        });
        updateRunJournalProgress({
          reason: reason || 'paused_by_user',
          is_paused: true,
        });
        const pausedJournal = loadRunJournal();
        if (pausedJournal) {
          persistRunJournal({
            ...pausedJournal,
            state: 'interrupted',
            updated_at: nowIso(),
          });
        }
      } catch (err) {
        console.log('[queue-local] interrupted report failed', err?.message || err);
      }
    };
    const incomingToken = String(options?.token || payload?.token || '').trim();
    if (incomingToken) {
      token = incomingToken;
    } else {
      token = String(token || '').trim();
    }

    const runtime = buildRuntimeFromPayload({
      ...payload,
      ...(options?.apiBaseUrl ? { apiBaseUrl: options.apiBaseUrl } : {}),
      token,
    });

    setRuntimeConfig({
      ...runtime,
      ...(token ? { token } : {}),
    });
    const queueWorkerPatch = {};
    if (incomingToken) {
      queueWorkerPatch.token = incomingToken;
    }
    if (runtime?.apiBaseUrl) {
      queueWorkerPatch.apiBaseUrl = runtime.apiBaseUrl;
    }
    if (Object.keys(queueWorkerPatch).length) {
      localQueueWorker.configure(queueWorkerPatch);
    }

    console.log(`[run] source=${options?.source || 'manual'}`);
    console.log('[run] runtimeConfig', getRuntimeConfig());
    console.log('[run] stepLogUrl', getStepLogUrl());
    console.log('[run] uploadVideoUrl', getUploadVideoUrl());

    const { test_runner_steps, test_runner } = payload || {};
    const testPlanItemId =
      payload?.test_plan_item_id ||
      payload?.testPlanItemId ||
      test_runner?.test_plan_item_id ||
      test_runner?.testPlanItemId ||
      null;

    if (QAFOnPremAutomation) {
      await QAFOnPremAutomation.destorySession();
    }

    if (!screenSelected) {
      selectedScreen = null;
    }

    if (getPersistedRecoveryEnabled()) {
      const initialJournal = buildInitialJournal({
        payload,
        recoveryEnabled: true,
        meta: {
          source: options?.source || 'manual',
          queue: options?.queue || null,
          item: options?.item || null,
          claimToken: options?.claimToken || null,
        },
      });
      if (isRecoveryResume) {
        initialJournal.state = 'resuming';
        initialJournal.progress = {
          ...(initialJournal.progress || {}),
          ...(options?.recoveryState || {}),
          reason: 'resume_requested',
        };
      }
      persistRunJournal(initialJournal);
    }

    const queueRunReExecuteEnabled =
      options?.source === 'queue-local'
        ? (isReExecuteFlag || getPersistedReExecuteEnabled())
        : isReExecuteFlag;

    QAFOnPremAutomation = new QafOnPremAutomation({
      mainWindow,
      testRunnerStepDataOriginal: structuredClone(test_runner_steps),
      testRunner: test_runner,
      token,
      selectedScreen: selectedScreen,
      isReExecuteFlag: queueRunReExecuteEnabled,
      testPlanItemId: testPlanItemId,
      recoveryState: options?.recoveryState || null,
      onProgress: snapshot => {
        markRunHeartbeat();
        const progressReason = snapshot?.reason;
        if (progressReason === 'step_failed_waiting_user') {
          transitionExecutionState('reexecute_prompt', {
            trigger: 'automation',
            reason: progressReason,
          });
        } else if (progressReason === 'paused' || progressReason === 'run_interrupted') {
          transitionExecutionState('paused', {
            trigger: 'automation',
            reason: progressReason,
          });
        } else if (progressReason === 'run_started' || progressReason === 'resumed' || progressReason === 'step_executing' || progressReason === 'step_executed') {
          transitionExecutionState('running', {
            trigger: 'automation',
            reason: progressReason,
          });
        } else if (progressReason === 'cancel_requested') {
          executionState.requestCancel({
            trigger: 'automation',
            reason: snapshot?.reason || 'cancel_requested',
            runId: activeRunId,
          });
          syncRuntimeFromState();
        }
        if (!getPersistedRecoveryEnabled()) return;
        updateRunJournalProgress({
          ...(snapshot || {}),
        });
        if (snapshot?.reason === 'paused' || snapshot?.reason === 'run_interrupted') {
          void reportInterruptedIfNeeded('paused_by_user');
        }
      },
      onRecoveryPause: async ({ reason }) => {
        interruptedReported = true;
        transitionExecutionState('reexecute_prompt', {
          trigger: 'automation',
          reason: reason || 'waiting_recovery',
        });
        if (typeof options?.reportInterrupted === 'function') {
          await options.reportInterrupted(reason || 'waiting_recovery');
        }
      },
      shouldCancel: () => executionState.getState() === 'canceling',
    });
    QAFOnPremAutomation?.webDriver?.setHighlightEnabled?.(highlightEnabled);
    QAFOnPremAutomation?.setExecutionDelay?.(executionDelayMs);
    lastRunPayload = {
      test_runner_steps: structuredClone(test_runner_steps),
      test_runner: structuredClone(test_runner),
    };

    await QAFOnPremAutomation.runAutomation();
    markRunHeartbeat();
    lastRunAt = new Date().toISOString();
    lastRunStatus = 'completed';
    transitionExecutionState('completed', {
      trigger: options?.source || 'manual',
      reason: 'completed',
    });
    updateRunJournalProgress({
      reason: 'completed',
      is_paused: false,
    });
    const journal = loadRunJournal();
    if (journal) {
      persistRunJournal({
        ...journal,
        state: 'completed',
        updated_at: nowIso(),
      });
    }
  } catch (err) {
    if (err?.code === 'RUN_CANCELED') {
      await requestRunCancel({
        source: options?.source || 'automation',
        reason: err?.message || 'run_canceled',
      });
      return { outcome: 'canceled' };
    }
    lastRunAt = new Date().toISOString();
    lastRunStatus = 'failed';
    transitionExecutionState('failed', {
      trigger: options?.source || 'manual',
      reason: err?.message || 'failed',
    });
    updateRunJournalProgress({
      reason: 'failed',
      is_paused: false,
    });
    const journal = loadRunJournal();
    if (journal) {
      persistRunJournal({
        ...journal,
        state: 'failed',
        updated_at: nowIso(),
      });
    }
    throw err;
  } finally {
    stopActiveRunWatchdog();
    isAutomationExecuting = false;
    if (executionState.getState() === 'completed' || executionState.getState() === 'failed' || executionState.getState() === 'canceled') {
      forceExecutionState('idle', {
        trigger: 'finalize',
        reason: executionState.getState(),
      });
      activeRunId = null;
    }
    activeRunStartedAt = null;
    activeRunHeartbeatAt = null;
  }
};

const startServer = (mainWindow, portOverride, options = {}) => {
  const forceTakeover = options?.forceTakeover === true;
  // desktopCapturer.getSources({ types: ['screen'] }).then(async sources => {

  // for (const source of sources) {
  // console.log('____________', source.name)
  // if (source.name === 'Screen 1') {
  // console.log('in screen one',source.id)
  //   mainWindow.webContents.send('SET_SOURCE', selectedScreen)
  // }
  // }
  // })
  // mainWindow.webContents.send('startScreenRecording', { selectedScreen })
  isServerRunning = expressListen?.address()?.port ? true : false;
  if (isServerRunning) {
    clearServerStartFailure();
    notifyServerStatus({ status: true });
    console.log('server already running on ' + expressListen?.address()?.port);
    return true;
  }
  if (portOverride) {
    webServerPort = parseInt(portOverride, 10) || webServerPort;
  }
  if (forceTakeover) {
    try {
      killPort(webServerPort);
    } catch (_) {}
  }
  if (!routesRegistered) {
    const resolveRunnerKey = () => {
      const envKey = process.env.RUNNER_API_KEY || process.env['RUNNER_API_KEY'];
      return envKey ? String(envKey).trim() : '';
    };

    const isAuthorized = req => {
      const key = resolveRunnerKey();
      if (!key) return true;
      const headerKey = String(req.headers['x-runner-key'] || '').trim();
      const auth = String(req.headers['authorization'] || '');
      const bearer = auth.toLowerCase().startsWith('bearer ')
        ? auth.slice(7).trim()
        : '';
      return headerKey === key || bearer === key;
    };

    const authMiddleware = (req, res, next) => {
      if (isAuthorized(req)) return next();
      return res.status(401).json({ ok: false, message: 'Unauthorized runner request.' });
    };

    expressApp.get('/health', authMiddleware, async (_req, res) => {
      let runnerVersion = 'unknown';
      try {
        const pkg = require('../package.json');
        runnerVersion = pkg?.version || runnerVersion;
      } catch (_) {}
      return res.json({
        ok: true,
        server_up: true,
        startup_failure: lastServerStartFailure,
        screen_selected: screenSelected,
        recording_enabled: screenSelected,
        last_run_at: lastRunAt,
        last_run_status: lastRunStatus,
        runner_version: runnerVersion,
      });
    });

    expressApp.get('/queue/status', authMiddleware, async (_req, res) => {
      const workerStatus = localQueueWorker.status();
      return res.json({
        ok: true,
        worker: {
          ...workerStatus,
          startupFailure: lastServerStartFailure,
          profileKey: normalizeQueueWorkerProfileKey(workerStatus.apiBaseUrl),
        },
      });
    });

    expressApp.post('/queue/cancel-active', authMiddleware, async (req, res) => {
      try {
        const body = req.body || {};
        const result = await cancelActiveQueueExecution({
          queueId: body.queue_id,
          queueItemId: body.queue_item_id,
        });
        return res.json(result);
      } catch (err) {
        return res.status(500).json({ ok: false, message: err?.message || 'Active queue cancellation failed.' });
      }
    });

    expressApp.post('/queue/config', authMiddleware, async (req, res) => {
      try {
        const body = req.body || {};
        const runtimePatch = {};
        if (body.apiBaseUrl) runtimePatch.apiBaseUrl = body.apiBaseUrl;
        if (body.token) runtimePatch.token = body.token;
        if (Object.keys(runtimePatch).length) {
          setRuntimeConfig(runtimePatch);
        }
        const next = {
          enabled: body.enabled,
          token: body.token,
          apiBaseUrl: body.apiBaseUrl,
          pollMs: body.pollMs,
          useRunnerSession: true,
          runnerId: body.runnerId,
          allowRecovery: body.allowRecovery,
        };
        savePersistedQueueWorkerConfig(next, body.apiBaseUrl);
        const status = localQueueWorker.configure(next);
        if (status.enabled && status.hasToken && status.apiBaseUrl) {
          localQueueWorker.start();
        } else {
          localQueueWorker.stop();
        }
        return res.json({ ok: true, worker: localQueueWorker.status() });
      } catch (err) {
        return res.status(500).json({ ok: false, message: err?.message || 'Queue config failed.' });
      }
    });

    expressApp.post('/run', authMiddleware, async (req, res) => {
      console.log('[/run] received', {
        runner: req.body?.test_runner?.id,
        suites: Array.isArray(req.body?.test_runner_steps) ? req.body.test_runner_steps.length : 'n/a',
      });
      try {
        const authHeader = String(req.headers?.authorization || '');
        const bearerToken = authHeader.toLowerCase().startsWith('bearer ')
          ? authHeader.slice(7).trim()
          : '';
        await executeAutomationPayload(req.body, {
          token: req.body?.token || bearerToken || '',
          source: 'manual-run-endpoint',
        });
        res.json({ ok: true, message: 'Run completed.' });
      } catch (err) {
        const errorMessage =
          String(err?.message || '').trim() || 'Run failed.';
        const errorName = String(err?.name || 'Error');
        const errorCode =
          typeof err?.code === 'string' || typeof err?.code === 'number'
            ? err.code
            : null;
        const stack =
          typeof err?.stack === 'string' && err.stack
            ? err.stack.split('\n').slice(0, 8)
            : [];
        const statusCode = errorCode === 'RUN_ALREADY_EXECUTING' ? 409 : 500;
        console.log('[/run] error', {
          name: errorName,
          code: errorCode,
          statusCode,
          message: errorMessage,
          stack,
        });
        res.status(statusCode).json({
          ok: false,
          message: errorMessage,
          run_state: {
            is_executing: isAutomationExecuting,
            started_at: activeRunStartedAt ? new Date(activeRunStartedAt).toISOString() : null,
            heartbeat_at: activeRunHeartbeatAt ? new Date(activeRunHeartbeatAt).toISOString() : null,
            status: lastRunStatus,
            last_run_at: lastRunAt,
          },
          error: {
            name: errorName,
            code: errorCode,
            stack,
          },
        });
      }
    });

    expressApp.post('/run/cancel-active', authMiddleware, async (_req, res) => {
      try {
        const result = await stopExecution();
        return res.json(result);
      } catch (err) {
        return res.status(500).json({ ok: false, message: err?.message || 'Active run cancellation failed.' });
      }
    });
    routesRegistered = true;
  }
  clearServerStartFailure();
  const bindPort = webServerPort;
  expressListen = expressApp.listen(bindPort);
  expressListen.once('error', async err => {
    const bindCode = String(err?.code || 'SERVER_LISTEN_FAILED').trim() || 'SERVER_LISTEN_FAILED';
    isServerRunning = false;
    expressListen = null;
    localQueueWorker.stop();
    const portAvailable = await isPortAvailable(bindPort).catch(() => false);
    const bindMessage =
      bindCode === 'EADDRINUSE' || !portAvailable
        ? `Runner server could not start on port ${bindPort} because the port is already in use. Stop the conflicting process or retry with takeover.`
        : `Runner server could not start on port ${bindPort}: ${String(err?.message || 'Unknown error.')}`;
    setServerStartFailure({
      code: bindCode,
      message: bindMessage,
      port: bindPort,
    });
  });
  expressListen.once('listening', () => {
    clearServerStartFailure();
    isServerRunning = true;
    notifyServerStatus({ status: true });
    console.log('>>>>>>> Server started on port ' + webServerPort);
    const preferredApiBase =
      getRuntimeConfig()?.apiBaseUrl ||
      process.env.REACT_APP_API_BASE_URL ||
      '';
    const persisted = getPersistedQueueWorkerConfig(preferredApiBase);
    isReExecuteFlag = getPersistedReExecuteEnabled();
    const initialEnabled =
      persisted.enabled !== undefined
        ? (persisted.enabled === true || persisted.enabled === 'true')
        : process.env.LOCAL_QUEUE_WORKER_ENABLED === 'true';
    const initialUseRunnerSession = true;
    const initialPollMs = Number(persisted.pollMs || process.env.LOCAL_QUEUE_POLL_MS || 5000);
    const initialToken =
      String(persisted.token || '').trim() ||
      process.env.RUNNER_QUEUE_BEARER_TOKEN ||
      process.env.LOCAL_QUEUE_TOKEN ||
      '';
    const initialApiBase =
      String(persisted.apiBaseUrl || '').trim() ||
      preferredApiBase ||
      '';
    let detectedRunnerVersion = '';
    try {
      const pkg = require('../package.json');
      detectedRunnerVersion = String(pkg?.version || '');
    } catch (_) {}
    const initialRunnerId =
      String(persisted.runnerId || '').trim() ||
      String(process.env.LOCAL_QUEUE_RUNNER_ID || '').trim() ||
      `${os.hostname()}-${process.pid}`;

    localQueueWorker.configure({
      enabled: initialEnabled,
      useRunnerSession: initialUseRunnerSession,
      pollMs: initialPollMs,
      token: initialToken,
      apiBaseUrl: initialApiBase,
      runnerId: initialRunnerId,
      runnerVersion: detectedRunnerVersion,
    });

    const status = localQueueWorker.status();
    if (status.enabled && status.hasToken && status.apiBaseUrl) {
      localQueueWorker.start();
      console.log('[queue-local] worker started');
      void reconcileStaleQueueRunWithoutRecovery();
    } else {
      localQueueWorker.stop();
      console.log('[queue-local] worker idle (missing enabled/token/apiBaseUrl)');
    }
  });
  return true;
};

let testDriver = null;

const MANUAL_EXECUTE_BOOTSTRAP_KEYWORDS = new Set([
  'closebrowser',
  'launchdebugbrowser',
  'debugbrowser',
  'connectbrowser',
  'switchbrowser',
  'switchtoiframe',
  'switchtocontext',
  'switchtopath',
  'switchdom',
  'switchdom1',
  'defaultcontext',
]);

const createManualTestDriver = () => {
  testDriver = new WebActions();
  testDriver.setHighlightEnabled?.(highlightEnabled);
  return testDriver;
};

const ensureManualTestDriver = () => testDriver || createManualTestDriver();

const resolveManualDriverMethod = (driverRef, keywordNameRaw) => {
  if (!driverRef || !keywordNameRaw) {
    return null;
  }

  const exactName = String(keywordNameRaw).trim();
  const aliasMap = {
    debugbrowser: 'launchDebugBrowser',
  };
  const aliasName = aliasMap[exactName.toLowerCase()];
  if (aliasName && typeof driverRef[aliasName] === 'function') {
    return aliasName;
  }
  if (exactName && typeof driverRef[exactName] === 'function') {
    return exactName;
  }

  const normalized = exactName.toLowerCase();
  if (!normalized) {
    return null;
  }

  let current = driverRef;
  while (current && current !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(current)) {
      if (name.toLowerCase() === normalized && typeof driverRef[name] === 'function') {
        return name;
      }
    }
    current = Object.getPrototypeOf(current);
  }

  return null;
};

const getManualSessionActive = async () => {
  try {
    return await testDriver?.hasValidSession?.() || false;
  } catch (_) {
    return false;
  }
};

const testLaunchBrowser = async () => {
  if(testDriver?.driver){
    try { await testDriver.driver.quit(); } catch (_) {}
  }
  try {
    const lastWA = getLastWebActionsInstance?.();
    if (lastWA?.driver) {
      try { await lastWA.driver.quit(); } catch (_) {}
      clearLastWebActionsInstance?.();
    }
  } catch (err) {
    console.log('cleanup previous launch error', err?.message || err);
  }
  testDriver = null;
  const manualDriver = ensureManualTestDriver();
  await manualDriver.launchBrowser({value:Browser.CHROME,implicitWait:1})
  // await testDriver.navigate({value:'https://demoqa.com/buttons'})
  // await testDriver?.quit();
  //  testDriver = await launchBrowser({value:Browser.CHROME,implicitWait:1});
}

const testExecute = async (e, { locator, keyword, value="" }) => {
  mainWindow.webContents.send('testExecuteOutput', {output: ''});

  const keywordName = String(keyword || '').trim();
  const normalizedKeyword = keywordName.toLowerCase();
  const step = { keyword: { name: keywordName }, xPath: locator, value: value }
  let capturedData = null;
  try {
    if (testDriver?.stopXPathRecorder) {
      await testDriver.stopXPathRecorder();
    }
  } catch (_) {}
  try {
    let manualDriver = testDriver;
    if (!manualDriver && MANUAL_EXECUTE_BOOTSTRAP_KEYWORDS.has(normalizedKeyword)) {
      manualDriver = ensureManualTestDriver();
    }

    if (!manualDriver) {
      throw new Error('Manual browser session is not initialized. Launch the browser or run a browser session keyword first.');
    }

    const methodName = resolveManualDriverMethod(manualDriver, keywordName);
    if (!methodName) {
      throw new Error(`Unsupported manual keyword: ${keywordName}`);
    }

    capturedData = await manualDriver[methodName](step)
    const output = capturedData ?? `${keywordName} executed successfully.`;
    const sessionActive = await getManualSessionActive();
    mainWindow.webContents.send('testExecuteOutput', {output});
    return { ok: true, output, sessionActive };
  } catch (error) {
    const output = error?.message || String(error);
    const sessionActive = await getManualSessionActive();
    mainWindow.webContents.send('testExecuteOutput', {output});
    return { ok: false, output, sessionActive };
  }
  // try {
  //   switch (step.keyword.name.toLowerCase()) {

  //     case 'click':  
  //       capturedData = await click(testDriver, step);
  //       capturedData = 'Element Clicked!'
  //     break;

  //     case 'getelementvalue':
  //       capturedData = await getElementValue(testDriver, step);
  //       break;
  //     case 'exist':
  //       capturedData = await exist(testDriver, step);
  //       capturedData = 'Element Found!'
  //       break;
  //     case 'validateelement':
  //       capturedData = await validateElement(testDriver, step);
  //       break;
  //     case 'sendkeys':
  //       await sendKeys(testDriver, step);
  //       capturedData = `${step.value} set to ${step.xPath}`
  //       break;

  //       case 'clearinput':
  //         capturedData = await clearInput(testDriver, step);
  //         break;

  //       case 'selectall':
  //         await selectAll(testDriver, step);
  //         capturedData = `${step.value} set to ${step.xPath}`
  //         break;

  //     case 'scrolltoelement':
  //       await scrollToElement(testDriver, step);
  //       capturedData = `Scrolled to  ${step.xPath}`
  //       break;
  //     case 'scrolltotext':
  //       const scrollToTextScript = `
  //       const text = "${step.value}";
  //       const element = Array.from(document.querySelectorAll('body, body *'))
  //           .find(e => e.textContent.trim() === text);
  //           console.log(element)
  //       if (element) {
  //           element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  //           return true;
  //       } else {
  //           return false;
  //       }`;
  //       await testDriver.executeScript(scrollToTextScript);
  //       break


  //     case 'dragdrop':
  //       capturedData = await dragDrop(testDriver, step);
  //       break;

  //     case 'getcookievalue':
  //       capturedData = await getCookieValue(testDriver, step);
  //       break;

  //     case 'removecookie':
  //       capturedData = await removeCookie(testDriver, step);
  //       break;

  //     case 'connectpdf':
  //       capturedData = await connectPDF(testDriver, step);
  //       break;

  //     case 'verifypdftext':
  //       capturedData = await verifyPDFText(testDriver, step);
  //       break;

  //     case 'disconnectpdf':
  //       capturedData = await disconnectPDF(testDriver, step);
  //       break;

  //     case 'deletepdffile':
  //       capturedData = await deletePDFFile(testDriver, step);
  //       break;

  //     case 'select':
  //       capturedData = await select(testDriver, step);
  //       break;

  //     case 'alertaccept':
  //       capturedData = await alertAccept(testDriver, step);
  //       break;
  //     case 'alertdismiss':
  //       capturedData = await alertDismiss(testDriver, step);
  //       break;

  //     case 'verifytextonalert':
  //       capturedData = await verifyTextOnAlert(testDriver, step);
  //       break;

  //     case 'alertsettext':
  //       capturedData = await alertSetText(testDriver, step);
  //       break;      

  //     case 'switchbrowser':
  //       capturedData = await switchBrowser(testDriver, step);
  //       break;
  //     case 'digitalsignature':
  //       capturedData = await digitalSignature(testDriver, step);
  //       break;
  //     case 'switchtoiframe':
  //       capturedData = await switchToIframe(testDriver, step);
  //       break;
  //     case 'hoverelement':
  //       capturedData = await hoverElement(testDriver, step);
  //       break;

  //     case 'getdbalue':
  //       capturedData = await getDBValue(testDriver, step);
  //       break;
  //     case 'executesql':
  //       capturedData = await executeSQL(testDriver, step);
  //       break;

  //       //mobile keywords
  //     case 'mobileopenapp':
  //       testDriver = await mobileOpenApp(step);
  //       return;

  //     case 'mobiletap':
  //       return await mobileTap(testDriver, step);

  //     case 'mobilefill':
  //       return await mobileFill(testDriver, step);

  //     case 'mobilescrolltotext':
  //       return await mobileScrollToText(testDriver, step);
  //   }
  // } catch (error) {
  //   capturedData = error.message;
  // }
}

const closeTestBrowser = async () => {
  const wa = testDriver || QAFOnPremAutomation?.webDriver || getLastWebActionsInstance?.();
  if (wa?.stopXPathRecorder) {
    try { await wa.stopXPathRecorder(); } catch (err) { console.log('stop recorder error', err); }
  }

  const closeDriver = async driverRef => {
    if (!driverRef) return;
    try {
      await driverRef.quit();
    } catch (err) {
      console.log('closeTestBrowser error', err?.message || err);
    }
  };

  const driversToClose = new Set();
  if (testDriver?.driver) driversToClose.add(testDriver.driver);
  if (QAFOnPremAutomation?.webDriver?.driver) driversToClose.add(QAFOnPremAutomation.webDriver.driver);
  activeWebDrivers.forEach(d => driversToClose.add(d));
  const lastWA = getLastWebActionsInstance?.();
  if (lastWA?.driver) driversToClose.add(lastWA.driver);

  if (driversToClose.size === 0) {
    console.log('closeTestBrowser: no tracked drivers to close; attempting chromedriver kill');
    try {
      execSync('taskkill /IM chromedriver.exe /F /T', { stdio: 'ignore' });
    } catch (err) {}
    return false;
  }

  for (const d of driversToClose) {
    console.log('closeTestBrowser: attempting quit on driver');
    try {
      await closeDriver(d);
    } finally {
      activeWebDrivers.delete(d);
    }
  }
  testDriver = null;
  if (QAFOnPremAutomation?.webDriver) {
    QAFOnPremAutomation.webDriver.driver = null;
  }
  clearLastWebActionsInstance?.();
  return true;
};

const getActiveWebActions = () => {
  if (testDriver) return testDriver;
  if (QAFOnPremAutomation?.webDriver) return QAFOnPremAutomation.webDriver;
  const lastWA = getLastWebActionsInstance?.();
  if (lastWA) return lastWA;
  return null;
};

const recordXpathStart = async () => {
  const wa = getActiveWebActions();
  if (!wa || !wa.driver) {
    console.log('recordXpathStart: no active WebActions driver');
    return false;
  }
  try {
    await wa.startXPathRecorder();
    return true;
  } catch (err) {
    console.log('recordXpathStart error', err?.message || err);
    return false;
  }
};

const recordXpathFetch = async () => {
  const wa = getActiveWebActions();
  if (!wa) {
    console.log('recordXpathFetch: no active WebActions');
    return [];
  }
  try {
    const paths = await wa.fetchRecordedXPath();
    return paths || [];
  } catch (err) {
    console.log('recordXpathFetch error', err?.message || err);
    return [];
  }
};

const recordXpathStop = async () => {
  const wa = getActiveWebActions();
  if (!wa) return false;
  try {
    await wa.stopXPathRecorder();
    return true;
  } catch (err) {
    console.log('recordXpathStop error', err?.message || err);
    return false;
  }
};


const stopServer = () => {
  if (!expressListen) return false;
  localQueueWorker.stop();
  try {
    expressListen.close();
  } catch (err) {
    console.log('stopServer close error', err?.message || err);
  }
  try {
    notifyServerStatus({ status: false });
    mainWindow?.webContents?.send?.('SET_SOURCE', null);
  } catch (err) {
    console.log('stopServer notify error', err?.message || err);
  }
  isServerRunning = false;
  screenSelected = false;
  selectedScreen = null;
  resetAutomationValues();
  clearRunJournal('server_stopped_cleanup');
  console.log('<<<<<<<<<< Server Stopped');
  expressListen = null;
  return true;
};

const resetAutomationValues = () => {
  // driver = null;
  currentStep = 0;
  currentRunner = 0;
  isPaused = false;
  testRunnerStepData = null;
  mainWindow.webContents.send('testRunnerStepData', []);
  capturedData = null;
};

if (false) {
  // LEGACY: Unused execution path kept for reference during validation.
  // This mirrors the old automation engine in src/legacy_automation.js.
const runAutomation = async test_runner_steps => {
  for (let i = currentRunner; i < test_runner_steps.length; i++) {
    console.log(JSON.stringify(test_runner_steps, null, 2));
    if (isPaused) {
      break;
    }
    currentRunner = i;
    mainWindow.webContents.send('startScreenRecording', {
      selectedScreen,
      testRunnerId: testRunnerData.id,
      suiteId: test_runner_steps[currentRunner].test_suite.id,
      token: token,
    });

    const runner = test_runner_steps[i];
    console.log('168---', JSON.stringify(runner, null, 2));
    console.log('\n\n' + 'TEST CASE: ' + (currentRunner + 1));
    for (let j = currentStep; j < runner.steps.length; j++) {
      // console.log(i, j)
      currentStep = j;
      const step = runner.steps[j];
      // console.log(step.keyword.name, step.value)
      // try {
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
      if (step.actual_step) {
        step.execution = execution.EXECUTING;
        mainWindow.webContents.send('testRunnerStepData', {
          runner: test_runner_steps,
          currentRunner,
        });
      }

      if (step.before_step && step.before_step.length > 0) {
        // console.log('in before')//
        for (beforeStep of step.before_step) {
          // console.log(beforeStep)
          try {
            await runStep(beforeStep);
          } catch (error) {
            console.log(error);
          }
        }
      }
      // console.log('actual stepp')
      try {
        await runStep(step);
        await stepLogCall({
          runnerId: testRunnerData.id,
          testSuiteId: runner.test_suite.id,
          stepId: step.id,
          datasetId: step.dataset_id,
          testRunnerSteps: testRunnerStepDataOriginal,
          runnerIndex: currentRunner,
          stepIndex: currentStep,
          token,
        });
      } catch (error) {
        if (isReExecuteFlag) {
          console.log('failed');
          isPaused = true;
          if (step.actual_step || step.parent) {
            console.log('actual step');
            if (step.parent) {
              runner.steps.find(({ id }) => id === step.parent).execution =
                execution.FAILED;
            } else {
              step.execution = execution.FAILED;
            }
            // step.xPath='//*[@id="password"]'
            mainWindow.webContents.send('testRunnerStepData', {
              runner: test_runner_steps,
              currentRunner,
            });
            mainWindow.webContents.send('openReExecuteDataModal', null);
          }
          return;
        }

        await stepLogCall({
          runnerId: testRunnerData.id,
          testSuiteId: runner.test_suite.id,
          stepId: step.id,
          datasetId: step.dataset_id,
          testRunnerSteps: testRunnerStepDataOriginal,
          runnerIndex: currentRunner,
          stepIndex: currentStep,
          error,
          token,
        });
      }

      if (step.after_step && step.after_step.length > 0) {
        // console.log('in before')
        for (afterStep of step.after_step) {
          // console.log(afterStep)
          try {
            await runStep(afterStep);
          } catch (error) {
            console.log(error);
          }
        }
      }
      if (step.actual_step || step.parent) {
        // console.log(step.parent)
        if (step.parent) {
          runner.steps.find(({ id }) => id === step.parent).execution =
            execution.EXECUTED;
        }
        step.execution = execution.EXECUTED;
        mainWindow.webContents.send('testRunnerStepData', {
          runner: test_runner_steps,
          currentRunner,
        });
      }
      if (isPaused) {
        break;
      }
      // } catch (error) {
      //     console.log(error)
      // }
    }
    if (!isPaused) {
      currentStep = 0;
    }
    mainWindow.webContents.send('stopScreenRecording');
  }
  if (!isPaused) {
    resetAutomationValues();
  }
};
const makeConfigStep = test_runner_steps => {
  let x = test_runner_steps.map(runner => {
    if (runner?.test_suite?.configuration) {
      const { configuration_variables } = runner?.test_suite?.configuration;
      const configSteps = [];
      configuration_variables.forEach(({ variable, value }) => {
        if (variable.name.toLowerCase() === 'browser') {
          const step = {
            keyword: { name: 'launchBrowser' },
            value: value.name,
            xPath: null,
            actual_step: true,
            execution: execution.NOT_EXECUTED,
            description: 'Launch Browser',
          };
          configSteps.push(step);
        }
        if (variable.name.toLowerCase() === 'mobile capabilities') {
          const step = {
            keyword: { name: 'launchMobile' },
            value: value.name,
            xPath: null,
            actual_step: true,
            execution: execution.NOT_EXECUTED,
            description: 'Launch Mobile',
          };
          configSteps.push(step);
        }
      });
      runner.steps.unshift(...configSteps);
      console.log(JSON.stringify(runner, null, 2));
      return runner;
    } else {
      return runner;
    }
  });
  return x;
};

const formatBeforeAfterSteps = test_runner_steps => {
  //checks if before or after steps exits then it converts
  //it into array of object of the below format
  // [
  //     {
  //         keyword:{
  //             name:'some name',
  //             value:'some value'
  //         },
  //         value:'some value'
  //     }
  // ]
  let x = test_runner_steps.map(runner => {
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
      const mapStep = (stepProperty,xPath, explicitTargetIndex) => {
        if (!stepProperty || stepProperty.length === 0) {
          return stepProperty;
        }

        const rawEntries = Array.isArray(stepProperty) ? stepProperty : [stepProperty];
        const helperSteps = [];

        const appendHelperToken = token => {
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
            entry.split(';').forEach(appendHelperToken);
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
          const helperParts = String(rawValue || '').split(';');
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
  mainWindow.webContents.send('testRunnerStepData', x);
  return x;
};

const splitGroupedKeywords = test_runner_steps => {
  return test_runner_steps.map(runner => {
    runner.steps = runner.steps.reduce((prev, curr) => {
      const { keyword_combination_names } = curr.keyword;
      if (keyword_combination_names && keyword_combination_names !== '') {
        console.log(keyword_combination_names);
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
};

const runStep = async step => {
  const parseExplicitIndexedStepValue = rawValue => {
    const value = String(rawValue ?? '');
    const match = value.match(/^(\d+)\[\](.*)$/s);
    if (!match) {
      return null;
    }
    return {
      explicitTargetIndex: Number(match[1]),
      value: match[2],
    };
  };

  /**
   * if the step value contains {{u_localVar}} then it will replace the value with the captured data
   */
  if (capturedData != null && step.value.includes('{{u_capture}}')) {
    step.value = step.value.replace('{{u_capture}}', capturedData);
  }
  const parsedIndexedValue = parseExplicitIndexedStepValue(step.value);
  if (parsedIndexedValue) {
    step.value = parsedIndexedValue.value;
    step.__explicitTargetIndex = parsedIndexedValue.explicitTargetIndex;
  }
  console.log(step.keyword.name.toLowerCase().bgGreen)
  console.log(step.value.bgGreen)
  console.log(step.xPath.bgGreen)

  switch (step.keyword.name.toLowerCase()) {
    //for alert test cases only:
    case 'alertaccept':
      return await alertAccept(driver);

    case 'alertdismiss':
      return await alertDismiss(driver);

    case 'alertsettext':
      return await alertSetText(driver, step);

    case 'launchbrowser':
      driver = await launchBrowser(step);
      return;

    case 'launchdebugbrowser':
    case 'debugbrowser': {
      const debugDriver = new WebActions();
      debugDriver.driver = driver || null;
      await debugDriver.launchDebugBrowser(step);
      driver = debugDriver.driver;
      return;
    }

    case 'connectbrowser': {
      const debugDriver = new WebActions();
      debugDriver.driver = driver || null;
      await debugDriver.connectBrowser(step);
      driver = debugDriver.driver;
      return;
    }

    case 'openwindow':
      return await openWindow(driver, step);

    case 'closebrowser':
      return await closeBrowser(driver, step);

    case 'navigate':
      return await navigate(driver, step);

    case 'sendkeys':
      return await sendKeys(driver, step);

    case 'sendkey':
      return await sendKey(driver, step);

    case 'selectall':
      return await selectAll(driver, step);

    case 'copy':
      return await copy(driver, step);

    case 'paste':
      return await paste(driver, step);

    case 'clearinput':
      return await clearInput(driver, step);

    case 'setsecure':
      return await setSecure(driver, step);

    case 'click':
      return await click(driver, step);

    case 'select':
      return await select(driver, step);

    case 'closetab':
      return await closeTab(driver, step);

    case 'opentab':
      return await openTab(driver, step);

    case 'exist':
      return await exist(driver, step);

    case 'wait':
      return new Promise(resolve => setTimeout(() => resolve(), step.value));

    case 'waitforelement':
      return await waitForElement(driver, step);

    case 'waitfortext':
      return await waitForText(driver, step);

    case 'rightclick':
      return await rightClick(driver, step);

    case 'doubleclick':
      return await doubleClick(driver, step);

    case 'maxbrowser':
      return await maxBrowser(driver);

    case 'minbrowser':
      return await minBrowser(driver);

    case 'switchbrowser':
      return await switchBrowser(driver, step);

    case 'validateelement':
      return await validateElement(driver, step);

    case 'getelementvalue':
      capturedData = await getElementValue(driver, step);
      return;

    case 'scrolltoelement':
      return await scrollToElement(driver, step);

    case 'scrolltotext':
        return await scrollToText(driver, step);

    case 'hoverelement':
      return await hoverElement(driver, step);

    case 'dragdrop':
      return await dragDrop(driver, step);

    case 'verifytextonalert':
      return await verifyTextOnAlert(driver, step);

    case 'switchtoiframe':
      return await switchToIframe(driver, step);

    case 'connectpdf':
      return await connectPDF(driver, step);

    case 'verifypdftext':
      return await verifyPDFText(driver, step);

    case 'disconnectpdf':
      return await disconnectPDF(driver, step);

    case 'deletepdffile':
      return await deletePDFFile(driver, step);

    case 'getcookievalue':
      return await getCookieValue(driver, step);

    case 'removecookie':
      return await removeCookie(driver, step);

    case 'getdbvalue':
      return await getDBValue(driver, step);

    case 'executesql':
      return await executeSQL(driver, step);

    //mobile keywords
    case 'mobileopenapp':
      driver = await mobileOpenApp(step);
      return;

    case 'back':
      return await mobileBack(driver, step);

    case 'mobiletap':
      return await mobileTap(driver, step);

    case 'mobiledoubletap':
      return await mobileDoubleTap(driver, step);

    case 'mobilelongpress':
      return await mobileLongPress(driver, step);

    case 'mobilefill':
      return await mobileFill(driver, step);

    case 'mobilescrolltotext':
      return await mobileScrollToText(driver, step);

    case 'mobilescrollbackward':
      return await mobileScrollBackward(driver, step, false, true);

    case 'mobilescrollforward':
      return await mobileScrollForward(driver, step, true, false);

    case 'mobileelementexist':
      return await mobileElementExist(driver, step);

    case 'mobileinputexistandvalidate':
      return mobileInputExistsAndValidate(driver, step);

    case 'mobileelementnotexist':
      return await mobileElementNotExist(driver, step);

    case 'mobilehidekeyboard':
      return await mobileHideKeyboard(driver, step);

    case 'mobilepinch':
      return await mobilePinch(driver, step);

    case 'mobileswipe':
      return await mobileSwipe(driver, step);

    case 'mobiledigitalsignature':
      return await mobileDigitalSignature(driver, step);

    case 'mobileelementvalidate':
      return await mobileElementValidate(driver, step);

    case 'mobileswitchcontext':
      return await mobileSwitchContext(driver, step);

    default:
      console.log(
        `no keyword matched for ${step.keyword.name.toLowerCase()}`.bgRed,
      );
      break;
  }

};
}

const pauseExecution = () => {
  if (executionState.getState() === 'canceling') {
    return false;
  }
  const hasActiveRunner =
    !!QAFOnPremAutomation &&
    Array.isArray(QAFOnPremAutomation.testRunnerSteps) &&
    QAFOnPremAutomation.testRunnerSteps.length > 0 &&
    !QAFOnPremAutomation.isPaused;
  if (!hasActiveRunner) {
    try {
      mainWindow?.webContents?.send('noActiveTest', { message: 'No active test is running.' });
    } catch (err) {
      console.log('notify no active test failed (ignored)', err?.message || err);
    }
    return false;
  }
  QAFOnPremAutomation.pauseExecution();
  isPaused = true;
  transitionExecutionState('paused', {
    trigger: 'ui',
    reason: 'manual_pause',
  });
  return true;
};

const stopExecution = async () => {
  const workerStatus = localQueueWorker.status();
  const activeQueueId = Number(workerStatus?.currentQueueId || 0);
  const activeQueueItemId = Number(workerStatus?.currentQueueItemId || 0);
  const hasActiveRunner =
    !!QAFOnPremAutomation &&
    Array.isArray(QAFOnPremAutomation.testRunnerSteps) &&
    QAFOnPremAutomation.testRunnerSteps.length > 0;

  if (!hasActiveRunner) {
    try {
      mainWindow?.webContents?.send('noActiveTest', { message: 'No active test is running.' });
    } catch (err) {
      console.log('notify no active test failed (ignored)', err?.message || err);
    }
    return { ok: true, engaged: false, message: 'No active local run is in progress.' };
  }

  if (activeQueueId > 0 || activeQueueItemId > 0) {
    return await cancelActiveQueueExecution({
      queueId: activeQueueId || undefined,
      queueItemId: activeQueueItemId || undefined,
    });
  }

  await requestRunCancel({
    source: 'manual_stop',
    reason: 'manual_stop_requested',
    clearRecoveryJournal: true,
  });
  forceExecutionState('idle', { trigger: 'manual_stop', reason: 'manual_stop_requested' });

  return {
    ok: true,
    engaged: true,
    message: 'Active run canceled and reset.',
  };
};

const resumeExecution = () => {
  if (executionState.getState() === 'canceling') {
    return false;
  }
  QAFOnPremAutomation.resumeExecution();
  isPaused = false;
  transitionExecutionState('running', {
    trigger: 'ui',
    reason: 'manual_resume',
  });
  return true;
};

const reExecuteStep = () => {
  if (executionState.getState() === 'canceling') {
    return false;
  }
  QAFOnPremAutomation.reExecuteStep();
  transitionExecutionState('running', {
    trigger: 'ui',
    reason: 'reexecute_step',
  });
  return true;
};
