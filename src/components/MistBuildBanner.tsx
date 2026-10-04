import { useEffect, useRef } from 'preact/hooks';
import { mountMistlibDiagnostics } from '../vendor/mistlibDiagnostics';
import { mistDiagnostics } from '../lib/mistBuildInfo';
// Framework adapter only. Rendering and state live in the common module.
export function MistBuildBanner({ view = 'banner' }: { view?: 'banner' | 'settings' }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (host.current) return mountMistlibDiagnostics(host.current, mistDiagnostics, view);
  }, [view]);
  return <div ref={host} />;
}
