import { describe, expect, it } from 'vitest';
import { createMistlibDiagnostics, mountMistlibDiagnostics } from '../vendor/mistlibDiagnostics';
const info = { version: '0.6.2', commit: 'abc1234', dirty: true, profile: 'release', target: 'wasm32-unknown-unknown' };
function store() { return createMistlibDiagnostics({ app: 'test', source: 'registry', development: false, environment: 'production' }); }
describe('framework independent diagnostics', () => {
  it('shares runtime updates across banner and minimal settings without crossing stores', () => {
    const first = store(); const other = store();
    const host = document.createElement('div');
    const disposeBanner = mountMistlibDiagnostics(host, first);
    const disposeSettings = mountMistlibDiagnostics(host, first, 'settings');
    const banner = host.children[0].shadowRoot!;
    const settings = host.children[1].shadowRoot!;
    expect(settings.querySelector('.version')?.textContent).toBe('mistlib —');
    first.capture({ get_build_info: () => JSON.stringify({ ...info, privatePath: 'secret' }) });
    expect(banner.querySelector('strong')?.textContent).toBe('DEVELOPMENT');
    expect(settings.querySelector('.version')?.textContent).toBe('mistlib 0.6.2');
    expect(settings.querySelector('details')).toBeNull();
    const link = settings.querySelector('a')!;
    expect(link.href).toBe('https://github.com/tik-choco-lab/mistlib');
    expect(link.rel).toBe('noopener noreferrer');
    expect(first.diagnostic()).not.toContain('secret');
    expect(other.getSnapshot().state).toBe('waiting');
    disposeBanner(); disposeSettings();
    first.markLoadError();
    expect(settings.querySelector('.version')?.textContent).toBe('mistlib 0.6.2');
    expect(host.childElementCount).toBe(0);
    const disposeAgain = mountMistlibDiagnostics(host, first, 'settings');
    expect(host.children[0].shadowRoot?.querySelector('.version')?.textContent).toBe('mistlib —');
    disposeAgain();
  });
  it('preserves disclosure state during updates and handles old or throwing engines', () => {
    const diagnostics = store(); const host = document.createElement('div');
    const dispose = mountMistlibDiagnostics(host, diagnostics);
    const details = host.children[0].shadowRoot!.querySelector('details')!;
    details.open = true;
    diagnostics.capture({});
    expect(diagnostics.getSnapshot().state).toBe('unverified');
    diagnostics.capture({ get_build_info: () => { throw new Error('old'); } });
    expect(diagnostics.getSnapshot().info).toBeNull();
    diagnostics.capture({ get_build_info: () => JSON.stringify(info) });
    expect(details.open).toBe(true);
    expect(diagnostics.getSnapshot().state).toBe('reported');
    dispose();
  });
});
