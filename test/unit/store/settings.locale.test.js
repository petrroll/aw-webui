const mockGetSettings = jest.fn();
const mockPost = jest.fn();

jest.mock('~/util/awclient', () => ({
  getClient: () => ({
    get_settings: mockGetSettings,
    req: {
      defaults: { timeout: 0 },
      post: mockPost,
    },
  }),
}));

import { setActivePinia, createPinia } from 'pinia';
import { useSettingsStore } from '~/stores/settings';
import { i18n } from '~/i18n';

describe('settings store locale loading', () => {
  let settingsStore;

  beforeEach(() => {
    setActivePinia(createPinia());
    settingsStore = useSettingsStore();
    settingsStore.$reset();
    settingsStore.$patch({ _loaded: false });
    mockGetSettings.mockReset();
    mockGetSettings.mockResolvedValue({});
    mockPost.mockReset();
    i18n.locale = 'en';
    localStorage.clear();
  });

  test('load applies valid locale from server', async () => {
    mockGetSettings.mockResolvedValue({ locale: 'de' });

    await settingsStore.load();

    expect(settingsStore.locale).toBe('de');
    expect(i18n.locale).toBe('de');
    expect(document.documentElement.lang).toBe('de');
    expect(settingsStore.loaded).toBe(true);
  });

  test('load ignores invalid locale from server', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(jest.fn());
    mockGetSettings.mockResolvedValue({ locale: 'fr' });

    await settingsStore.load();

    expect(warn).toHaveBeenCalledWith('Ignoring invalid locale from server:', 'fr');
    expect(settingsStore.locale).toBe('en');
    warn.mockRestore();
  });

  test('load applies valid locale from localStorage', async () => {
    localStorage.setItem('locale', 'zh-CN');
    mockGetSettings.mockResolvedValue({});

    await settingsStore.load();

    expect(settingsStore.locale).toBe('zh-CN');
    expect(i18n.locale).toBe('zh-CN');
  });

  test('load ignores invalid locale from localStorage', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(jest.fn());
    localStorage.setItem('locale', 'xx');
    mockGetSettings.mockResolvedValue({});

    await settingsStore.load();

    expect(warn).toHaveBeenCalledWith('Ignoring invalid locale from storage:', 'xx');
    expect(settingsStore.locale).toBe('en');
    warn.mockRestore();
  });

  test('load migrates legacy classes in memory without rewriting server settings', async () => {
    mockGetSettings.mockResolvedValue({
      classes: [{ name: ['Work'], rule: { type: 'regex', regex: 'code' } }],
      always_active_pattern: 'Teams',
    });

    await settingsStore.load();

    expect(settingsStore.category_sets_v2[0].categories[0]).toMatchObject({
      name: ['Work'],
      simple_ui: true,
      rule: { type: 'regex', regex: 'code', weight: 0 },
    });
    expect(mockPost).not.toHaveBeenCalled();
    expect(settingsStore.classes).toEqual([
      { name: ['Work'], rule: { type: 'regex', regex: 'code' } },
    ]);
  });
});
