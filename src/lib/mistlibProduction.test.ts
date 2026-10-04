import { describe, expect, it } from 'vitest';
import { createMistlibDiagnostics, mountMistlibDiagnostics } from '../vendor/mistlibDiagnostics';
const info = { version: '0.6.2', commit: 'abc1234', dirty: false, profile: 'release', target: 'wasm32-unknown-unknown' };
describe('production banner visibility', () => {
  it('never displays the regular production banner, including before init and on old APIs/errors', () => {
    const store = createMistlibDiagnostics({ app: 'test', source: 'registry', development: false, environment: 'production' });
    const host = document.createElement('div');
    const removeBanner = mountMistlibDiagnostics(host, store);
    const removeSettings = mountMistlibDiagnostics(host, store, 'settings');
    const banner = host.children[0] as HTMLElement;
    const settings = host.children[1] as HTMLElement;
    expect(banner.hidden).toBe(true);
    expect(banner.style.display).toBe('none');
    store.capture({ get_build_info: () => JSON.stringify(info) });
    expect(banner.hidden).toBe(true);
    expect(settings.hidden).toBe(false);
    expect(settings.shadowRoot?.querySelector('.version')?.textContent).toBe('mistlib 0.6.2');
    store.capture({});
    expect(banner.hidden).toBe(true);
    store.markLoadError();
    expect(banner.hidden).toBe(true);
    removeBanner(); removeSettings();
  });
  it.each([
    { source: 'registry' as const, development: true },
    { source: 'local' as const, development: false },
  ])('shows development or local builds immediately: %j', options => {
    const store = createMistlibDiagnostics({ app: 'test', environment: 'production', ...options });
    const host = document.createElement('div');
    const remove = mountMistlibDiagnostics(host, store);
    expect((host.firstElementChild as HTMLElement).hidden).toBe(false);
    expect(host.firstElementChild?.shadowRoot?.querySelector('strong')?.textContent).toBe('DEVELOPMENT');
    remove();
  });
  it('shows a dirty runtime discovered after initialization', () => {
    const store = createMistlibDiagnostics({ app: 'test', source: 'registry', development: false, environment: 'production' });
    const host = document.createElement('div');
    const remove = mountMistlibDiagnostics(host, store);
    expect((host.firstElementChild as HTMLElement).hidden).toBe(true);
    store.capture({ get_build_info: () => JSON.stringify({ ...info, dirty: true }) });
    expect((host.firstElementChild as HTMLElement).hidden).toBe(false);
    remove();
  });
});
