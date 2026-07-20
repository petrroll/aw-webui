import {
  buildParentRequirementOptions,
  convertRuleExpressionType,
  createDetectedRuleSource,
  createDefaultRuleSource,
  formatRulesValidationError,
  resolveBucketOwnership,
  resetRegexToAutomatic,
} from '~/util/rulesEditor';

describe('rules editor state transitions', () => {
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
      formatRulesValidationError(
        'sources[0].fields must be non-empty',
        [source],
        translate
      )
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
