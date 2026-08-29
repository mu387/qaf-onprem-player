const execution = {
  NOT_EXECUTED: 0,
  EXECUTING: 1,
  EXECUTED: 2,
  FAILED: 3,
};
const startServerBtn = document.querySelector('#startServer');
const captureXpath = document.querySelector('#captureXpath');

const stopServerBtn = document.querySelector('#stopServer');
const startWinAppServerBtn = document.querySelector('#startWinAppServer');
const stopWinAppServerBtn = document.querySelector('#stopWinAppServer');
const appiumServerToggle = document.querySelector('#appiumServerToggle');
const appiumServerIcon = document.querySelector('#appiumServerIcon');
const appiumServerLabel = document.querySelector('#appiumServerLabel');
const serverText = document.querySelector('#serverText');
// const startSeleniumBtn=document.querySelector('#startSelenium')
const pauseBtn = document.querySelector('#pause');
const stopExecutionBtn = document.querySelector('#stopExecution');
const resumeBtn = document.querySelector('#resume');
let automationRunning = false;

const setSidebarActionVisible = (element, visible) => {
  if (!element) return;
  element.classList.toggle('hidden', !visible);
  element.classList.toggle('d-none', !visible);
};

const setExecutionControlState = state => {
  const mode = String(state || 'idle');
  if (mode === 'running') {
    setSidebarActionVisible(pauseBtn, true);
    setSidebarActionVisible(stopExecutionBtn, true);
    setSidebarActionVisible(resumeBtn, false);
    return;
  }

  if (mode === 'paused') {
    setSidebarActionVisible(pauseBtn, false);
    setSidebarActionVisible(stopExecutionBtn, true);
    setSidebarActionVisible(resumeBtn, true);
    return;
  }

  if (mode === 'decision') {
    setSidebarActionVisible(pauseBtn, false);
    setSidebarActionVisible(stopExecutionBtn, true);
    setSidebarActionVisible(resumeBtn, false);
    return;
  }

  setSidebarActionVisible(pauseBtn, false);
  setSidebarActionVisible(stopExecutionBtn, false);
  setSidebarActionVisible(resumeBtn, false);
};
// Disable in-app control of Appium/WinAppDriver; they should be run externally.
const DEVICE_SERVER_CONTROL_DISABLED = true;
const reExecuteCheckbox = document.querySelector('#reExecute');
const reExecuteModalXpath = document.querySelector('#reExecuteModalXpath');
const reExecuteModalKeyword = document.querySelector('#reExecuteModalKeyword');
const reExecuteModalValue = document.querySelector('#reExecuteModalValue');
const reExecuteModalExecuteBtn = document.querySelector('#reExecuteModalExecuteBtn');
const reExecuteModalResetBtn = document.querySelector('#reExecuteModalResetBtn');
const reExecuteModalMarkFailBtn = document.querySelector('#reExecuteModalMarkFailBtn');
const reExecuteModalMarkPassBtn = document.querySelector('#reExecuteModalMarkPassBtn');
const reExecuteModalLaunchBrowserBtn = document.querySelector('#reExecuteModalLaunchBrowserBtn');
const reExecuteModalCancelBtn = document.querySelector('#reExecuteModalCancelBtn');
const reExecStepLabel = document.querySelector('#reExecStepLabel');
const reExecLocatorLabel = document.querySelector('#reExecLocatorLabel');
const reExecDataLabel = document.querySelector('#reExecDataLabel');
const reExecuteFailureReason = document.querySelector('#reExecuteFailureReason');
const forceReloadBtn = document.querySelector('#forceReloadBtn');
const toggleDevToolsBtn = document.querySelector('#toggleDevToolsBtn');
const allowRecoveryToggle = document.querySelector('#allowRecoveryToggle');
const highlightToggle = document.querySelector('#highlightToggle');
const executionSpeedToggle = document.querySelector('#executionSpeedToggle');
const screenDropdown = document.querySelector('#screenDropdown');
const resumeFailedStepBtn = document.querySelector('#resumeFailedStepBtn');

const testKeyword = document.querySelector('#testKeyword');
const testLocator = document.querySelector('#testLocator');
const testExecute = document.querySelector('#testExecute');
const testOutput = document.querySelector('#testOutput');
const testValue = document.querySelector('#testValue');
const testLaunchBrowser = document.querySelector('#testLaunchBrowser');
const clearLogBtn = document.querySelector('#clearLogBtn');
const tableBody = document.getElementById('myTable').getElementsByTagName('tbody')[0];
const xpathRecorderBtn = captureXpath;
const spyIndicator = document.querySelector('#spyIndicator');
let isXpathRecording = false;
let xpathFetchInterval = null;
let currentAppiumPort = 4723;
let currentWinAppPort = 4725;
let currentWebPort = 3009;

let reExecModalInstance = null;
let currentReExecData = null;
let suppressReExecuteModal = false;
let pendingReExecuteData = null;
let isBrowserLaunched = false;
let hasExecutionRows = false;
let recoveryModalInstance = null;
const recoveryResumeModalEl = document.querySelector('#recoveryResumeModal');
const recoveryResumeBtn = document.querySelector('#recoveryResumeBtn');
const recoveryDiscardBtn = document.querySelector('#recoveryDiscardBtn');
const recoveryQueueIdLabel = document.querySelector('#recoveryQueueIdLabel');
const recoverySuiteLabel = document.querySelector('#recoverySuiteLabel');
const recoveryStepLabel = document.querySelector('#recoveryStepLabel');
const recoveryStepSelect = document.querySelector('#recoveryStepSelect');
let recoverySelectionMode = false;
let selectedRecoveryRunnerIndex = 0;
let selectedRecoveryStepIndex = null;
let lastServerFailureSignature = '';

const resolveStepKeyword = step => {
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
  return '';
};

const setSpyLabel = text => {
  const span = xpathRecorderBtn.querySelector('span');
  if (span) {
    span.innerText = text;
  } else {
    xpathRecorderBtn.innerText = text;
  }
};

const setResumeFailedStepVisible = visible => {
  if (!resumeFailedStepBtn) return;
  resumeFailedStepBtn.classList.toggle('hidden', !visible);
  resumeFailedStepBtn.classList.toggle('d-none', !visible);
};

const refreshResumeFailedStepState = () => {
  const shouldShow = !!pendingReExecuteData && suppressReExecuteModal === true;
  setResumeFailedStepVisible(shouldShow);
};

const reopenPendingReExecuteModal = () => {
  if (!pendingReExecuteData) {
    return;
  }
  suppressReExecuteModal = false;
  currentReExecData = pendingReExecuteData;
  if (reExecStepLabel) {
    reExecStepLabel.textContent = currentReExecData.description || 'N/A';
  }
  if (reExecLocatorLabel) {
    reExecLocatorLabel.textContent = currentReExecData.xPath || 'N/A';
  }
  if (reExecDataLabel) {
    reExecDataLabel.textContent = currentReExecData.value || 'N/A';
  }
  if (reExecuteFailureReason) {
    reExecuteFailureReason.textContent = currentReExecData.failureReason || '';
  }
  if (reExecuteModalXpath) {
    reExecuteModalXpath.value = currentReExecData.xPath || '';
  }
  if (reExecuteModalKeyword) {
    reExecuteModalKeyword.value = currentReExecData.keyword || '';
  }
  if (reExecuteModalValue) {
    reExecuteModalValue.value = currentReExecData.value || '';
  }
  refreshResumeFailedStepState();
  reExecModalInstance?.show();
};

const setAppiumButtons = running => {
  if (running) {
    appiumServerToggle.classList.remove('bg-green-900');
    appiumServerToggle.classList.add('bg-red-900');
    appiumServerIcon.classList.remove('bi-play-fill');
    appiumServerIcon.classList.add('bi-stop-circle');
    appiumServerLabel.textContent = 'Stop Appium Server';
  } else {
    appiumServerToggle.classList.add('bg-green-900');
    appiumServerToggle.classList.remove('bg-red-900');
    appiumServerIcon.classList.add('bi-play-fill');
    appiumServerIcon.classList.remove('bi-stop-circle');
    appiumServerLabel.textContent = 'Start Appium Server';
  }
};

if (DEVICE_SERVER_CONTROL_DISABLED) {
  // Hide Appium/WinAppDriver controls in sidebar
  [appiumServerToggle, startWinAppServerBtn, stopWinAppServerBtn].forEach(el => {
    if (!el) return;
    el.classList.add('hidden', 'd-none');
    el.style.display = 'none';
  });
}

// Selenium server starts automatically in main process on app launch.
[startServerBtn, stopServerBtn].forEach(el => {
  if (!el) return;
  el.classList.add('hidden', 'd-none');
  el.style.display = 'none';
});

express.getReExecuteSettings?.().then(settings => {
  if (reExecuteCheckbox) {
    reExecuteCheckbox.checked = !!settings?.reExecuteOnFail;
  }
  express.isReExecute(!!reExecuteCheckbox?.checked);
}).catch(() => {
  express.isReExecute(!!reExecuteCheckbox?.checked);
});

reExecuteCheckbox.addEventListener('change', () =>
  express.isReExecute(reExecuteCheckbox.checked),
);
express.getRecoverySettings?.().then(settings => {
  if (!allowRecoveryToggle) return;
  allowRecoveryToggle.checked = !!settings?.allowRecovery;
}).catch(() => {});
allowRecoveryToggle?.addEventListener('change', () => {
  express.setRecoverySettings?.({ allowRecovery: !!allowRecoveryToggle.checked });
});
if (highlightToggle) {
  express.setHighlightEnabled?.(highlightToggle.checked);
  highlightToggle.addEventListener('change', () => {
    express.setHighlightEnabled?.(highlightToggle.checked);
  });
}
if (executionSpeedToggle) {
  // default unchecked = slow (500ms delay)
  express.setExecutionSpeed?.(executionSpeedToggle.checked ? 'fast' : 'slow');
  executionSpeedToggle.addEventListener('change', () => {
    express.setExecutionSpeed?.(executionSpeedToggle.checked ? 'fast' : 'slow');
  });
}
captureXpath.addEventListener('click', () => {
  isXpathRecording = !isXpathRecording;
  xpathRecorderBtn.querySelector('span').innerText = isXpathRecording ? 'Stop Spying' : 'Spy Objects';
  if (isXpathRecording) {
    spyIndicator.classList.remove('bg-gray-400');
    spyIndicator.classList.add('animate-pulse', 'bg-red-500');
    express.recordXpathStart().then(success => {
      if (!success) {
        alert('Test browser is not launched.');
        isXpathRecording = false;
        xpathRecorderBtn.querySelector('span').innerText = 'Spy Objects';
        spyIndicator.classList.remove('animate-pulse', 'bg-red-500');
        spyIndicator.classList.add('bg-gray-400');
        return;
      }
      // immediate fetch once to capture the first click quickly
      const fetchOnce = async () => {
        const result = await express.recordXpathFetch();
        if (!isXpathRecording) return;
        if (!result) return;
        const paths = Array.isArray(result) ? result : result.paths;
        if (!paths || paths.length === 0) return;
        // Default to the first captured path to avoid prompt (unsupported in Electron).
        testLocator.value = paths[0];
        const framePaths = Array.isArray(result?.framePaths) ? result.framePaths.filter(Boolean) : [];
        testOutput.value = framePaths.length > 0
          ? `Before Step: switchToIframe=:${framePaths.join('>>')}`
          : 'Context: default';
      };
      fetchOnce();
      xpathFetchInterval = setInterval(fetchOnce, 200);
    });
  } else {
    spyIndicator.classList.remove('animate-pulse', 'bg-red-500');
    spyIndicator.classList.add('bg-gray-400');
    express.recordXpathStop();
    if (xpathFetchInterval) {
      clearInterval(xpathFetchInterval);
      xpathFetchInterval = null;
    }
  }
});

express.recoveryPrompt?.((_event, payload) => {
  if (!recoveryResumeModalEl) return;
  recoveryModalInstance = bootstrap.Modal.getOrCreateInstance
    ? bootstrap.Modal.getOrCreateInstance(recoveryResumeModalEl)
    : new bootstrap.Modal(recoveryResumeModalEl);
  recoverySelectionMode = true;
  selectedRecoveryRunnerIndex = Number(payload?.progress?.current_runner || 0) || 0;
  const snapshotRunner = Array.isArray(payload?.progress?.steps_snapshot)
    ? payload.progress.steps_snapshot[selectedRecoveryRunnerIndex]?.steps || []
    : [];
  selectedRecoveryStepIndex = findDefaultRecoveryStepIndex(
    snapshotRunner,
    Number(payload?.progress?.current_step || 0) || 0,
  );
  if (recoveryQueueIdLabel) {
    const queueId = payload?.meta?.queue_id ?? '-';
    recoveryQueueIdLabel.textContent = `Queue: ${queueId}`;
  }
  if (recoverySuiteLabel) {
    const suiteId = payload?.meta?.test_suite_id ?? '-';
    recoverySuiteLabel.textContent = `Suite: ${suiteId}`;
  }
  if (recoveryStepSelect) {
    recoveryStepSelect.innerHTML = '';
    snapshotRunner.forEach((step, stepIndex) => {
      if (!step?.actual_step) return;
        const opt = document.createElement('option');
        opt.value = String(stepIndex);
        opt.textContent = `${stepIndex + 1}. ${step?.description || 'Step'} (${resolveStepKeyword(step) || 'keyword'})`;
        recoveryStepSelect.appendChild(opt);
      });
    const fallbackIdx = Number(selectedRecoveryStepIndex || 0);
    recoveryStepSelect.value = String(fallbackIdx);
    if (!recoveryStepSelect.value && recoveryStepSelect.options.length > 0) {
      recoveryStepSelect.selectedIndex = 0;
      selectedRecoveryStepIndex = Number(recoveryStepSelect.value) || 0;
    }
  }
  applyRecoveryRowSelection();
  recoveryModalInstance.show();
});

recoveryStepSelect?.addEventListener('change', () => {
  const next = Number(recoveryStepSelect.value);
  if (Number.isFinite(next) && next >= 0) {
    selectedRecoveryStepIndex = next;
    applyRecoveryRowSelection();
  }
});

recoveryResumeBtn?.addEventListener('click', async () => {
  await express.decideRecovery?.({
    action: 'resume',
    runnerIndex: selectedRecoveryRunnerIndex,
    stepIndex: selectedRecoveryStepIndex,
  });
  recoverySelectionMode = false;
  recoveryModalInstance?.hide();
});

recoveryDiscardBtn?.addEventListener('click', async () => {
  await express.decideRecovery?.({ action: 'discard' });
  recoverySelectionMode = false;
  recoveryModalInstance?.hide();
});

express.recoveryCleared?.(() => {
  recoverySelectionMode = false;
  selectedRecoveryStepIndex = null;
  recoveryModalInstance?.hide();
});
let test = false;

$('#startWinAppServer, #stopWinAppServer').on('click', async function () {
  if (DEVICE_SERVER_CONTROL_DISABLED) {
    alert('WinAppDriver control is disabled in the app. Please start/stop it externally.');
    return;
  }
  const method = this.id === 'startWinAppServer' ? 'startWinAppServer' : 'stopWinAppServer';
  const ok = await express[method]();
  if (!ok) {
    alert(method === 'startWinAppServer' ? 'Failed to start WinApp server (port in use?).' : 'WinApp server is not running.');
    return;
  }
  $('#startWinAppServer, #stopWinAppServer').toggle();
});

$(appiumServerToggle).on('click', async function () {
  if (DEVICE_SERVER_CONTROL_DISABLED) {
    alert('Appium server control is disabled in the app. Please start/stop it externally.');
    return;
  }
  const isRunning = appiumServerLabel.textContent.toLowerCase().includes('stop');
  if (isRunning) {
    const ok = await express.stopAppiumServer();
    if (!ok) {
      alert('Appium server is not running.');
      setAppiumButtons(false);
      return;
    }
    setAppiumButtons(false);
    return;
  }
  const ok = await express.startAppiumServer(currentAppiumPort);
  if (!ok) {
    alert('Failed to start Appium server (port in use?).');
    setAppiumButtons(false);
    return;
  }
  setAppiumButtons(true);
});


pauseBtn.addEventListener('click', () => {
  const hasRows = tableBody?.rows?.length > 0 || hasExecutionRows;
  if (!hasRows || !automationRunning) {
    alert('No test is running.');
    return;
  }
  express.pauseExecution();
  automationRunning = true;
  setExecutionControlState('paused');
});

stopExecutionBtn?.addEventListener('click', async () => {
  const hasRows = tableBody?.rows?.length > 0 || hasExecutionRows;
  if (!hasRows || !automationRunning) {
    alert('No test is running.');
    return;
  }
  try {
    const result = await express.stopExecution?.();
    const message = String(result?.message || '').trim();
    if (message) {
      console.log('[runner-stop]', message);
    }
  } catch (error) {
    console.log('stop execution failed', error?.message || error);
    alert('Unable to stop the active execution.');
  } finally {
    automationRunning = false;
    setExecutionControlState('idle');
  }
});

resumeBtn.addEventListener('click', () => {
  const hasRows = tableBody?.rows?.length > 0 || hasExecutionRows;
  if (!hasRows || !automationRunning) {
    alert('No test is running.');
    return;
  }
  express.resumeExecution();
  automationRunning = true;
  setExecutionControlState('running');
});

const findDefaultRecoveryStepIndex = (runner = [], fallbackIndex = 0) => {
  if (!Array.isArray(runner) || runner.length === 0) return 0;
  const candidate = runner.findIndex(step => {
    if (!step?.actual_step) return false;
    return step.execution !== execution.EXECUTED;
  });
  if (candidate >= 0) return candidate;
  const safeFallback = Number(fallbackIndex);
  if (Number.isFinite(safeFallback) && safeFallback >= 0 && safeFallback < runner.length) {
    return safeFallback;
  }
  return 0;
};

const applyRecoveryRowSelection = () => {
  const rows = tableBody?.querySelectorAll('tr[data-step-index]') || [];
  let selectedText = null;
  rows.forEach(row => {
    const rowStepIndex = Number(row.getAttribute('data-step-index'));
    const selected = recoverySelectionMode && rowStepIndex === selectedRecoveryStepIndex;
    row.classList.toggle('!outline', selected);
    row.classList.toggle('!outline-2', selected);
    row.classList.toggle('!outline-cyan-500', selected);
    row.classList.toggle('cursor-pointer', recoverySelectionMode);
    if (selected) {
      selectedText = row.querySelector('td')?.innerText || `Step ${rowStepIndex + 1}`;
      row.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    }
  });
  if (recoveryStepLabel) {
    recoveryStepLabel.textContent = `Resume Step: ${selectedText || '-'}`;
  }
};

const clearExecutionLogState = () => {
  if (tableBody) {
    tableBody.innerHTML = '';
  }
  const progressEl = document.querySelector('#stepProgress');
  if (progressEl) {
    progressEl.textContent = '';
    progressEl.classList.add('hidden');
  }
  pendingReExecuteData = null;
  currentReExecData = null;
  suppressReExecuteModal = false;
  hasExecutionRows = false;
  automationRunning = false;
  setExecutionControlState('idle');
  reExecModalInstance?.hide();
  refreshResumeFailedStepState();
};

express.testRunnerStepData((event, { runner, currentRunner }) => {
  if (!runner || !Array.isArray(runner) || currentRunner === undefined || currentRunner === null || !runner[currentRunner]) {
    tableBody.innerHTML = '';
    hasExecutionRows = false;
    automationRunning = false;
    setExecutionControlState('idle');
    return;
  }
  console.log(!runner , currentRunner , runner[currentRunner]?.steps?.length === 0)
  try {
    // console.log({runner}, { currentRunner }, { 'runner[currentRunner]': runner[currentRunner] }, { 'runner[currentRunner].steps': runner[currentRunner]?.steps })
    if (runner?.[currentRunner]?.steps?.length === 0)
      return;
    const hasExecutingStep = runner[currentRunner].steps.some(
      step => step?.actual_step && step.execution === execution.EXECUTING,
    );
    const hasFailedStep = runner[currentRunner].steps.some(
      step => step?.actual_step && step.execution === execution.FAILED,
    );
    if (hasExecutingStep) {
      suppressReExecuteModal = false;
      refreshResumeFailedStepState();
    }
    // receiving step data implies a run is active
    automationRunning = true;
    setExecutionControlState(hasExecutingStep ? 'running' : (hasFailedStep ? 'decision' : 'paused'));
    const progressEl = document.querySelector('#stepProgress');
    if (progressEl) {
      const totalSteps = runner[currentRunner].steps.filter(s => s.actual_step).length;
      const currentIdx = runner[currentRunner].steps.findIndex(s => s.execution === execution.EXECUTING);
      if (currentIdx >= 0 && totalSteps > 0) {
        progressEl.textContent = `${currentIdx + 1} of ${totalSteps}`;
        progressEl.classList.remove('hidden');
      } else {
        progressEl.textContent = '';
        progressEl.classList.add('hidden');
      }
    }
    const rows = runner[currentRunner].steps.reduce((acc, step, i) => {
      if (!step.actual_step) return acc;
      const tr = document.createElement('tr');
      tr.setAttribute('scope', 'row');
      tr.classList.add('bg-white', 'border-b', 'border-gray-200', 'hover:bg-gray-100' , "dark:!bg-neutral-900" , "dark:!text-slate-400");
      tr.setAttribute('data-step-index', String(i));

      const descTd = document.createElement('td');
      descTd.innerText = `${i + 1}- ${step.description}`;
      tdColor(descTd, step);
      descTd.classList.add('px-6', 'py-1');

      const keywordTd = document.createElement('td');
      const keywordName = resolveStepKeyword(step);
      keywordTd.innerText = keywordName;
      tdColor(keywordTd, step);
      keywordTd.classList.add('px-6', 'py-1');

      const valueTd = document.createElement('td');
      valueTd.innerText = step.value;
      tdColor(valueTd, step);
      valueTd.classList.add('px-6', 'py-1', "max-w-[400px]");

      const xpathTd = document.createElement('td');
      xpathTd.innerText = step.xPath;
      tdColor(xpathTd, step);
      xpathTd.classList.add('px-6', 'py-1');

      const actionTd = document.createElement('td');
      tdColor(actionTd, step);
      actionTd.classList.add('px-6', 'py-1');
      

      tr.appendChild(descTd);
      tr.appendChild(keywordTd);
      tr.appendChild(valueTd);
      tr.appendChild(xpathTd);
      tr.appendChild(actionTd);
      if (recoverySelectionMode) {
        tr.addEventListener('click', () => {
          selectedRecoveryStepIndex = i;
          applyRecoveryRowSelection();
        });
      }

      return [...acc, tr];
    }, []);
    const table = document
      .getElementById('myTable')
      .getElementsByTagName('tbody')[0];
    table.innerHTML = null;
    rows.forEach(row => table.append(row));
    hasExecutionRows = rows.length > 0;
    if (recoverySelectionMode) {
      applyRecoveryRowSelection();
    }
    // console.log(event, runner)
  } catch (error) {
    const table = document
      .getElementById('myTable')
      .getElementsByTagName('tbody')[0];
    table.innerHTML = null;
    hasExecutionRows = false;
    console.log(error);
  }
});

express.setScreenOptions((event, { screens = [] }) => {
  screens.forEach(screen => {
    const optEl = document.createElement('option');
    optEl.text = screen.name;
    optEl.value = screen.id;
    screenDropdown.add(optEl);
  });
  screenDropdown.addEventListener('change', e => {
    express.selectScreen(e.target.value || null);
  });
});
forceReloadBtn?.addEventListener('click', () => {
  express.forceReload();
});
toggleDevToolsBtn?.addEventListener('click', () => {
  express.toggleDevTools().then(opened => {
    if (opened === true) {
      toggleDevToolsBtn.textContent = 'Close DevTools';
    } else if (opened === false) {
      toggleDevToolsBtn.textContent = 'Open DevTools';
    }
  });
});

const tdColor = (td, step) => {
  // Apply styles based on execution state
  if (step.execution === execution.NOT_EXECUTED) {
    td.style.backgroundColor = '#e9ecef';
  }

  if (step.execution === execution.EXECUTING) {
    // Add a flag to ensure we scroll only once
   
      // Apply styles for the executing step
      td.classList.add(
        '!bg-blue-400',
        'rounded-0',
        '!text-white'
      );
      td.style.color = '#fff';

      setTimeout(() => {
        td.scrollIntoView({
          behavior: 'smooth',   
          block: 'center',      
          inline: 'nearest'
        });
      }, 100);  
    
  }

  if (step.execution === execution.EXECUTED) {
    td.classList.add(
      '!bg-green-100',
      'rounded-0',
      '!text-slate-700'
    );
    td.style.minWidth = '300px';
  }

  if (step.execution === execution.FAILED) {
    td.style.backgroundColor = '#f54d4d';
  }
};



express.openReExecuteDataModal((event, data) => {
  const modalEl = document.querySelector('#reExecuteDataModal');
  if (!modalEl) return;
  reExecModalInstance = bootstrap.Modal.getOrCreateInstance
    ? bootstrap.Modal.getOrCreateInstance(modalEl)
    : new bootstrap.Modal(modalEl);

  if (!data || !data.step) {
    suppressReExecuteModal = false;
    pendingReExecuteData = null;
    reExecModalInstance.hide();
    return;
  }

  const resolvedKeyword = resolveStepKeyword(data?.step);
  currentReExecData = {
    description: data?.step?.description || '',
    failureReason: data?.failureReason || '',
    keyword: resolvedKeyword,
    value: data?.step?.value || '',
    xPath: data?.step?.xPath || '',
  };
  pendingReExecuteData = currentReExecData;
  automationRunning = true;
  setExecutionControlState('decision');
  refreshResumeFailedStepState();

  if (suppressReExecuteModal) {
    return;
  }

  reExecStepLabel.textContent = currentReExecData.description || 'N/A';
  reExecLocatorLabel.textContent = currentReExecData.xPath || 'N/A';
  reExecDataLabel.textContent = currentReExecData.value || 'N/A';
  if (reExecuteFailureReason) {
    reExecuteFailureReason.textContent = currentReExecData.failureReason || '';
  }

  reExecuteModalXpath.value = currentReExecData.xPath;
  reExecuteModalKeyword.value = currentReExecData.keyword;
  reExecuteModalValue.value = currentReExecData.value;

  refreshResumeFailedStepState();
  reExecModalInstance.show();
});

express.noActiveTest((_event, data) => {
  automationRunning = false;
  setExecutionControlState('idle');
  const message = data?.message || 'No active test is running.';
  alert(message);
});

express.clearExecutionLogs?.((_event, _data) => {
  clearExecutionLogState();
});

const keywordArr = [
  {
    id: 1,
    name: 'Click',
    value: 'click',
    client_id: null,
    keyword_combination_ids: null,
    created_at: '2023-03-28T14:38:45.000000Z',
    updated_at: '2023-03-28T14:38:45.000000Z',
    keyword_combination_names: null,
  },

  {
    id: 5,
    name: 'Send Keys',
    value: 'sendKeys',
    client_id: null,
    keyword_combination_ids: null,
    created_at: '2023-03-28T14:38:45.000000Z',
    updated_at: '2023-03-28T14:38:45.000000Z',
    keyword_combination_names: null,
  },

  {
    id: 29,
    name: 'Exist',
    value: 'exist',
    client_id: null,
    keyword_combination_ids: null,
    created_at: '2023-03-28T14:38:45.000000Z',
    updated_at: '2023-03-28T14:38:45.000000Z',
    keyword_combination_names: null,
  },

  {
    id: 71,
    name: 'Alert Accept',
    value: 'alertAccept',
    client_id: null,
    keyword_combination_ids: null,
    created_at: '2023-04-10T14:40:51.000000Z',
    updated_at: '2023-04-10T14:40:51.000000Z',
    keyword_combination_names: null,
  },
  {
    id: 72,
    name: 'Alert Dismiss',
    value: 'alertDismiss',
    client_id: null,
    keyword_combination_ids: null,
    created_at: '2023-04-10T14:40:51.000000Z',
    updated_at: '2023-04-10T14:40:51.000000Z',
    keyword_combination_names: null,
  },
  {
    id: 73,
    name: 'Alert Set Text',
    value: 'alertSetText',
    client_id: null,
    keyword_combination_ids: null,
    created_at: '2023-04-10T14:40:51.000000Z',
    updated_at: '2023-04-10T14:40:51.000000Z',
    keyword_combination_names: null,
  },
  {
    id: 1200,
    name: 'Close Browser',
    value: 'closeBrowser',
    client_id: null,
    keyword_combination_ids: null,
    created_at: '2025-01-01T00:00:00.000000Z',
    updated_at: '2025-01-01T00:00:00.000000Z',
    keyword_combination_names: null,
  },

  {
    id: 1203,
    name: 'Launch Debug Browser',
    value: 'launchDebugBrowser',
    client_id: null,
    keyword_combination_ids: null,
    created_at: '2026-07-27T00:00:00.000000Z',
    updated_at: '2026-07-27T00:00:00.000000Z',
    keyword_combination_names: null,
  },

  {
    id: 1204,
    name: 'Connect Browser',
    value: 'connectBrowser',
    client_id: null,
    keyword_combination_ids: null,
    created_at: '2026-07-27T00:00:00.000000Z',
    updated_at: '2026-07-27T00:00:00.000000Z',
    keyword_combination_names: null,
  },

  {
    id: 102,
    name: 'Validate Element',
    value: 'validateElement',
    client_id: null,
    keyword_combination_ids: null,
    created_at: '2024-03-02T18:26:36.000000Z',
    updated_at: '2024-03-02T18:26:36.000000Z',
    keyword_combination_names: null,
  },

  {
    id: 107,
    name: 'Get Element Value',
    value: 'getElementValue',
    client_id: null,
    keyword_combination_ids: null,
    created_at: '2024-03-09T14:44:49.000000Z',
    updated_at: '2024-03-09T14:44:49.000000Z',
    keyword_combination_names: null,
  },
  {
    id: 108,
    name: 'Scroll To Text',
    value: 'scrollToText',
    client_id: null,
    keyword_combination_ids: null,
    created_at: '2024-03-09T14:44:49.000000Z',
    updated_at: '2024-03-09T14:44:49.000000Z',
    keyword_combination_names: null,
  },
  {
    id: 110,
    name: 'Scroll To Element',
    value: 'scrollToElement',
    client_id: null,
    keyword_combination_ids: null,
    created_at: '2024-03-09T14:44:49.000000Z',
    updated_at: '2024-03-09T14:44:49.000000Z',
    keyword_combination_names: null,
  },
  {
    id: 111,
    name: 'Digital Signature',
    value: 'digitalSignature',
    client_id: null,
    keyword_combination_ids: null,
    created_at: '2024-03-09T14:44:49.000000Z',
    updated_at: '2024-03-09T14:44:49.000000Z',
    keyword_combination_names: null,
  },
  {
    id: 112,
    name: 'Hover Element',
    value: 'hoverElement',
    client_id: null,
    keyword_combination_ids: null,
    created_at: '2024-03-09T14:44:49.000000Z',
    updated_at: '2024-03-09T14:44:49.000000Z',
    keyword_combination_names: null,
  },
  {
    id: 113,
    name: 'Switch To Iframe',
    value: 'switchToIframe',
    client_id: null,
    keyword_combination_ids: null,
    created_at: '2024-03-09T14:44:49.000000Z',
    updated_at: '2024-03-09T14:44:49.000000Z',
    keyword_combination_names: null,
  },
  {
    id: 114,
    name: 'Switch Browser',
    value: 'switchBrowser',
    client_id: null,
    keyword_combination_ids: null,
    created_at: '2024-03-09T14:44:49.000000Z',
    updated_at: '2024-03-09T14:44:49.000000Z',
    keyword_combination_names: null,
  },
  {
    id: 115,
    name: 'Right Click',
    value: 'rightClick',
    client_id: null,
    keyword_combination_ids: null,
    created_at: '2024-03-09T14:44:49.000000Z',
    updated_at: '2024-03-09T14:44:49.000000Z',
    keyword_combination_names: null,
  },
  {
    id: 116,
    name: 'Double Click',
    value: 'doubleClick',
    client_id: null,
    keyword_combination_ids: null,
    created_at: '2024-03-09T14:44:49.000000Z',
    updated_at: '2024-03-09T14:44:49.000000Z',
    keyword_combination_names: null,
  },
  {
    id: 117,
    name: 'select',
    value: 'select',
    client_id: null,
    keyword_combination_ids: null,
    created_at: '2024-03-09T14:44:49.000000Z',
    updated_at: '2024-03-09T14:44:49.000000Z',
    keyword_combination_names: null,
  },
  {
    id: 118,
    name: 'Connect PDF',
    value: 'connectPDF',
    client_id: null,
    keyword_combination_ids: null,
    created_at: '2024-03-09T14:44:49.000000Z',
    updated_at: '2024-03-09T14:44:49.000000Z',
    keyword_combination_names: null,
  },
  {
    id: 119,
    name: 'Verify PDF Text',
    value: 'verifyPDFText',
    client_id: null,
    keyword_combination_ids: null,
    created_at: '2024-03-09T14:44:49.000000Z',
    updated_at: '2024-03-09T14:44:49.000000Z',
    keyword_combination_names: null,
  },
  {
    id: 120,
    name: 'Disconnect PDF',
    value: '  disconnectPDF',
    client_id: null,
    keyword_combination_ids: null,
    created_at: '2024-03-09T14:44:49.000000Z',
    updated_at: '2024-03-09T14:44:49.000000Z',
    keyword_combination_names: null,
  },
  {
    id: 121,
    name: 'Delete PDF File',
    value: 'deletePDFFile',
    client_id: null,
    keyword_combination_ids: null,
    created_at: '2024-03-09T14:44:49.000000Z',
    updated_at: '2024-03-09T14:44:49.000000Z',
    keyword_combination_names: null,
  },
  {
    id: 122,
    name: 'Get Cookie Value',
    value: 'getCookieValue',
    client_id: null,
    keyword_combination_ids: null,
    created_at: '2024-03-09T14:44:49.000000Z',
    updated_at: '2024-03-09T14:44:49.000000Z',
    keyword_combination_names: null,
  },
  {
    id: 123,
    name: 'Remove Cookie',
    value: 'removeCookie',
    client_id: null,
    keyword_combination_ids: null,
    created_at: '2024-03-09T14:44:49.000000Z',
    updated_at: '2024-03-09T14:44:49.000000Z',
    keyword_combination_names: null,
  },
  {
    id: 124,
    name: 'Verify Text On Alert',
    value: 'verifyTextOnAlert',
    client_id: null,
    keyword_combination_ids: null,
    created_at: '2024-03-09T14:44:49.000000Z',
    updated_at: '2024-03-09T14:44:49.000000Z',
    keyword_combination_names: null,
  },
  {
    id: 125,
    name: 'Drag Drop',
    value: 'dragDrop',
    client_id: null,
    keyword_combination_ids: null,
    created_at: '2024-03-09T14:44:49.000000Z',
    updated_at: '2024-03-09T14:44:49.000000Z',
    keyword_combination_names: null,
  },
  {
    id: 126,
    name: 'Get DB Value',
    value: 'getDBValue',
    client_id: null,
    keyword_combination_ids: null,
    created_at: '2024-03-09T14:44:49.000000Z',
    updated_at: '2024-03-09T14:44:49.000000Z',
    keyword_combination_names: null,
  },
  {
    id: 127,
    name: 'Execute SQL',
    value: 'executeSQL',
    client_id: null,
    keyword_combination_ids: null,
    created_at: '2024-03-09T14:44:49.000000Z',
    updated_at: '2024-03-09T14:44:49.000000Z',
    keyword_combination_names: null,
  },
  {
    id: 128,
    name: 'Select All',
    value: 'selectAll',
    client_id: null,
    keyword_combination_ids: null,
    created_at: '2024-03-09T14:44:49.000000Z',
    updated_at: '2024-03-09T14:44:49.000000Z',
    keyword_combination_names: null,
  },
  {
    id: 129,
    name: 'Clear Input',
    value: 'clearInput',
    client_id: null,
    keyword_combination_ids: null,
    created_at: '2024-03-09T14:44:49.000000Z',
    updated_at: '2024-03-09T14:44:49.000000Z',
    keyword_combination_names: null,
  },
  {
    id: 130,
    name: 'Mobile Open App',
    value: 'mobileOpenApp',
    client_id: null,
    keyword_combination_ids: null,
    created_at: '2024-03-09T14:44:49.000000Z',
    updated_at: '2024-03-09T14:44:49.000000Z',
    keyword_combination_names: null,
  },
  {
    id: 131,
    name: 'Mobile Tap',
    value: 'mobileTap',
    client_id: null,
    keyword_combination_ids: null,
    created_at: '2024-03-09T14:44:49.000000Z',
    updated_at: '2024-03-09T14:44:49.000000Z',
    keyword_combination_names: null,
  },
  {
    id: 132,
    name: 'Mobile Double Tap',
    value: 'mobileDoubleTap',
    client_id: null,
    keyword_combination_ids: null,
    created_at: '2024-03-09T14:44:49.000000Z',
    updated_at: '2024-03-09T14:44:49.000000Z',
    keyword_combination_names: null,
  },
  {
    id: 133,
    name: 'Mobile Long Press',
    value: 'mobileLongPress',
    client_id: null,
    keyword_combination_ids: null,
    created_at: '2024-03-09T14:44:49.000000Z',
    updated_at: '2024-03-09T14:44:49.000000Z',
    keyword_combination_names: null,
  },
  {
    id: 134,
    name: 'Mobile Fill',
    value: 'mobileFll',
    client_id: null,
    keyword_combination_ids: null,
    created_at: '2024-03-09T14:44:49.000000Z',
    updated_at: '2024-03-09T14:44:49.000000Z',
    keyword_combination_names: null,
  },
  {
    id: 135,
    name: 'Mobile Back',
    value: 'mobileBack',
    client_id: null,
    keyword_combination_ids: null,
    created_at: '2024-03-09T14:44:49.000000Z',
    updated_at: '2024-03-09T14:44:49.000000Z',
    keyword_combination_names: null,
  },

  {
    id: 136,
    name: 'Mobile Swipe',
    value: 'mobileSwipe',
    client_id: null,
    keyword_combination_ids: null,
    created_at: '2024-03-09T14:44:49.000000Z',
    updated_at: '2024-03-09T14:44:49.000000Z',
    keyword_combination_names: null,
  },
  {
    id: 137,
    name: 'Mobile Scroll To Text',
    value: 'mobileScrollToText',
    client_id: null,
    keyword_combination_ids: null,
    created_at: '2024-03-09T14:44:49.000000Z',
    updated_at: '2024-03-09T14:44:49.000000Z',
    keyword_combination_names: null,
  },
  {
    id: 138,
    name: 'Mobile Element Exist',
    value: 'mobileElementExist',
    client_id: null,
    keyword_combination_ids: null,
    created_at: '2024-03-09T14:44:49.000000Z',
    updated_at: '2024-03-09T14:44:49.000000Z',
    keyword_combination_names: null,
  },
  {
    id: 139,
    name: 'Mobile Element Not Exist',
    value: 'mobileElementNotExist',
    client_id: null,
    keyword_combination_ids: null,
    created_at: '2024-03-09T14:44:49.000000Z',
    updated_at: '2024-03-09T14:44:49.000000Z',
    keyword_combination_names: null,
  },
  {
    id: 140,
    name: 'Mobile Element Validate',
    value: 'mobileElementValidate',
    client_id: null,
    keyword_combination_ids: null,
    created_at: '2024-03-09T14:44:49.000000Z',
    updated_at: '2024-03-09T14:44:49.000000Z',
    keyword_combination_names: null,
  },
  {
    id: 141,
    name: 'Mobile Hide Keyboard',
    value: 'mobileHideKeyboard',
    client_id: null,
    keyword_combination_ids: null,
    created_at: '2024-03-09T14:44:49.000000Z',
    updated_at: '2024-03-09T14:44:49.000000Z',
    keyword_combination_names: null,
  },
  {
    id: 142,
    name: 'Mobile Digital Signature',
    value: 'mobileDigitalSignature',
    client_id: null,
    keyword_combination_ids: null,
    created_at: '2024-03-09T14:44:49.000000Z',
    updated_at: '2024-03-09T14:44:49.000000Z',
    keyword_combination_names: null,
  },
  {
    id: 143,
    name: 'Mobile Pinch',
    value: 'mobilePinch',
    client_id: null,
    keyword_combination_ids: null,
    created_at: '2024-03-09T14:44:49.000000Z',
    updated_at: '2024-03-09T14:44:49.000000Z',
    keyword_combination_names: null,
  },
  {
    id: 144,
    name: 'Mobile Switch Context',
    value: 'mobileSwitchContext',
    client_id: null,
    keyword_combination_ids: null,
    created_at: '2024-03-09T14:44:49.000000Z',
    updated_at: '2024-03-09T14:44:49.000000Z',
    keyword_combination_names: null,
  },
];

keywordArr.forEach(k => {
  const option = document.createElement('option');
  option.value = k.value;
  option.textContent = k.name;
  const optionClone = option.cloneNode(true);
  testKeyword.append(option);
  reExecuteModalKeyword.append(optionClone);
});

testKeyword.addEventListener('change', e => {
  console.log(e.target.value);
});

const manualAllowEmptyLocatorKeywords = new Set([
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

const manualSessionActivationKeywords = new Set([
  'launchdebugbrowser',
  'debugbrowser',
  'connectbrowser',
]);

testExecute.addEventListener('click', async () => {
  const keyword = (testKeyword.value || '').toLowerCase();
  const locator = testLocator.value || '';
  if (!locator.trim() && !manualAllowEmptyLocatorKeywords.has(keyword)) {
    return;
  }

  try {
    const result = await express.testExecute(locator, testKeyword.value, testValue.value);
    if (manualSessionActivationKeywords.has(keyword) && result?.ok && result?.sessionActive) {
      setLaunchButtonState(true);
    }
    if (keyword === 'closebrowser' && result?.sessionActive === false) {
      setLaunchButtonState(false);
    }
  } catch (err) {
    testOutput.value = err?.message || String(err);
  }
});

const setLaunchButtonState = running => {
  isBrowserLaunched = running;
  if (running) {
    testLaunchBrowser.textContent = 'Close Browser';
    testLaunchBrowser.classList.remove('btn-primary');
    testLaunchBrowser.classList.add('btn-outline-danger');
  } else {
    testLaunchBrowser.textContent = 'Launch Browser';
    testLaunchBrowser.classList.add('btn-primary');
    testLaunchBrowser.classList.remove('btn-outline-danger');
  }
};

testLaunchBrowser.addEventListener('click', async () => {
  if (!isBrowserLaunched) {
    await express.testLaunchBrowser();
    setLaunchButtonState(true);
    return;
  }
  if (isXpathRecording) {
    isXpathRecording = false;
    setSpyLabel('Spy Objects');
    express.recordXpathStop();
    if (xpathFetchInterval) {
      clearInterval(xpathFetchInterval);
      xpathFetchInterval = null;
    }
  }
  await express.closeTestBrowser();
  setLaunchButtonState(false);
});

window.addEventListener('beforeunload', () => {
  if (isXpathRecording) {
    express.recordXpathStop();
    isXpathRecording = false;
    if (xpathFetchInterval) {
      clearInterval(xpathFetchInterval);
      xpathFetchInterval = null;
    }
  }
  express.closeTestBrowser();
  setLaunchButtonState(false);
});


// Splash handling
const splashEl = document.getElementById('qaf-splash');
const splashBar = document.getElementById('qaf-progress-bar');
const hideSplash = () => {
  if (!splashEl) return;
  splashEl.classList.remove('active');
  splashEl.style.opacity = '0';
  splashEl.style.pointerEvents = 'none';
  setTimeout(() => {
    if (splashEl && splashEl.parentNode) splashEl.parentNode.removeChild(splashEl);
  }, 260);
};
const showSplash = () => {
  if (!splashEl) return;
  splashEl.classList.add('active');
};
const setSplashProgress = pct => {
  if (!splashBar) return;
  splashBar.style.animation = 'none';
  splashBar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
};
// Show immediately, hide shortly after load to avoid blocking UI
showSplash();
window.addEventListener('load', () => {
  setSplashProgress(90);
  setTimeout(() => {
    setSplashProgress(100);
    hideSplash();
  }, 500);
});

clearLogBtn.addEventListener('click', () => {
  clearExecutionLogState();
});

const applyReExecuteChanges = () => {
  const keywordValue = reExecuteModalKeyword.value || currentReExecData?.keyword || '';
  const payload = {
    xPath: reExecuteModalXpath.value || currentReExecData?.xPath || '',
    value: reExecuteModalValue.value ?? currentReExecData?.value ?? '',
  };
  if (keywordValue) {
    payload.keyword = keywordValue;
  }
  express.dataToReExecuteStep(payload);
};

reExecuteModalExecuteBtn.addEventListener('click', () => {
  suppressReExecuteModal = false;
  applyReExecuteChanges();
  express.reExecuteStep();
  refreshResumeFailedStepState();
  reExecModalInstance?.hide();
});

reExecuteModalResetBtn.addEventListener('click', () => {
  if (!currentReExecData) return;
  reExecuteModalXpath.value = currentReExecData.xPath || '';
  reExecuteModalKeyword.value = currentReExecData.keyword || '';
  reExecuteModalValue.value = currentReExecData.value || '';
  applyReExecuteChanges();
});

reExecuteModalMarkPassBtn.addEventListener('click', () => {
  suppressReExecuteModal = false;
  express.markStepAsPass();
  refreshResumeFailedStepState();
  reExecModalInstance?.hide();
});

reExecuteModalMarkFailBtn?.addEventListener('click', () => {
  suppressReExecuteModal = false;
  express.markStepAsFail?.();
  refreshResumeFailedStepState();
  reExecModalInstance?.hide();
});

reExecuteModalLaunchBrowserBtn?.addEventListener('click', async () => {
  try {
    const result = await express.relaunchRunBrowser?.();
    if (!result?.ok) {
      alert(result?.message || 'Failed to relaunch browser for active run.');
      return;
    }
    setLaunchButtonState(true);
  } catch (err) {
    alert('Failed to launch browser from recovery modal.');
  }
});

reExecuteModalCancelBtn?.addEventListener('click', () => {
  suppressReExecuteModal = true;
  reExecModalInstance?.hide();
  refreshResumeFailedStepState();
});

resumeFailedStepBtn?.addEventListener('click', () => {
  reopenPendingReExecuteModal();
});

express.testExecuteOutput((event, { output }) => {
  testOutput.value = output;
});

// Listen for server status updates from main process
express.getServerStatus?.((event, payload = {}) => {
  const status = payload?.status === true;
  const port = Number(payload?.port || 0) || currentWebPort;
  const reason = String(payload?.reason || '').trim();
  const code = String(payload?.code || '').trim();
  currentWebPort = port;
  if (serverText) {
    serverText.textContent = status
      ? `Runner server online on ${port}`
      : reason
        ? `Runner server offline: ${reason}`
        : 'Runner server offline';
  }
  if (status) {
    lastServerFailureSignature = '';
    console.log('runner server online', { port });
    return;
  }
  if (!reason) {
    console.log('runner server offline', { port });
    return;
  }
  const failureSignature = `${code}:${reason}:${port}`;
  console.error('runner server offline', { port, code, reason });
  if (failureSignature === lastServerFailureSignature) {
    return;
  }
  lastServerFailureSignature = failureSignature;
  alert(reason);
});

