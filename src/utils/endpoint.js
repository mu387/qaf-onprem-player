const { getRuntimeConfig } = require('./runtimeConfig');

const ENV_BASE_URL =
  process.env.REACT_APP_API_BASE_URL ||
  process.env.API_BASE_URL ||
  'https://api.QAF-OnPrem.com/api';

const joinBase = (base, path) => {
  if (!base) return path;
  const b = base.endsWith('/') ? base.slice(0, -1) : base;
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
};

const resolveUrl = (overrideOrEnvValue, fallbackPath) => {
  const rc = getRuntimeConfig() || {};
  const base = rc.apiBaseUrl || ENV_BASE_URL;
  const value = overrideOrEnvValue;
  if (!value) return joinBase(base, fallbackPath);
  if (value.startsWith('http://') || value.startsWith('https://')) {
    return value;
  }
  return joinBase(base, value);
};

const getBaseUrl = () => getRuntimeConfig()?.apiBaseUrl || ENV_BASE_URL;

const getUploadVideoUrl = () =>
  resolveUrl(
    getRuntimeConfig()?.uploadVideoUrl || process.env.UPLOAD_TEST_VIDEO_URL,
    '/upload/testsuites/video',
  );

const getSaveCloseUrl = () =>
  resolveUrl(
    getRuntimeConfig()?.saveCloseUrl || process.env.SAVE_CLOSE_URL,
    '/save/close/testsuites',
  );
const getStepLogUrl = () =>
  resolveUrl(
    getRuntimeConfig()?.stepLogUrl || process.env.STEP_LOG_URL,
    '/save/testsuites/steps/status',
  );

const getBulkStepLogV2Url = () =>
  resolveUrl(
    getRuntimeConfig()?.bulkStepLogV2Url || process.env.BULK_STEP_LOG_V2_URL,
    '/bulk/testsuites/steps/status-v2',
  );

module.exports = {
  BASE_URL: ENV_BASE_URL,
  getBaseUrl,
  getUploadVideoUrl,
  getStepLogUrl,
  getBulkStepLogV2Url,
  getSaveCloseUrl,
};


