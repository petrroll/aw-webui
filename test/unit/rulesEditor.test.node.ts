import {
  buildParentRequirementOptions,
  convertRuleExpressionType,
  createDetectedRuleSource,
  createDefaultRuleSource,
  draftMatchesSubmission,
  effectiveSourceFieldTypes,
  formatRulesValidationError,
  formatSourceOwnership,
  hideBuiltinWindowSource,
  persistedRuleValueMode,
  resolveBucketOwnership,
  resetRegexToAutomatic,
  selectorForSourceChange,
  shouldSyncCanonicalDraft,
  shouldSyncEditorDraft,
} from '~/util/rulesEditor';

describe('rules editor state transitions', () => {
  test('does not replace a dirty draft when an older save response arrives', () => {
    expect(shouldSyncEditorDraft(true, true)).toBe(false);
    expect(shouldSyncEditorDraft(true, false)).toBe(true);
    expect(shouldSyncCanonicalDraft(true, true, false)).toBe(false);
    expect(shouldSyncCanonicalDraft(false, true, false)).toBe(true);
    const submitted = JSON.stringify({ type: 'regex', regex: 'Zoom' });
    expect(draftMatchesSubmission({ type: 'regex', regex: 'Zoom' }, submitted)).toBe(true);
    expect(draftMatchesSubmission({ type: 'regex', regex: 'Zoom|Meet' }, submitted)).toBe(false);
  });

  test('exposes builtin window when a source is mandatory', () => {
    const source = {
      id: 'builtin_window',
      label: 'App & window',
      builtin: 'window' as const,
      bucket_ids: [],
      fields: ['app', 'title'],
    };
    expect(hideBuiltinWindowSource(source, false)).toBe(true);
    expect(hideBuiltinWindowSource(source, true)).toBe(false);
  });

  test.each([{ field: 'title' }, { fields: ['title'] }, { select_keys: ['title'] }])(
    'preserves equivalent selector encoding during source changes',
    selector => {
      expect(
        selectorForSourceChange(
          { type: 'regex', source: 'first', regex: 'Match', ...selector },
          ['app', 'title'],
          ['app', 'title']
        )
      ).toEqual(['title']);
    }
  );

  test('displays the persisted value mode rather than inferring from field metadata', () => {
    expect(
      persistedRuleValueMode({
        type: 'regex',
        source: 'browser',
        fields: ['audible'],
        regex: '^true$',
      })
    ).toBe('string');
    expect(
      persistedRuleValueMode({
        type: 'regex',
        source: 'browser',
        fields: ['audible'],
        regex: '^true$',
        value_mode: 'scalar',
      })
    ).toBe('scalar');
  });

  test('knows scalar fields for old builtin browser definitions', () => {
    const types = effectiveSourceFieldTypes({
      id: 'browser',
      label: 'Browser tabs',
      builtin: 'browser',
      bucket_ids: [],
      fields: ['title', 'url', 'audible', 'incognito', 'tabCount'],
    });
    expect(types).toMatchObject({
      title: 'string',
      url: 'string',
      audible: 'scalar',
      incognito: 'scalar',
      tabCount: 'scalar',
    });
  });

  test('partitions selected buckets by authoritative host metadata', () => {
    expect(
      resolveBucketOwnership(
        ['browser_laptop', 'browser_desktop'],
        [
          {
            id: 'browser_laptop',
            hostname: 'Laptop',
            device_id: 'laptop',
            type: 'web.tab.current',
            data: {},
          },
          {
            id: 'browser_desktop',
            hostname: 'Desktop',
            device_id: 'desktop',
            type: 'web.tab.current',
            data: {},
          },
        ]
      )
    ).toEqual({
      bucketHosts: {
        browser_laptop: 'Laptop',
        browser_desktop: 'Desktop',
      },
      unresolved: [],
    });
  });

  test('retains single-bucket ownership and reports unresolved selections', () => {
    expect(
      resolveBucketOwnership(
        ['browser_laptop', 'missing'],
        [
          {
            id: 'browser_laptop',
            hostname: 'Laptop',
            device_id: 'laptop',
            type: 'web.tab.current',
            data: {},
          },
        ]
      )
    ).toEqual({
      bucketHosts: { browser_laptop: 'Laptop' },
      unresolved: ['missing'],
    });
  });

  test('presents both fixed-host source ownership forms', () => {
    const translate = (key: string, values?: Record<string, unknown>) =>
      `${key}:${values?.hosts ?? ''}`;

    expect(formatSourceOwnership({ scope: 'host', host: 'PC-Houskape-20' }, translate)).toBe(
      'settings.categorization.sourceAvailableOn:PC-Houskape-20'
    );
    expect(
      formatSourceOwnership(
        {
          scope: 'host',
          bucket_hosts: { 'browser-laptop': 'Laptop', 'browser-desktop': 'Desktop' },
        },
        translate
      )
    ).toBe('settings.categorization.sourceAvailableOn:Laptop, Desktop');
  });

  test('presents ownerless built-in sources as automatic per-device data', () => {
    const translate = (key: string) => key;
    expect(formatSourceOwnership({ builtin: 'browser' }, translate)).toBe(
      'settings.categorization.sourceAutomaticPerDevice'
    );
  });

  test('converting a regex to an AND group preserves the existing condition', () => {
    expect(
      convertRuleExpressionType({ type: 'regex', regex: 'ActivityWatch', weight: 3 }, 'all')
    ).toEqual({
      type: 'all',
      rules: [{ type: 'regex', regex: 'ActivityWatch', weight: 3 }],
    });
  });

  test('Automatic removes every advanced matching constraint', () => {
    expect(
      resetRegexToAutomatic({
        type: 'regex',
        regex: 'ActivityWatch',
        ignore_case: true,
        source: 'vdesktop',
        fields: ['vdesktop'],
        select_keys: ['invisible-alias'],
        host: 'laptop',
        negate: true,
        weight: 7,
        value_mode: 'scalar',
      })
    ).toEqual({
      type: 'regex',
      regex: 'ActivityWatch',
      ignore_case: true,
    });
  });

  test('parent choices follow pending renames and the selected parent', () => {
    const categories = [
      { id: 'old-parent', name: ['Old'], rule: { type: 'regex' as const, regex: 'old' } },
      { id: 'new-parent', name: ['New'], rule: { type: 'regex' as const, regex: 'new' } },
      {
        id: 'child',
        name: ['Old', 'Child'],
        rule: { type: 'regex' as const, regex: 'child' },
      },
    ];
    const options = buildParentRequirementOptions({
      categories,
      currentPath: ['Renamed', 'Moved child'],
      currentCategoryId: 'child',
      selectedIds: [],
      pendingEdit: category =>
        category.id === 'new-parent'
          ? { name: ['Renamed'], rule: { type: 'regex', regex: 'new' } }
          : undefined,
    });

    expect(options).toEqual([
      {
        value: 'new-parent',
        text: 'Renamed',
        missingRule: false,
        disabled: false,
      },
    ]);
  });

  test('parents without rules are visible but cannot be newly selected', () => {
    const options = buildParentRequirementOptions({
      categories: [
        { id: 'parent', name: ['Work'], rule: { type: 'none' } },
        {
          id: 'child',
          name: ['Work', 'Project'],
          rule: { type: 'regex', regex: 'Project' },
        },
      ],
      currentPath: ['Work', 'Project'],
      currentCategoryId: 'child',
      selectedIds: [],
      pendingEdit: () => undefined,
    });

    expect(options).toEqual([
      {
        value: 'parent',
        text: 'Work',
        missingRule: true,
        disabled: true,
      },
    ]);
  });

  test('new managed sources are usable by category rules', () => {
    const source = createDefaultRuleSource([]);
    expect(source.id).toBe('source-1');
    expect(source).not.toHaveProperty('role');
    expect(source).not.toHaveProperty('activity_mode');
  });

  test('detected sources preserve ownership and unknown-host fallback scope', () => {
    const browser = createDetectedRuleSource({
      id: 'browser',
      label: 'Browser tabs',
      buckets: [
        {
          id: 'browser-laptop',
          hostname: 'Laptop',
          device_id: 'laptop',
          type: 'web.tab.current',
          data: {},
        },
      ],
      fields: ['title', 'url'],
    });
    expect(browser).toMatchObject({
      scope: 'host',
      bucket_hosts: { 'browser-laptop': 'Laptop' },
    });

    const browserWithFallback = createDetectedRuleSource({
      id: 'browser',
      label: 'Browser tabs',
      buckets: [
        {
          id: 'browser-laptop',
          hostname: 'Laptop',
          device_id: 'laptop',
          type: 'web.tab.current',
          data: {},
        },
        {
          id: 'browser-unknown',
          hostname: 'unknown',
          device_id: 'unknown',
          type: 'web.tab.current',
          data: {},
        },
      ],
      fields: ['title', 'url'],
    });
    expect(browserWithFallback.bucket_ids).toEqual(['browser-laptop']);
    expect(browserWithFallback).toMatchObject({
      scope: 'host',
      bucket_hosts: { 'browser-laptop': 'Laptop' },
    });

    const stopwatch = createDetectedRuleSource({
      id: 'stopwatch',
      label: 'Stopwatch',
      buckets: [
        {
          id: 'aw-stopwatch',
          hostname: 'unknown',
          device_id: 'unknown',
          type: 'general.stopwatch',
          data: {},
        },
      ],
      fields: ['label'],
      createsActivity: true,
    });
    expect(stopwatch).toMatchObject({ scope: 'global', creates_activity: true });
    expect(stopwatch).not.toHaveProperty('bucket_hosts');
  });

  test('formats source validation errors with the user-facing source label', () => {
    const translate = (key: string, values?: Record<string, unknown>) =>
      `${key}:${values?.source ?? ''}`;
    const source = {
      id: 'meeting',
      label: 'Meetings',
      bucket_ids: [],
      scope: 'host' as const,
      bucket_hosts: {},
      fields: [],
    };

    expect(
      formatRulesValidationError('sources[0].fields must be non-empty', [source], translate)
    ).toBe('settings.categorization.validationSourceFieldsRequired:Meetings');
  });

  test('formats unknown source references without exposing validation paths', () => {
    const translate = (key: string, values?: Record<string, unknown>) =>
      `${key}:${values?.source ?? ''}`;

    expect(
      formatRulesValidationError(
        'active_time.rule references unknown source presence',
        [],
        translate
      )
    ).toBe('settings.categorization.ruleUnknownSource:presence');
  });
});
