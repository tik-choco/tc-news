import * as engine from '@tik-choco/mistlib';
import { createMistlibDiagnostics } from '../vendor/mistlibDiagnostics';
export { parseBuildInfo } from '../vendor/mistlibDiagnostics';
export type { BuildInfo, BuildSnapshot } from '../vendor/mistlibDiagnostics';
declare const __MISTLIB_SOURCE__: 'local' | 'registry';
export const mistDiagnostics = createMistlibDiagnostics({
  app: 'tc-news', environment: import.meta.env.MODE, development: import.meta.env.DEV,
  source: typeof __MISTLIB_SOURCE__ === 'undefined' ? 'unknown' : __MISTLIB_SOURCE__,
});
export const getMistBuildSnapshot = mistDiagnostics.getSnapshot;
export const subscribeMistBuild = mistDiagnostics.subscribe;
export const captureMistBuildInfo = () => mistDiagnostics.capture(engine);
export const markMistLoadError = mistDiagnostics.markLoadError;
