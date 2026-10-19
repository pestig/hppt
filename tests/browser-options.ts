import type { LaunchOptions } from '@playwright/test';

// Playwright 1.64.1 disables storage partitioning for convenience. Exercise the
// real browser isolation model instead. Keep its other pinned launch defaults.
const disabled = ['AvoidUnnecessaryBeforeUnloadCheckSync', 'DestroyProfileOnBrowserClose', 'DialMediaRouteProvider', 'GlobalMediaControls', 'HttpsUpgrades', 'LensOverlay', 'MediaRouter', 'PaintHolding', 'ThirdPartyStoragePartitioning', 'BlockOriginHeaderModificationOnRedirect', 'AvoidCorsURLLoaderRestartOnRedirect', 'Translate', 'AutoDeElevate', 'OptimizationHints', 'NetworkTimeServiceQuerying', 'AimEnabled', 'msForceBrowserSignIn', 'msEdgeUpdateLaunchServicesPreferredVersion'];
export const browserOptions: LaunchOptions = {
  ignoreDefaultArgs: [`--disable-features=${disabled.join(',')}`],
  args: [`--disable-features=${disabled.filter(name => name !== 'ThirdPartyStoragePartitioning').join(',')}`]
};
