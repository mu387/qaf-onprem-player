// forge.config.js
const path = require('path');
const APP_ENV = process.env.APP_ENV || process.env.NODE_ENV || 'staging';
const productName = APP_ENV === 'prod' ? 'Utitlity-With' : `Utitlity-With-${APP_ENV}`;

module.exports = {
  packagerConfig: {
    name: productName,
    executableName: productName,
    appBundleId: `com.QAF-OnPrem.${APP_ENV}`,
    icon: path.join(__dirname, 'assets', 'icon'),
    extraResource: [
      path.join(__dirname, `.env.${APP_ENV}`),
    ],
  },
  rebuildConfig: {},
  makers: [
    { name: '@electron-forge/maker-squirrel', config: {} },
    { name: '@electron-forge/maker-zip', platforms: ['darwin'] },
    { name: '@electron-forge/maker-deb', config: {} },
    { name: '@electron-forge/maker-rpm', config: {} },
    { name: '@electron-forge/maker-dmg', config: {} },
  ],
};

