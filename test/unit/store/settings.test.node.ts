import { setActivePinia, createPinia } from 'pinia';

import { useSettingsStore } from '~/stores/settings';
import { useServerStore } from '~/stores/server';
import { useBucketsStore } from '~/stores/buckets';
import { getClient } from '~/util/awclient';
import { defaultBuiltinWindowSource, migrateLegacySettings } from '~/util/rulesV2';

jest.mock('~/util/awclient', () => ({
  getClient: jest.fn(),
}));

describe('settings store', () => {
  setActivePinia(createPinia());
  const settingsStore = useSettingsStore();

  beforeEach(() => {
    settingsStore.$reset();
    useServerStore().$reset();
    useBucketsStore().$reset();
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

  test('loading an expression profile does not retain a stale legacy active pattern', async () => {
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
        always_active_pattern: 'stale meeting rule',
        activity_profiles_v2: [
          {
            schema_version: 2,
            source_defaults_version: 3,
            id: 'default',
            category_set_ids: ['default'],
            sources: [
              {
                id: 'presence',
                label: 'Presence',
                bucket_ids: ['presence'],
                scope: 'global',
                fields: ['state'],
              },
            ],
            active_time: {
              type: 'expression',
              rule: { type: 'regex', source: 'presence', field: 'state', regex: 'active' },
            },
          },
        ],
        category_sets_v2: [{ schema_version: 2, id: 'default', categories: [] }],
      }),
      req: { post, defaults: { timeout: 0 } },
    });

    await settingsStore.load();

    expect(settingsStore.always_active_pattern).toBe('');
    expect(post).not.toHaveBeenCalled();
    Reflect.deleteProperty(global, 'localStorage');
  });

  test('malformed persisted rules load a safe fallback and retain diagnostics', async () => {
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
        activity_profiles_v2: [
          {
            schema_version: 2,
            id: 'broken',
            category_set_ids: ['default'],
            active_time: { type: 'legacy', always_active_pattern: '' },
          },
        ],
        category_sets_v2: [{ schema_version: 2, id: 'default', categories: [] }],
      }),
      req: { post: jest.fn(), defaults: { timeout: 0 } },
    });

    await expect(settingsStore.load()).resolves.toBeUndefined();

    expect(settingsStore.rulesV2.activity_profiles_v2[0].sources).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'builtin_window' })])
    );
    expect(settingsStore.invalidRulesV2Diagnostics.join(' ')).toContain('could not be loaded');
    expect(settingsStore.compiledActivityQueryV2).toBeUndefined();
    Reflect.deleteProperty(global, 'localStorage');
  });

  test('preference saves preserve malformed canonical and legacy documents until explicit repair', async () => {
    Object.defineProperty(global, 'localStorage', {
      configurable: true,
      value: {
        getItem: jest.fn().mockReturnValue(null),
        setItem: jest.fn(),
        length: 0,
        key: jest.fn().mockReturnValue(null),
      },
    });
    Object.defineProperty(global, 'document', {
      configurable: true,
      value: { documentElement: { lang: '' } },
    });
    const serverSettings: Record<string, any> = {
      theme: 'auto',
      activity_profiles_v2: [
        {
          schema_version: 2,
          id: 'broken',
          category_set_ids: ['canonical'],
          active_time: { type: 'legacy', always_active_pattern: '' },
        },
      ],
      category_sets_v2: [{ schema_version: 2, id: 'canonical', categories: [] }],
      classes: [{ name: ['Legacy'], rule: { type: 'regex', regex: 'legacy-class' } }],
      always_active_pattern: 'legacy-active',
      category_sets: [
        {
          id: 'legacy-inactive',
          categories: [{ name: ['Keep'], rule: { type: 'regex', regex: 'keep-legacy' } }],
        },
      ],
      active_set_ids: ['legacy-inactive'],
    };
    const originalRules = JSON.parse(JSON.stringify(serverSettings));
    const post = jest.fn(async (path: string, value: any) => {
      if (path === '/0/settings/rules_v2') {
        return { data: { ...JSON.parse(JSON.stringify(value)), revision: value.revision + 1 } };
      }
      serverSettings[path.replace('/0/settings/', '')] = JSON.parse(JSON.stringify(value));
      return { data: value };
    });
    (getClient as jest.Mock).mockReturnValue({
      get_settings: jest.fn(async () => JSON.parse(JSON.stringify(serverSettings))),
      req: { post, defaults: { timeout: 0 } },
    });

    await settingsStore.load();
    expect(settingsStore.invalidRulesV2Diagnostics.join(' ')).toContain('could not be loaded');
    await settingsStore.update({ theme: 'dark' });

    for (const key of [
      'activity_profiles_v2',
      'category_sets_v2',
      'classes',
      'always_active_pattern',
      'category_sets',
      'active_set_ids',
    ]) {
      expect(serverSettings[key]).toEqual(originalRules[key]);
    }
    expect(serverSettings.theme).toBe('dark');

    settingsStore.$reset();
    await settingsStore.load();
    expect(settingsStore.invalidRulesV2Diagnostics.join(' ')).toContain('could not be loaded');

    const repairedProfile = {
      schema_version: 2 as const,
      source_defaults_version: 3,
      id: 'repaired',
      category_set_ids: ['repaired'],
      sources: [defaultBuiltinWindowSource()],
      active_time: {
        type: 'expression' as const,
        rule: { type: 'none' as const },
      },
    };
    const repairedSet = {
      schema_version: 2 as const,
      id: 'repaired',
      categories: [
        {
          id: 'work',
          name: ['Work'],
          rule: { type: 'regex' as const, regex: 'Code' },
          simple_ui: true,
        },
      ],
    };
    await expect(
      settingsStore.saveCanonicalRulesV2({
        profiles: [repairedProfile],
        categorySets: [repairedSet],
      })
    ).rejects.toThrow('recovery mode');
    await settingsStore.saveCanonicalRulesV2({
      profiles: [repairedProfile],
      categorySets: [repairedSet],
      recoveryReplacement: true,
    });

    expect(post).toHaveBeenCalledWith(
      '/0/settings/rules_v2',
      expect.objectContaining({
        revision: 0,
        activity_profiles_v2: [repairedProfile],
        category_sets_v2: [repairedSet],
      }),
      expect.anything()
    );
    expect(post.mock.calls.filter(([path]) => path === '/0/settings/rules_v2')).toHaveLength(1);
    // The frontend never writes compatibility projections; the server derives them.
    expect(serverSettings.classes).toEqual(originalRules.classes);
    expect(serverSettings.category_sets).toEqual(originalRules.category_sets);
    expect(serverSettings.active_set_ids).toEqual(originalRules.active_set_ids);
    expect(settingsStore.invalidRulesV2Diagnostics).toEqual([]);
    expect((settingsStore.$state as any)._rulesV2RecoveryActive).toBe(false);
    Reflect.deleteProperty(global, 'localStorage');
    Reflect.deleteProperty(global, 'document');
  });

  test.each(['reset', 'import'])(
    'salvages a malformed envelope revision for explicit recovery %s',
    async recoveryKind => {
      Object.defineProperty(global, 'localStorage', {
        configurable: true,
        value: {
          getItem: jest.fn().mockReturnValue(null),
          setItem: jest.fn(),
          length: 0,
          key: jest.fn().mockReturnValue(null),
        },
      });
      const stored: Record<string, any> = {
        revision: 7,
        activity_profiles_v2: 'broken',
        category_sets_v2: [],
      };
      const post = jest.fn(async (_path: string, value: any) => {
        if (value.revision !== stored.revision) {
          const error: any = new Error('revision conflict');
          error.response = { status: 409, data: { message: 'revision conflict' } };
          throw error;
        }
        Object.assign(stored, JSON.parse(JSON.stringify(value)), { revision: value.revision + 1 });
        return { data: JSON.parse(JSON.stringify(stored)) };
      });
      (getClient as jest.Mock).mockReturnValue({
        get_settings: jest.fn().mockResolvedValue({ rules_v2: stored }),
        req: { post, defaults: { timeout: 0 } },
      });

      await settingsStore.load();
      expect(settingsStore.rulesV2RecoveryActive).toBe(true);
      expect(settingsStore.rulesV2Revision).toBe(7);

      if (recoveryKind === 'reset') {
        await settingsStore.replaceRulesV2WithDefaults();
      } else {
        const repaired = {
          schema_version: 2 as const,
          id: 'repair',
          category_set_ids: ['repair'],
          sources: [defaultBuiltinWindowSource()],
          active_time: {
            type: 'expression' as const,
            rule: { type: 'none' as const },
          },
        };
        await settingsStore.saveCanonicalRulesV2({
          profiles: [repaired],
          categorySets: [{ schema_version: 2, id: 'repair', categories: [] }],
          recoveryReplacement: true,
        });
      }

      expect(post).toHaveBeenCalledWith(
        '/0/settings/rules_v2',
        expect.objectContaining({ revision: 7 }),
        expect.anything()
      );
      expect(settingsStore.rulesV2Revision).toBe(8);
      expect(settingsStore.rulesV2RecoveryActive).toBe(false);
      Reflect.deleteProperty(global, 'localStorage');
    }
  );

  test.each(['active', 'inactive'])(
    'malformed %s categories do not abort startup or leak through preference saves',
    async malformedPosition => {
      Object.defineProperty(global, 'localStorage', {
        configurable: true,
        value: {
          getItem: jest.fn().mockReturnValue(null),
          setItem: jest.fn(),
          length: 0,
          key: jest.fn().mockReturnValue(null),
        },
      });
      Object.defineProperty(global, 'document', {
        configurable: true,
        value: { documentElement: { lang: '' } },
      });
      const validSet = { schema_version: 2, id: 'active', categories: [] };
      const malformedSet = {
        schema_version: 2,
        id: malformedPosition,
        categories: [{ id: 'broken', rule: { type: 'none' } }],
      };
      const categorySets =
        malformedPosition === 'active' ? [malformedSet] : [validSet, malformedSet];
      const serverSettings: Record<string, any> = {
        theme: 'auto',
        activity_profiles_v2: [
          {
            schema_version: 2,
            source_defaults_version: 3,
            id: 'default',
            category_set_ids: ['active'],
            sources: [defaultBuiltinWindowSource()],
            active_time: { type: 'expression', rule: { type: 'none' } },
          },
        ],
        category_sets_v2: categorySets,
        classes: [{ name: ['Legacy'], rule: { type: 'none' } }],
        category_sets: [
          { id: 'legacy', categories: [{ name: ['Legacy'], rule: { type: 'none' } }] },
        ],
        active_set_ids: ['legacy'],
      };
      const original = JSON.parse(JSON.stringify(serverSettings));
      const post = jest.fn(async (path: string, value: unknown) => {
        serverSettings[path.replace('/0/settings/', '')] = JSON.parse(JSON.stringify(value));
      });
      (getClient as jest.Mock).mockReturnValue({
        get_settings: jest.fn(async () => JSON.parse(JSON.stringify(serverSettings))),
        req: { post, defaults: { timeout: 0 } },
      });

      await expect(settingsStore.load()).resolves.toBeUndefined();
      expect(settingsStore.invalidRulesV2Diagnostics.join(' ')).toContain('could not be loaded');
      await settingsStore.update({ theme: 'dark' });
      expect(serverSettings.activity_profiles_v2).toEqual(original.activity_profiles_v2);
      expect(serverSettings.category_sets_v2).toEqual(original.category_sets_v2);
      expect(serverSettings.classes).toEqual(original.classes);
      expect(serverSettings.category_sets).toEqual(original.category_sets);
      expect(serverSettings.active_set_ids).toEqual(original.active_set_ids);

      settingsStore.$reset();
      await expect(settingsStore.load()).resolves.toBeUndefined();
      expect(settingsStore.invalidRulesV2Diagnostics.join(' ')).toContain('could not be loaded');
      Reflect.deleteProperty(global, 'localStorage');
      Reflect.deleteProperty(global, 'document');
    }
  );

  test('initializes the default window source once for interim v2 profiles', async () => {
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
        activity_profiles_v2: [
          {
            schema_version: 2,
            id: 'default',
            category_set_ids: ['default'],
            sources: [
              {
                id: 'desktop',
                label: 'Virtual desktop',
                bucket_ids: ['desktop'],
                scope: 'global',
                fields: ['vdesktop'],
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
      }),
      req: { post, defaults: { timeout: 0 } },
    });

    await settingsStore.load();

    expect(settingsStore.activity_profiles_v2?.[0].source_defaults_version).toBe(4);
    expect(settingsStore.activity_profiles_v2?.[0].sources).toEqual([
      expect.objectContaining({
        id: 'builtin_window',
        builtin: 'window',
        creates_activity: true,
        fields: ['app', 'title'],
      }),
      expect.objectContaining({ id: 'desktop' }),
      expect.objectContaining({ id: 'browser', builtin: 'browser' }),
      expect.objectContaining({
        id: 'stopwatch',
        builtin: 'stopwatch',
        creates_activity: true,
        keeps_active: true,
      }),
    ]);
    expect(post).not.toHaveBeenCalled();
    Reflect.deleteProperty(global, 'localStorage');
  });

  test('does not restore a window source removed after defaults were initialized', async () => {
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
        activity_profiles_v2: [
          {
            schema_version: 2,
            source_defaults_version: 2,
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
      }),
      req: { post: jest.fn(), defaults: { timeout: 0 } },
    });

    await settingsStore.load();

    expect(settingsStore.activity_profiles_v2?.[0].sources).toEqual([]);
    expect(settingsStore.activity_profiles_v2?.[0]).toMatchObject({
      source_defaults_version: 4,
      app_title_source_id: 'builtin_window',
      browser_focus_source_id: 'builtin_window',
    });
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

    expect(settingsStore.category_sets_v2?.map(set => set.id)).toEqual(['personal', 'work']);
    expect(settingsStore.category_sets_v2?.[0].categories.map(category => category.name)).toEqual([
      ['Personal'],
    ]);
    expect(settingsStore.category_sets_v2?.[1].categories.map(category => category.name)).toEqual([
      ['Work'],
    ]);
    expect(settingsStore.activity_profiles_v2?.[0].category_set_ids).toEqual(['personal']);
    Reflect.deleteProperty(global, 'localStorage');
  });

  test('save and reload preserve inactive predecessor sets on the mocked server', async () => {
    Object.defineProperty(global, 'localStorage', {
      configurable: true,
      value: {
        getItem: jest.fn().mockReturnValue(null),
        setItem: jest.fn(),
        length: 0,
        key: jest.fn().mockReturnValue(null),
      },
    });
    Object.defineProperty(global, 'document', {
      configurable: true,
      value: { documentElement: { lang: '' } },
    });
    const serverSettings: Record<string, any> = {
      classes: [{ name: ['Personal'], rule: { type: 'regex', regex: 'personal' } }],
      category_sets: [
        {
          id: 'work',
          categories: [{ name: ['Work'], rule: { type: 'regex', regex: 'keep-me' } }],
        },
        {
          id: 'personal',
          categories: [{ name: ['Personal'], rule: { type: 'regex', regex: 'personal' } }],
        },
      ],
      active_set_ids: ['personal'],
    };
    const post = jest.fn(async (path: string, value: any) => {
      if (path !== '/0/settings/rules_v2') throw new Error(`unexpected write: ${path}`);
      const stored = { ...JSON.parse(JSON.stringify(value)), revision: value.revision + 1 };
      serverSettings.activity_profiles_v2 = stored.activity_profiles_v2;
      serverSettings.category_sets_v2 = stored.category_sets_v2;
      return { data: stored };
    });
    (getClient as jest.Mock).mockReturnValue({
      get_settings: jest.fn(async () => JSON.parse(JSON.stringify(serverSettings))),
      req: { post, defaults: { timeout: 0 } },
    });

    await settingsStore.load();
    await settingsStore.saveCategoryRuleV2({
      originalName: ['Personal'],
      name: ['Personal'],
      rule: { type: 'regex', regex: 'personal-updated', weight: 0 },
      priority: 0,
      requires: [],
    });

    expect(serverSettings.category_sets_v2.map(set => set.id)).toEqual(['personal', 'work']);
    expect(serverSettings.category_sets_v2[1].categories[0].rule.regex).toBe('keep-me');
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toBe('/0/settings/rules_v2');
    // Compatibility projections remain server-owned; this mock keeps the
    // predecessor values unchanged.
    expect(serverSettings.category_sets.map(set => set.id)).toEqual(['work', 'personal']);
    expect(serverSettings.active_set_ids).toEqual(['personal']);
    Reflect.deleteProperty(global, 'localStorage');
    Reflect.deleteProperty(global, 'document');
  });

  test('multiple predecessor selections preserve the selected composition and inactive sets', async () => {
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
        category_sets: [
          { id: 'work', categories: [{ name: ['Work'], rule: { type: 'none' } }] },
          { id: 'personal', categories: [{ name: ['Personal'], rule: { type: 'none' } }] },
        ],
        active_set_ids: ['work', 'personal'],
      }),
      req: { post: jest.fn(), defaults: { timeout: 0 } },
    });

    await settingsStore.load();

    expect(settingsStore.activity_profiles_v2?.[0].category_set_ids).toEqual([
      'work',
      'personal',
    ]);
    expect(settingsStore.category_sets_v2?.map(set => set.id)).toEqual(['work', 'personal']);
    expect(settingsStore.category_sets_v2?.map(set => set.categories[0].name)).toEqual([
      ['Work'],
      ['Personal'],
    ]);
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
    expect(settingsStore.compiledLegacyTargetOptions?.category_specs.length).toBeGreaterThan(0);
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
    expect(settingsStore.compiledLegacyTargetOptions).toBeUndefined();
  });

  test('invalid persisted rules never throw from compiled getters or bucket hosts', () => {
    settingsStore.$patch({
      _loaded: true,
      activity_profiles_v2: [
        {
          schema_version: 2,
          id: 'broken',
          category_set_ids: ['default'],
          active_time: { type: 'legacy', always_active_pattern: '' },
        } as any,
      ],
      category_sets_v2: [{ schema_version: 2, id: 'default', categories: [] }],
    });
    useServerStore().$patch({
      info: {
        hostname: 'test',
        device_id: 'test',
        version: 'test',
        testing: true,
        capabilities: [
          'query.categorize_v2.v1',
          'query.merge_subwatcher_fields.source_namespace.v1',
          'query.active_periods_v2.v1',
        ],
      },
    });
    useBucketsStore().$patch({
      buckets: [
        {
          id: 'aw-watcher-window_test',
          type: 'currentwindow',
          hostname: 'test',
          data: {},
        } as any,
      ],
    });

    expect(settingsStore.invalidRulesV2Diagnostics.join(' ')).toContain('could not be loaded');
    expect(settingsStore.compiledLegacyTargetOptions).toBeUndefined();
    expect(settingsStore.compiledActivityQueryV2).toBeUndefined();
    expect(settingsStore.activityV2Unsupported).toBe(false);
    expect(() => useBucketsStore().hosts).not.toThrow();
  });

  test('editor source saves reject removing window while unsourced rules remain', async () => {
    settingsStore.$patch({
      _loaded: true,
      activity_profiles_v2: [
        {
          schema_version: 2,
          id: 'default',
          category_set_ids: ['default'],
          sources: [defaultBuiltinWindowSource()],
          active_time: {
            type: 'legacy',
            use_afk: true,
            include_audible: true,
            always_active_pattern: '',
          },
        },
      ],
      category_sets_v2: [
        {
          schema_version: 2,
          id: 'default',
          categories: [{ id: 'work', name: ['Work'], rule: { type: 'regex', regex: 'Code' } }],
        },
      ],
    });
    const save = jest.spyOn(settingsStore, 'saveCanonicalRulesV2');

    await expect(settingsStore.saveRuleSourcesV2([])).rejects.toThrow(
      'unsourced category rules require the App & window source'
    );
    expect(save).not.toHaveBeenCalled();
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

  test('loads the authoritative revisioned envelope instead of derived get-all projections', async () => {
    Object.defineProperty(global, 'localStorage', {
      configurable: true,
      value: {
        getItem: jest.fn().mockReturnValue(null),
        setItem: jest.fn(),
        length: 0,
        key: jest.fn().mockReturnValue(null),
      },
    });
    useServerStore().info = { capabilities: ['settings.rules_v2.v1'] } as any;
    const envelope = {
      revision: 7,
      activity_profiles_v2: [
        {
          schema_version: 2,
          source_defaults_version: 4,
          id: 'canonical',
          category_set_ids: ['canonical'],
          sources: [defaultBuiltinWindowSource()],
          active_time: { type: 'expression', rule: { type: 'none' } },
        },
      ],
      category_sets_v2: [{ schema_version: 2, id: 'canonical', categories: [] }],
    };
    const get = jest.fn().mockResolvedValue({ data: envelope });
    (getClient as jest.Mock).mockReturnValue({
      get_settings: jest.fn().mockResolvedValue({
        activity_profiles_v2: [],
        category_sets_v2: [],
      }),
      req: { get, post: jest.fn(), defaults: { timeout: 0 } },
    });

    await settingsStore.load();

    expect(get).toHaveBeenCalledWith('/0/settings/rules_v2');
    expect(settingsStore.rulesV2Revision).toBe(7);
    expect(settingsStore.rulesV2.activity_profiles_v2[0].id).toBe('canonical');
    Reflect.deleteProperty(global, 'localStorage');
  });

  test('canonical meeting-only sources survive load and ordinary edits exactly', async () => {
    Object.defineProperty(global, 'localStorage', {
      configurable: true,
      value: {
        getItem: jest.fn().mockReturnValue(null),
        setItem: jest.fn(),
        length: 0,
        key: jest.fn().mockReturnValue(null),
      },
    });
    useServerStore().info = { capabilities: ['settings.rules_v2.v1'] } as any;
    useBucketsStore().$patch({
      buckets: [
        { id: 'meeting-a', type: 'fixture.meeting', hostname: 'host-a', data: {} },
        { id: 'window-a', type: 'currentwindow', hostname: 'host-a', data: {} },
        { id: 'browser-a', type: 'web.tab.current', hostname: 'host-a', data: {} },
        { id: 'stopwatch-a', type: 'stopwatch', hostname: 'host-a', data: {} },
      ] as any,
    });
    const meetingSource = {
      id: 'meeting',
      label: 'Meeting only',
      bucket_ids: ['meeting-a'],
      bucket_hosts: { 'meeting-a': 'host-a' },
      scope: 'host' as const,
      fields: ['subject'],
      interval_policy: 'exact' as const,
      creates_activity: true,
      keeps_active: true,
      // Deprecated hints in an authoritative document are preserved, not
      // reinterpreted as a request to migrate source semantics.
      role: 'context' as const,
      merge_mode: 'enrich' as const,
      priority: 7,
    };
    const envelope = {
      revision: 1,
      activity_profiles_v2: [
        {
          schema_version: 2 as const,
          id: 'meeting-only',
          category_set_ids: ['work'],
          sources: [meetingSource],
          active_time: { type: 'expression' as const, rule: { type: 'none' as const } },
        },
      ],
      category_sets_v2: [
        {
          schema_version: 2 as const,
          id: 'work',
          categories: [
            {
              id: 'meeting-work',
              name: ['Work'],
              rule: {
                type: 'regex' as const,
                source: 'meeting',
                field: 'subject',
                regex: 'sync',
              },
              simple_ui: false,
            },
          ],
        },
      ],
    };
    const post = jest.fn(async (_path: string, value: any) => ({
      data: { ...JSON.parse(JSON.stringify(value)), revision: value.revision + 1 },
    }));
    (getClient as jest.Mock).mockReturnValue({
      get_settings: jest.fn().mockResolvedValue({ rules_v2: envelope }),
      req: { post, defaults: { timeout: 0 } },
    });

    await settingsStore.load();

    const loadedProfile = settingsStore.rulesV2.activity_profiles_v2[0];
    expect(loadedProfile.sources).toEqual([meetingSource]);
    expect(loadedProfile).not.toHaveProperty('source_defaults_version');
    expect(loadedProfile).not.toHaveProperty('app_title_source_id');
    expect(loadedProfile).not.toHaveProperty('browser_focus_source_id');

    await settingsStore.saveCategoryRuleV2({
      categoryId: 'meeting-work',
      originalName: ['Work'],
      name: ['Focused work'],
      rule: { type: 'regex', source: 'meeting', field: 'subject', regex: 'sync' },
      priority: 0,
      requires: [],
    });

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toBe('/0/settings/rules_v2');
    expect(post.mock.calls[0][1].activity_profiles_v2[0].sources).toEqual([meetingSource]);
    expect(post.mock.calls[0][1].activity_profiles_v2[0]).not.toHaveProperty(
      'source_defaults_version'
    );
    expect(settingsStore.rulesV2.activity_profiles_v2[0].sources).toEqual([meetingSource]);
    Reflect.deleteProperty(global, 'localStorage');
  });

  test('a stale CAS keeps the local document and exposes a conflict', async () => {
    useServerStore().info = { capabilities: ['settings.rules_v2.v1'] } as any;
    const profile = {
      schema_version: 2 as const,
      source_defaults_version: 4,
      id: 'default',
      category_set_ids: ['default'],
      sources: [defaultBuiltinWindowSource()],
      active_time: { type: 'expression' as const, rule: { type: 'none' as const } },
    };
    const categorySet = { schema_version: 2 as const, id: 'default', categories: [] };
    settingsStore.$patch({
      _loaded: true,
      _rulesV2Revision: 4,
      activity_profiles_v2: [profile],
      category_sets_v2: [categorySet],
    });
    const post = jest.fn().mockRejectedValue({
      response: { status: 409, data: { message: 'expected revision 4, current revision 5' } },
    });
    (getClient as jest.Mock).mockReturnValue({ req: { post } });
    const draft = { ...profile, id: 'draft' };

    await expect(
      settingsStore.saveCanonicalRulesV2({ profiles: [draft], categorySets: [categorySet] })
    ).rejects.toThrow('Your draft was kept');

    expect(post).toHaveBeenCalledWith(
      '/0/settings/rules_v2',
      expect.objectContaining({ revision: 4, activity_profiles_v2: [draft] }),
      expect.anything()
    );
    expect(settingsStore.activity_profiles_v2?.[0].id).toBe('default');
    expect(settingsStore.rulesV2Revision).toBe(4);
    expect(settingsStore.rulesV2Conflict).toContain('current revision 5');
  });

  test('explicit conflict rebase keeps the draft and permits a deliberate overwrite', async () => {
    const profile = {
      schema_version: 2 as const,
      id: 'local-draft',
      category_set_ids: ['default'],
      sources: [defaultBuiltinWindowSource()],
      active_time: { type: 'expression' as const, rule: { type: 'none' as const } },
    };
    const categorySet = { schema_version: 2 as const, id: 'default', categories: [] };
    settingsStore.$patch({
      _loaded: true,
      _rulesV2Revision: 4,
      _rulesV2Conflict: 'stale revision',
      activity_profiles_v2: [profile],
      category_sets_v2: [categorySet],
    });
    let serverRevision = 5;
    const get = jest.fn().mockResolvedValue({
      data: {
        revision: serverRevision,
        activity_profiles_v2: [{ ...profile, id: 'other-client' }],
        category_sets_v2: [categorySet],
      },
    });
    const post = jest.fn(async (_path: string, value: any) => {
      if (value.revision !== serverRevision) throw new Error('revision conflict');
      serverRevision += 1;
      return { data: { ...value, revision: serverRevision } };
    });
    (getClient as jest.Mock).mockReturnValue({ req: { get, post } });

    await settingsStore.rebaseRulesV2DraftForOverwrite();
    expect(settingsStore.activity_profiles_v2?.[0].id).toBe('local-draft');
    expect(settingsStore.rulesV2Revision).toBe(5);
    expect(settingsStore.rulesV2Conflict).toBe('');

    await settingsStore.saveCanonicalRulesV2({ profiles: [profile], categorySets: [categorySet] });
    expect(post).toHaveBeenCalledWith(
      '/0/settings/rules_v2',
      expect.objectContaining({ revision: 5, activity_profiles_v2: [profile] }),
      expect.anything()
    );
    expect(settingsStore.rulesV2Revision).toBe(6);
  });

  test('canonical saves use one revisioned document request', async () => {
    const post = jest.fn(async (_path: string, value: any) => ({
      data: { ...value, revision: value.revision + 1 },
    }));
    (getClient as jest.Mock).mockReturnValue({
      get_settings: jest.fn().mockResolvedValue({}),
      req: { post, defaults: { timeout: 0 } },
    });
    await settingsStore.saveCanonicalRulesV2({
      profiles: [
        {
          schema_version: 2,
          id: 'default',
          category_set_ids: ['default'],
          sources: [defaultBuiltinWindowSource()],
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

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(
      '/0/settings/rules_v2',
      expect.objectContaining({
        revision: 0,
        activity_profiles_v2: expect.any(Array),
        category_sets_v2: expect.any(Array),
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
    expect(settingsStore.rulesV2Revision).toBe(1);
  });

  test('canonical expression saves update the local derived legacy projection', async () => {
    settingsStore.$patch({ _loaded: true, always_active_pattern: 'stale meeting rule' });
    const post = jest.fn(async (_path: string, value: any) => ({
      data: { ...value, revision: value.revision + 1 },
    }));
    (getClient as jest.Mock).mockReturnValue({
      get_settings: jest.fn().mockResolvedValue({}),
      req: { post, defaults: { timeout: 0 } },
    });
    await settingsStore.saveCanonicalRulesV2({
      profiles: [
        {
          schema_version: 2,
          id: 'default',
          category_set_ids: ['default'],
          sources: [
            {
              id: 'presence',
              label: 'Presence',
              bucket_ids: ['presence'],
              scope: 'global',
              fields: ['state'],
            },
          ],
          active_time: {
            type: 'expression',
            rule: { type: 'regex', source: 'presence', field: 'state', regex: 'active' },
          },
        },
      ],
      categorySets: [{ schema_version: 2, id: 'default', categories: [] }],
    });

    expect(post).toHaveBeenCalledTimes(1);
    expect(settingsStore.always_active_pattern).toBe('');
    expect(settingsStore.classes).toEqual([]);
  });

  test('simplification persists canonical rules through the compatibility save boundary', async () => {
    settingsStore.$patch({
      _loaded: true,
      always_active_pattern: 'stale meeting rule',
      activity_profiles_v2: [
        {
          schema_version: 2,
          id: 'default',
          category_set_ids: ['default'],
          sources: [
            {
              id: 'presence',
              label: 'Presence',
              bucket_ids: ['presence'],
              scope: 'global',
              fields: ['state'],
            },
            defaultBuiltinWindowSource(),
          ],
          active_time: {
            type: 'expression',
            rule: { type: 'regex', source: 'presence', field: 'state', regex: 'active' },
          },
        },
      ],
      category_sets_v2: [
        {
          schema_version: 2,
          id: 'default',
          categories: [
            {
              id: 'work',
              name: ['Work'],
              simple_ui: true,
              rule: { type: 'regex', regex: 'Code' },
            },
          ],
        },
        {
          schema_version: 2,
          id: 'inactive',
          categories: [
            {
              id: 'inactive-rule',
              name: ['Inactive'],
              rule: { type: 'regex', regex: 'keep-inactive' },
            },
          ],
        },
      ],
    });
    const save = jest.spyOn(settingsStore, 'saveCanonicalRulesV2').mockResolvedValue();

    await settingsStore.simplifyRulesV2();

    expect(save).toHaveBeenCalledTimes(1);
    const saved = save.mock.calls[0][0];
    expect(saved.extra).toEqual({ rules_editor_mode: 'simple' });
    expect(saved.profiles[0].active_time).toEqual({
      type: 'legacy',
      use_afk: true,
      include_audible: true,
      always_active_pattern: '',
    });
    expect(saved.categorySets[0].categories[0].rule).toEqual({
      type: 'regex',
      regex: 'Code',
    });
    expect(saved.categorySets[1]).toMatchObject({
      id: 'inactive',
      categories: [{ id: 'inactive-rule', rule: { regex: 'keep-inactive' } }],
    });
  });

  test('simplification follows the selected set rather than array order', async () => {
    const defaults = migrateLegacySettings({ classes: [] });
    settingsStore.$patch({
      _loaded: true,
      activity_profiles_v2: [
        {
          ...defaults.activity_profiles_v2[0],
          category_set_ids: ['selected'],
        },
      ],
      category_sets_v2: [
        {
          schema_version: 2,
          id: 'inactive',
          categories: [
            {
              id: 'inactive-rule',
              name: ['Inactive'],
              simple_ui: true,
              rule: { type: 'regex', regex: 'Inactive' },
            },
          ],
        },
        {
          schema_version: 2,
          id: 'selected',
          categories: [
            {
              id: 'selected-rule',
              name: ['Selected'],
              simple_ui: true,
              rule: { type: 'regex', regex: 'Selected' },
            },
          ],
        },
      ],
    });
    const save = jest.spyOn(settingsStore, 'saveCanonicalRulesV2').mockResolvedValue();

    await settingsStore.simplifyRulesV2();

    const saved = save.mock.calls[0][0];
    expect(saved.profiles[0].category_set_ids).toEqual(['selected']);
    expect(saved.categorySets.find(set => set.id === 'selected').categories[0].rule).toMatchObject({
      regex: 'Selected',
    });
    expect(saved.categorySets.find(set => set.id === 'inactive').categories[0].rule).toMatchObject({
      regex: 'Inactive',
    });
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

    // Window is no longer force-reinjected: a stored profile round-trips unchanged.
    expect(saveMock.mock.calls[0][0].profiles[0].sources).toEqual([
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

    expect(saveMock.mock.calls[0][0].profiles[0].sources).toEqual([...sources]);
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
      { ...baseline[0], label: 'Browser (renamed elsewhere)' },
      draft[1],
    ]);
  });
});
