const { api } = require('./api');
const { getStepLogUrl } = require('./endpoint');
const { getRuntimeConfig } = require('./runtimeConfig');

const resolveStepKeyword = step => {
  const candidates = [
    step?.keyword?.name,
    step?.keyword,
    step?.keyword_name,
    step?.keywordName,
  ];
  for (const candidate of candidates) {
    if (candidate == null) continue;
    const text = String(candidate).trim();
    if (text !== '') return candidate;
  }
  return null;
};

const buildStepLogRequest = ({
  runnerId,
  testSuiteId,
  testPlanItemId,
  stepId,
  testRunnerSteps,
  datasetId,
  runnerIndex,
  stepIndex,
  error = null,
  token,
}) => {
  const runner = testRunnerSteps?.[runnerIndex];
  const runtimeFlag = getRuntimeConfig()?.enableMockUiFallback === true || getRuntimeConfig()?.enableMockUiFallback === 'true';
  const envFlag = process.env.ENABLE_MOCK_UI_FALLBACK === 'true';
  const allowFallback = runtimeFlag || envFlag;
  const steps = runner?.steps || [];

  let step;
  if (stepId !== undefined && stepId !== null && datasetId !== undefined && datasetId !== null) {
    step = steps.filter(({ id, dataset_id }) => id === stepId && datasetId === dataset_id)[0] || undefined;
  }
  if (!step && allowFallback && stepIndex !== undefined && stepIndex !== null && steps[stepIndex]) {
    step = steps[stepIndex];
  }
  if (!step && allowFallback && steps.length) {
    step = steps.find(s => s?.description || s?.keyword || s?.xPath || s?.xpath) || steps[0];
  }
  if (!step) return null;

  const keyword = resolveStepKeyword(step);
  const xPath = step?.xPath ?? step?.xpath;
  const payloadStep = {
    ...step,
    keyword,
    xPath,
    is_passed: !error,
    ...(stepIndex !== undefined && stepIndex !== null ? { step_index: stepIndex } : {}),
  };

  return {
    url: getStepLogUrl(),
    method: 'post',
    data: {
      test_runner_id: runnerId,
      test_suite_id: testSuiteId,
      ...(testPlanItemId ? { test_plan_item_id: testPlanItemId } : {}),
      steps: [payloadStep],
    },
    token,
  };
};

const buildStepStatusEvent = payload => {
  const legacyConfig = buildStepLogRequest(payload);
  if (!legacyConfig) return null;

  const step = legacyConfig?.data?.steps?.[0];
  const runnerId = Number(legacyConfig?.data?.test_runner_id || 0);
  const testSuiteId = Number(legacyConfig?.data?.test_suite_id || 0);
  const testPlanItemId = Number(payload?.testPlanItemId || legacyConfig?.data?.test_plan_item_id || 0);
  const stepId = Number(step?.id || 0);
  const datasetId = Number(step?.dataset_id || 0);
  const attemptNo = Number(payload?.attemptNo || 1);

  if (!runnerId || !testSuiteId || !stepId || !datasetId) {
    return null;
  }

  return {
    runnerId,
    testSuiteId,
    testPlanItemId: testPlanItemId || null,
    token: legacyConfig.token,
    step: {
      step_id: stepId,
      dataset_id: datasetId,
      is_passed: !!step?.is_passed,
      ...(Object.prototype.hasOwnProperty.call(step || {}, 'comment') ? { comment: step.comment } : {}),
      attempt_no: attemptNo,
      executed_at: new Date().toISOString(),
      idempotency_key: `${runnerId}:${testSuiteId}:${datasetId}:${stepId}:${attemptNo}`,
    },
    legacyConfig,
  };
};

const stepLogCall = async payload => {
  const config = buildStepLogRequest(payload);
  if (!config) return;
  try {
    await api.request(config);
    console.log('log call successful');
  } catch (error) {
    const status = error?.response?.status ?? 'unknown';
    console.log('log call failed -- code-- ' + status);
  }
};

module.exports = {
  stepLogCall,
  buildStepLogRequest,
  buildStepStatusEvent,
};
