export { XvfbManager } from './xvfb.js'
export {
  BrowserPool,
  type BrowserEntry,
  type BrowserPoolOptions,
} from './pool.js'
export {
  ProxyCredentialStore,
  proxyServerFlag,
  proxyServerFlagWithAuth,
  type ProxyConfig,
} from './proxy.js'
export { AsyncMutex } from './mutex.js'
export {
  signRequest,
  verifyRequest,
} from './hmac.js'
export {
  ScreencastSession,
  type ScreencastOptions,
} from './screencast.js'
export {
  checkLoginOnce,
  checkCookieConditions,
  checkUrlConditions,
  waitForLogin,
  type UrlSource,
  type LoginCheckConfig,
  type LoginCondition,
  type LoginResult,
} from './login.js'
export {
  detectAuthFailure,
  type AuthFailure,
  type AuthFailureCode,
} from './auth-detect.js'
export {
  CONNECTION_ID_RE,
  InvalidConnectionIdError,
  assertConnectionId,
  isValidConnectionId,
} from './connection-id.js'
