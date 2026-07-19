import { setActivePinia, createPinia } from 'pinia';

import { useSettingsStore } from '~/stores/settings';
import { useServerStore } from '~/stores/server';
import { getClient } from '~/util/awclient';
import { defaultBuiltinWindowSource } from '~/util/rulesV2';

jest.mock('~/util/awclient', () => ({
  getClient: jest.fn(),
}));

describe('settings store', () => {
  setActivePinia(createPinia());
  const settingsStore = useSettingsStore();

  beforeEach(() => {
    settingsStore.$reset();
    jest.restoreAllMocks();
  });

  test('ensureLoaded coalesces concurrent loads', async () => {
    let resolveLoad!: () => void;
    const loadMock = jest.spyOn(settingsStore, 'load').mockImplementation(
      () =>
        new Promise<void>(resolve => {
          resolveLoad = () => {
            settingsStore.$patch({ _loaded: true });
            resolve();
          };
        })
    );

    const firstLoad = settingsStore.ensureLoaded();
    const secondLoad = settingsStore.ensureLoaded();

    expect(loadMock).toHaveBeenCalledTimes(1);

    resolveLoad();
    await Promise.all([firstLoad, secondLoad]);

    expect(settingsStore.loaded).toBe(true);
  });

  test('loading normalized rules never writes settings back to the server', async () => {
    const post = jest.fn();
    Object.defineProperty(global, 'localStorage', {
      configurable: true,
      value: {
        getItem: jest.fn().mockReturnValue(null),
        setItem: jest.fn(),
        length: 0,
        key: jest.fn().mockReturnValue(null),
      },
    });
    (getClient as jest.Mock).mockReturnValue({
      get_settings: jest.fn().mockResolvedValue({
        classes: [{ name: ['Work'], rule: { type: 'none' } }],
      }),
      req: { post, defaults: { timeout: 0 } },
    });

    await settingsStore.load();

    expect(settingsStore.activity_profiles_v2).not.toBeNull();
    expect(settingsStore.category_sets_v2).not.toBeNull();
    expect(post).not.toHaveBeenCalled();
    Reflect.deleteProperty(global, 'localStorage');
  });

  test('migrates predecessor category sets without dropping inactive sets', async () => {
    Object.defineProperty(global, 'localStorage', {
      configurable: true,
      value: {
        getItem: jest.fn().mockReturnValue(null),
        setItem: jest.fn(),
        length: 0,
        key: jest.fn().mockReturnValue(null),
      },
    });
    (getClient as jest.Mock).mockReturnValue({
      get_settings: jest.fn().mockResolvedValue({
        classes: [{ name: ['Combined'], rule: { type: 'none' } }],
        category_sets: [
          {
            id: 'work',
            categories: [{ name: ['Work'], rule: { type: 'regex', regex: 'work' } }],
          },
          {
            id: 'personal',
            categories: [{ name: ['Personal'], rule: { type: 'regex', regex: 'personal' } }],
          },
        ],
        active_set_ids: ['personal'],
      }),
      req: { post: jest.fn(), defaults: { timeout: 0 } },
    });

    await settingsStore.load();

    expect(settingsStore.category_sets_v2?.map(set => set.id)).toEqual(['default']);
    expect(settingsStore.category_sets_v2?.[0].categories.map(category => category.name)).toEqual([
      ['Personal'],
    ]);
    expect(settingsStore.activity_profiles_v2?.[0].category_set_ids).toEqual(['default']);
    Reflect.deleteProperty(global, 'localStorage');
  });

  test('update waits for settings to load before patching state', async () => {
    const savedQueries = [
      {
        id: 'daily-coding-time',
        name: 'Daily Coding Time',
        query_code: 'RETURN = [];',
        start_day_offset: 0,
        end_day_offset: -1,
        event_type: 'currentwindow',
      },
    ];
    const steps: string[] = [];

    jest.spyOn(settingsStore, 'ensureLoaded').mockImplementation(async () => {
      steps.push('ensureLoaded');
      expect(settingsStore.saved_queries).toEqual([]);
      settingsStore.$patch({ _loaded: true });
    });

    jest.spyOn(settingsStore, 'save').mockImplementation(async () => {
      steps.push('save');
      expect(settingsStore.saved_queries).toEqual(savedQueries);
    });

    await settingsStore.update({ saved_queries: savedQueries });

    expect(steps).toEqual(['ensureLoaded', 'save']);
    expect(settingsStore.saved_queries).toEqual(savedQueries);
  });

  test('compiled v2 rules stay active in simple mode while migration is pending', () => {
    settingsStore.$patch({ _loaded: true });
    useServerStore().$patch({
      info: {
        hostname: 'test',
        device_id: 'test',
        version: 'test',
        testing: true,
        capabilities: ['query.categorize_v2.v1'],
      },
    });

    expect(settingsStore.rulesV2.migrated).toBe(true);
    expect(settingsStore.rulesEditorMode).toBe('simple');
    expect(settingsStore.hasAdvancedRulesV2).toBe(false);
    expect(settingsStore.compiledRulesV2?.category_specs.length).toBeGreaterThan(0);
  });

  test('advanced source rules report unsupported compilation without losing their state', () => {
    settingsStore.$patch({
      _loaded: true,
      activity_profiles_v2: [
        {
          schema_version: 2,
          id: 'default',
          category_set_ids: ['default'],
          sources: [
            {
              id: 'desktop',
              label: 'Desktop',
              bucket_ids: ['desktop'],
              scope: 'global',
              fields: ['vdesktop'],
              activity_mode: 'fill-gaps',
            },
          ],
          active_time: {
            type: 'legacy',
            use_afk: true,
            include_audible: true,
            always_active_pattern: '',
          },
        },
      ],
      category_sets_v2: [{ schema_version: 2, id: 'default', categories: [] }],
    });
    useServerStore().$patch({
      info: {
        hostname: 'test',
        device_id: 'test',
        version: 'test',
        testing: true,
        capabilities: ['query.categorize_v2.v1'],
      },
    });

    expect(settingsStore.hasAdvancedRulesV2).toBe(true);
    expect(settingsStore.compiledRulesV2).toBeUndefined();
  });

  test('switching to advanced mode only persists the editor preference', async () => {
    settingsStore.$patch({ _loaded: true });
    const updateMock = jest.spyOn(settingsStore, 'update').mockResolvedValue();

    await settingsStore.setRulesEditorMode('advanced');

    expect(updateMock).toHaveBeenCalledWith({ rules_editor_mode: 'advanced' });
  });

  test('simple category edits are saved to canonical rules after in-memory migration', async () => {
    settingsStore.$patch({
      _loaded: true,
      classes: [{ name: ['Work'], rule: { type: 'regex', regex: 'old' } }],
    });

    const saveMock = jest.spyOn(settingsStore, 'saveCanonicalRulesV2').mockResolvedValue();

    await settingsStore.saveCategoryRuleV2({
      originalName: ['Work'],
      name: ['Work'],
      rule: { type: 'regex', regex: 'new', weight: 0 },
      priority: 0,
      requires: [],
    });

    const saved = saveMock.mock.calls[0][0];
    expect(saved.categorySets[0].categories[0]).toMatchObject({
      name: ['Work'],
      simple_ui: true,
      rule: { type: 'regex', regex: 'new', weight: 0 },
    });
  });

  test('canonical saves synchronize the predecessor category set for older clients', async () => {
    const post = jest.fn().mockResolvedValue(undefined);
    (getClient as jest.Mock).mockReturnValue({
      get_settings: jest.fn().mockResolvedValue({}),
      req: { post, defaults: { timeout: 0 } },
    });
    jest.spyOn(settingsStore, 'update').mockResolvedValue();
    jest.spyOn(settingsStore, 'load').mockResolvedValue();

    await settingsStore.saveCanonicalRulesV2({
      profiles: [
        {
          schema_version: 2,
          id: 'default',
          category_set_ids: ['default'],
          sources: [],
          active_time: {
            type: 'legacy',
            use_afk: true,
            include_audible: true,
            always_active_pattern: '',
          },
        },
      ],
      categorySets: [
        {
          schema_version: 2,
          id: 'default',
          categories: [
            {
              id: 'work',
              name: ['Work'],
              simple_ui: true,
              rule: { type: 'regex', regex: 'work', weight: 0 },
            },
          ],
        },
      ],
    });

    expect(post).toHaveBeenCalledWith(
      '/0/settings/category_sets',
      [
        {
          id: 'default',
          categories: [
            {
              name: ['Work'],
              rule: { type: 'regex', regex: 'work' },
            },
          ],
        },
      ],
      { headers: { 'Content-Type': 'application/json' } }
    );
    expect(post).toHaveBeenCalledWith(
      '/0/settings/active_set_ids',
      ['default'],
      { headers: { 'Content-Type': 'application/json' } }
    );
  });

  test('saving an active-time expression preserves the latest source definitions', async () => {
    settingsStore.$patch({
      _loaded: true,
      activity_profiles_v2: [
        {
          schema_version: 2,
          id: 'default',
          category_set_ids: ['default'],
          sources: [
            {
              id: 'browser',
              label: 'Browser',
              bucket_ids: ['aw-watcher-web'],
              scope: 'global',
              fields: ['url'],
            },
          ],
          active_time: {
            type: 'legacy',
            use_afk: true,
            include_audible: true,
            always_active_pattern: '',
          },
        },
      ],
      category_sets_v2: [{ schema_version: 2, id: 'default', categories: [] }],
    });
    const saveMock = jest.spyOn(settingsStore, 'saveCanonicalRulesV2').mockResolvedValue();

    await settingsStore.saveActiveTimeRuleV2({
      type: 'regex',
      source: 'browser',
      field: 'url',
      regex: 'meeting',
    });

    expect(saveMock.mock.calls[0][0].profiles[0].sources).toEqual([
      defaultBuiltinWindowSource(false),
      ...settingsStore.activity_profiles_v2[0].sources,
    ]);
  });

  test('saving an active-time expression includes newly selected watcher sources', async () => {
    settingsStore.$patch({
      _loaded: true,
      activity_profiles_v2: [
        {
          schema_version: 2,
          id: 'default',
          category_set_ids: ['default'],
          sources: [],
          active_time: {
            type: 'legacy',
            use_afk: true,
            include_audible: true,
            always_active_pattern: '',
          },
        },
      ],
      category_sets_v2: [{ schema_version: 2, id: 'default', categories: [] }],
    });
    const saveMock = jest.spyOn(settingsStore, 'saveCanonicalRulesV2').mockResolvedValue();
    const sources = [
      {
        id: 'afk',
        label: 'AFK watcher',
        bucket_ids: ['aw-watcher-afk'],
        scope: 'global' as const,
        fields: ['status'],
      },
    ];

    await settingsStore.saveActiveTimeRuleV2(
      {
        type: 'regex',
        source: 'afk',
        field: 'status',
        regex: 'not-afk',
      },
      sources
    );

    expect(saveMock.mock.calls[0][0].profiles[0].sources).toEqual([
      defaultBuiltinWindowSource(),
      ...sources,
    ]);
  });

  test('saving an active-time draft does not overwrite newer unrelated source edits', async () => {
    const baseline = [
      {
        id: 'browser',
        label: 'Browser',
        bucket_ids: ['browser'],
        scope: 'global' as const,
        fields: ['url'],
      },
    ];
    settingsStore.$patch({
      _loaded: true,
      activity_profiles_v2: [
        {
          schema_version: 2,
          id: 'default',
          category_set_ids: ['default'],
          sources: [{ ...baseline[0], label: 'Browser (renamed elsewhere)' }],
          active_time: {
            type: 'legacy',
            use_afk: true,
            include_audible: true,
            always_active_pattern: '',
          },
        },
      ],
      category_sets_v2: [{ schema_version: 2, id: 'default', categories: [] }],
    });
    const saveMock = jest.spyOn(settingsStore, 'saveCanonicalRulesV2').mockResolvedValue();
    const draft = [
      baseline[0],
      {
        id: 'presence',
        label: 'Presence',
        bucket_ids: ['presence'],
        scope: 'global' as const,
        fields: ['state'],
      },
    ];

    await settingsStore.saveActiveTimeRuleV2(
      {
        type: 'regex',
        source: 'presence',
        field: 'state',
        regex: 'active',
      },
      draft,
      baseline
    );

    expect(saveMock.mock.calls[0][0].profiles[0].sources).toEqual([
      defaultBuiltinWindowSource(false),
      { ...baseline[0], label: 'Browser (renamed elsewhere)' },
      draft[1],
    ]);
  });
});
