import {
  BUILTIN_WINDOW_SOURCE_ID,
  applyRulesSimplification,
  categorySetToLegacyClasses,
  compileProfileQueryOptions,
  computeRulesSimplificationLosses,
  defaultBuiltinBrowserSource,
  defaultBuiltinSources,
  defaultBuiltinStopwatchSource,
  defaultBuiltinWindowSource,
  deleteCategoryRuleV2,
  inferRulesEditorMode,
  initializeProfileSourceDefaults,
  isLegacyCompatibleRuleV2,
  legacyRuleToV2,
  migrateLegacySettings,
  resolveRulesV2Settings,
  synchronizeCategoryTreeV2,
  updateCategoryRuleV2,
  validateActivityProfile,
  validateCategorySet,
  validateProfileRulesV2,
  v2RuleToLegacy,
} from '~/util/rulesV2';
import type { RuleExpressionV2 } from '~/util/rulesV2';

describe('rules v2 migration', () => {
  test('migrates legacy rules with zero weight and field compatibility', () => {
    expect(
      legacyRuleToV2({
        type: 'regex',
        regex: 'devenv',
        ignore_case: true,
        select_keys: ['app', 'title'],
      })
    ).toEqual({
      type: 'regex',
      regex: 'devenv',
      ignore_case: true,
      fields: ['app', 'title'],
      weight: 0,
    });
  });

  test('creates an in-memory legacy-equivalent default profile', () => {
    const migrated = migrateLegacySettings({
      classes: [{ name: ['Work'], rule: { type: 'regex', regex: 'devenv' } }],
      always_active_pattern: 'Teams',
    });

    expect(migrated.category_sets_v2[0].categories[0].rule).toEqual({
      type: 'regex',
      regex: 'devenv',
      weight: 0,
    });
    expect(migrated.category_sets_v2[0].categories[0].simple_ui).toBe(true);
    expect(migrated.activity_profiles_v2[0].active_time).toEqual({
      type: 'legacy',
      use_afk: true,
      include_audible: true,
      always_active_pattern: 'Teams',
    });
    expect(migrated.activity_profiles_v2[0].sources).toEqual(defaultBuiltinSources());
    expect(migrated.activity_profiles_v2[0]).toMatchObject({
      source_defaults_version: 3,
      app_title_source_id: BUILTIN_WINDOW_SOURCE_ID,
      browser_focus_source_id: BUILTIN_WINDOW_SOURCE_ID,
    });
  });

  test('always migrates legacy classes into the stable default set', () => {
    const migrated = migrateLegacySettings({
      classes: [{ name: ['Work'], rule: { type: 'none' } }],
    });

    expect(migrated.activity_profiles_v2[0].category_set_ids).toEqual(['default']);
    expect(migrated.category_sets_v2).toHaveLength(1);
    expect(migrated.category_sets_v2[0].id).toBe('default');
    expect(migrated.category_sets_v2[0].categories[0].id).toBe('default:Work');
  });

  test('initializes built-in sources once while preserving explicit choices', () => {
    const profile = {
      schema_version: 2 as const,
      id: 'default',
      category_set_ids: ['default'],
      sources: [],
      active_time: {
        type: 'legacy' as const,
        use_afk: true,
        include_audible: true,
        always_active_pattern: '',
      },
    };

    expect(initializeProfileSourceDefaults([profile])[0]).toMatchObject({
      source_defaults_version: 3,
      sources: defaultBuiltinSources(),
      app_title_source_id: BUILTIN_WINDOW_SOURCE_ID,
      browser_focus_source_id: BUILTIN_WINDOW_SOURCE_ID,
    });
    expect(
      initializeProfileSourceDefaults([
        {
          ...profile,
          sources: [defaultBuiltinWindowSource(false)],
        },
      ])[0]
    ).toMatchObject({
      source_defaults_version: 3,
      sources: [
        defaultBuiltinWindowSource(false),
        defaultBuiltinBrowserSource(),
        defaultBuiltinStopwatchSource(),
      ],
    });
    expect(
      initializeProfileSourceDefaults([
        {
          ...profile,
          source_defaults_version: 3,
        },
      ])[0].sources
    ).toEqual([]);
  });

  test('does not enable keeps_active on a disabled stopwatch source', () => {
    const stopwatch = defaultBuiltinStopwatchSource();
    delete stopwatch.creates_activity;
    delete stopwatch.keeps_active;
    const profile = {
      schema_version: 2 as const,
      source_defaults_version: 2,
      id: 'default',
      category_set_ids: ['default'],
      sources: [stopwatch],
      active_time: {
        type: 'legacy' as const,
        use_afk: true,
        include_audible: true,
        always_active_pattern: '',
      },
    };
    const migrated = initializeProfileSourceDefaults([profile])[0];

    expect(migrated.sources[0]).not.toHaveProperty('keeps_active');
    expect(migrated.source_defaults_version).toBe(3);
  });

  test('preserves persisted sets when creating a default profile', () => {
    const persistedSets = [
      {
        schema_version: 2 as const,
        id: 'advanced',
        categories: [],
      },
      {
        schema_version: 2 as const,
        id: 'ignored',
        categories: [],
      },
    ];
    const resolved = resolveRulesV2Settings({
      activity_profiles_v2: null,
      category_sets_v2: persistedSets,
      classes: [{ name: ['Legacy'], rule: { type: 'none' } }],
    });

    expect(resolved.category_sets_v2).toEqual(persistedSets);
    expect(resolved.activity_profiles_v2[0].id).toBe('default');
    expect(resolved.activity_profiles_v2[0].category_set_ids).toEqual(['advanced']);
    expect(resolved.migrated).toBe(true);
  });

  test('resolves persisted profiles without sets to the migrated default set', () => {
    const resolved = resolveRulesV2Settings({
      activity_profiles_v2: [
        {
          schema_version: 2,
          id: 'default',
          category_set_ids: ['work', 'personal'],
          sources: [],
          active_time: {
            type: 'legacy',
            use_afk: true,
            include_audible: true,
            always_active_pattern: '',
          },
        },
      ],
      category_sets_v2: null,
      classes: [{ name: ['Legacy'], rule: { type: 'none' } }],
    });

    expect(resolved.category_sets_v2).toHaveLength(1);
    expect(resolved.category_sets_v2[0].id).toBe('default');
    expect(resolved.category_sets_v2[0].categories[0].name).toEqual(['Legacy']);
    expect(resolved.activity_profiles_v2[0].category_set_ids).toEqual(['default']);
  });

  test('normalizes the selected profile and set without dropping the others', () => {
    const resolved = resolveRulesV2Settings({
      activity_profiles_v2: [
        {
          schema_version: 2,
          id: 'selected',
          category_set_ids: ['selected'],
          sources: [],
          active_time: {
            type: 'legacy',
            use_afk: true,
            include_audible: true,
            always_active_pattern: '',
          },
        },
        {
          schema_version: 2,
          id: 'ignored',
          category_set_ids: ['ignored'],
          sources: [],
          active_time: {
            type: 'legacy',
            use_afk: true,
            include_audible: true,
            always_active_pattern: '',
          },
        },
      ],
      category_sets_v2: [
        { schema_version: 2, id: 'ignored', categories: [] },
        { schema_version: 2, id: 'selected', categories: [] },
      ],
      classes: [],
    });

    expect(resolved.activity_profiles_v2).toHaveLength(2);
    expect(resolved.activity_profiles_v2[0].id).toBe('selected');
    expect(resolved.activity_profiles_v2[0].category_set_ids).toEqual(['selected']);
    expect(resolved.activity_profiles_v2[1].id).toBe('ignored');
    expect(resolved.category_sets_v2.map(set => set.id)).toEqual(['selected', 'ignored']);
  });

  test('normalizes old v2 categories without a simple UI marker', () => {
    const resolved = resolveRulesV2Settings({
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
      category_sets_v2: [
        {
          schema_version: 2,
          id: 'default',
          categories: [
            { id: 'simple', name: ['Simple'], rule: { type: 'regex', regex: 'code' } },
            {
              id: 'advanced',
              name: ['Advanced'],
              rule: { type: 'regex', regex: 'code', source: 'window' },
            },
          ],
        },
      ],
      classes: [],
    });

    expect(resolved.category_sets_v2[0].categories.map(category => category.simple_ui)).toEqual([
      true,
      false,
    ]);
  });

  test('does not reinject the default window source into a stored profile that omits it', () => {
    const resolved = resolveRulesV2Settings({
      activity_profiles_v2: [
        {
          schema_version: 2,
          id: 'default',
          category_set_ids: ['default'],
          sources: [
            {
              id: 'meeting',
              label: 'Meeting',
              bucket_ids: ['aw-watcher-meeting_desktop'],
              bucket_hosts: { 'aw-watcher-meeting_desktop': 'desktop' },
              scope: 'host',
              fields: ['subject'],
              creates_activity: true,
            },
          ],
          active_time: {
            type: 'expression',
            rule: { type: 'regex', source: 'meeting', field: 'subject', regex: '.' },
          },
        },
      ],
      category_sets_v2: [{ schema_version: 2, id: 'default', categories: [] }],
      classes: [],
    });

    const sources = resolved.activity_profiles_v2[0].sources;
    // Advanced profiles may remove the default window source; it must round-trip
    // without being force-reinjected on load.
    expect(sources.some(source => source.builtin === 'window')).toBe(false);
    expect(sources.map(source => source.id)).toEqual(['meeting']);
  });

  test('moves generated watcher host scope to bucket metadata', () => {
    const resolved = resolveRulesV2Settings({
      activity_profiles_v2: [
        {
          schema_version: 2,
          id: 'default',
          category_set_ids: ['default'],
          sources: [
            {
              id: 'vdesktop',
              label: 'Virtual desktop — desktop only',
              bucket_ids: ['aw-watcher-vdesktop_desktop'],
              fields: ['desktop'],
              auto_generated: true,
              host: 'desktop',
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
      classes: [],
    });

    expect(
      resolved.activity_profiles_v2[0].sources.find(source => source.id === 'vdesktop')
    ).toMatchObject({
      scope: 'host',
      bucket_hosts: { 'aw-watcher-vdesktop_desktop': 'desktop' },
    });
  });

  test('migrates source roles to optional activity behavior', () => {
    const resolved = resolveRulesV2Settings({
      activity_profiles_v2: [
        {
          schema_version: 2,
          id: 'default',
          category_set_ids: ['default'],
          sources: [
            {
              id: 'context',
              label: 'Context',
              bucket_ids: ['context'],
              scope: 'global',
              fields: ['value'],
              role: 'context',
            },
            {
              id: 'active',
              label: 'Active time',
              bucket_ids: ['active'],
              scope: 'global',
              fields: ['status'],
              role: 'active-mask',
            },
            {
              id: 'replacement',
              label: 'Replacement',
              bucket_ids: ['replacement'],
              scope: 'global',
              fields: ['title'],
              role: 'activity',
            },
            {
              id: 'background',
              label: 'Background',
              bucket_ids: ['background'],
              scope: 'global',
              fields: ['title'],
              role: 'background',
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
      classes: [],
    });

    const sources = resolved.activity_profiles_v2[0].sources.filter(source => !source.builtin);
    expect(sources[0]).not.toHaveProperty('role');
    expect(sources[0]).not.toHaveProperty('activity_mode');
    expect(sources[1]).not.toHaveProperty('role');
    expect(sources[1]).not.toHaveProperty('activity_mode');
    expect(sources[2]).toMatchObject({ id: 'replacement', creates_activity: true });
    expect(sources[2]).not.toHaveProperty('role');
    expect(sources[2]).not.toHaveProperty('activity_mode');
    expect(sources[2]).not.toHaveProperty('priority');
    expect(sources[3]).toMatchObject({ id: 'background', creates_activity: true });
    expect(sources[3]).not.toHaveProperty('role');
    expect(sources[3]).not.toHaveProperty('activity_mode');
    expect(sources[0].host).toBeUndefined();
  });
});

describe('rules v2 editing', () => {
  const profile = {
    schema_version: 2 as const,
    id: 'default',
    category_set_ids: ['default'],
    sources: [defaultBuiltinWindowSource()],
    active_time: {
      type: 'legacy' as const,
      use_afk: true,
      include_audible: true,
      always_active_pattern: '',
    },
  };

  test('updates and renames an existing category without mutating input', () => {
    const categorySets = [
      {
        schema_version: 2 as const,
        id: 'default',
        categories: [
          { id: 'work', name: ['Work'], rule: { type: 'none' as const } },
          { id: 'coding', name: ['Work', 'Coding'], rule: { type: 'none' as const } },
        ],
      },
    ];
    const updated = updateCategoryRuleV2({
      profileId: 'default',
      profiles: [profile],
      categorySets,
      originalName: ['Work'],
      name: ['Professional'],
      rule: { type: 'regex', source: 'window', field: 'app', regex: 'code', weight: 4 },
      priority: 2,
      requires: ['parent'],
    });

    expect(categorySets[0].categories[0].name).toEqual(['Work']);
    expect(updated.categorySets[0].categories[0]).toMatchObject({
      id: 'work',
      name: ['Professional'],
      priority: 2,
      requires: ['parent'],
      rule: { type: 'regex', source: 'window', field: 'app', regex: 'code', weight: 4 },
      simple_ui: false,
    });
    expect(updated.categorySets[0].categories[1].name).toEqual(['Professional', 'Coding']);
  });

  test('deletes a persisted v2 category', () => {
    const updated = deleteCategoryRuleV2({
      profileId: 'default',
      profiles: [profile],
      categorySets: [
        {
          schema_version: 2,
          id: 'default',
          categories: [
            { id: 'work', name: ['Work'], rule: { type: 'none' } },
            { id: 'personal', name: ['Personal'], rule: { type: 'none' } },
          ],
        },
      ],
      name: ['Work'],
    });

    expect(updated.categorySets[0].categories.map(category => category.id)).toEqual(['personal']);
  });

  test('rejects deleting a category required by another rule', () => {
    expect(() =>
      deleteCategoryRuleV2({
        profileId: 'default',
        profiles: [profile],
        categorySets: [
          {
            schema_version: 2,
            id: 'default',
            categories: [
              { id: 'parent', name: ['Work'], rule: { type: 'none' } },
              {
                id: 'child',
                name: ['Work', 'Code'],
                requires: ['parent'],
                rule: { type: 'none' },
              },
            ],
          },
        ],
        categoryId: 'parent',
        name: ['Work'],
      })
    ).toThrow('required by Work > Code');
  });

  test('identifies rules that can stay synchronized with the simple editor', () => {
    expect(isLegacyCompatibleRuleV2({ type: 'regex', regex: 'code', weight: 0 })).toBe(true);
    expect(isLegacyCompatibleRuleV2({ type: 'regex', regex: 'code', source: 'window' })).toBe(
      false
    );
    expect(isLegacyCompatibleRuleV2({ type: 'regex', regex: 'code', host: 'workstation' })).toBe(
      false
    );
    expect(isLegacyCompatibleRuleV2({ type: 'any', rules: [] })).toBe(false);
    expect(
      v2RuleToLegacy({
        type: 'regex',
        regex: 'code',
        ignore_case: true,
        fields: ['app', 'title'],
        weight: 0,
      })
    ).toEqual({
      type: 'regex',
      regex: 'code',
      ignore_case: true,
      select_keys: ['app', 'title'],
    });
  });

  test('creates a v2 category when editing a newly-added legacy category', () => {
    const updated = updateCategoryRuleV2({
      profileId: 'default',
      profiles: [profile],
      categorySets: [{ schema_version: 2, id: 'default', categories: [] }],
      originalName: ['New'],
      name: ['New'],
      rule: { type: 'any', rules: [{ type: 'regex', regex: 'one' }] },
      priority: 0,
      requires: [],
    });

    expect(updated.categorySets[0].categories[0]).toMatchObject({
      name: ['New'],
      rule: { type: 'any', rules: [{ type: 'regex', regex: 'one' }] },
      simple_ui: false,
    });
  });

  test('automatically marks structurally simple advanced edits for the simple UI', () => {
    const updated = updateCategoryRuleV2({
      profileId: 'default',
      profiles: [profile],
      categorySets: [{ schema_version: 2, id: 'default', categories: [] }],
      originalName: ['New'],
      name: ['New'],
      rule: { type: 'regex', regex: 'code', weight: 0 },
      priority: 0,
      requires: [],
    });

    expect(updated.categorySets[0].categories[0].simple_ui).toBe(true);
  });

  test('explicit legacy replacement resets matching advanced rules', () => {
    const synchronized = synchronizeCategoryTreeV2({
      profileId: 'default',
      profiles: [profile],
      categorySets: [
        {
          schema_version: 2,
          id: 'default',
          categories: [
            {
              id: 'work',
              name: ['Work'],
              rule: {
                type: 'all',
                rules: [
                  { type: 'regex', regex: 'code' },
                  { type: 'regex', regex: 'project' },
                ],
              },
              priority: 5,
              requires: ['parent'],
              simple_ui: false,
            },
          ],
        },
      ],
      classes: [{ name: ['Work'], rule: { type: 'regex', regex: 'replacement' } }],
      replaceRules: true,
    });

    expect(synchronized.categorySets[0].categories[0]).toMatchObject({
      id: 'work',
      rule: { type: 'regex', regex: 'replacement', weight: 0 },
      priority: 0,
      requires: [],
      simple_ui: true,
    });
  });
});

describe('rules v2 validation', () => {
  test('reports invalid groups and missing requirements', () => {
    const errors = validateCategorySet({
      schema_version: 2,
      id: 'default',
      categories: [
        {
          id: 'child',
          name: ['Work'],
          requires: ['missing'],
          rule: { type: 'all', rules: [] },
        },
      ],
    });

    expect(errors).toContain('categories[0].rule.rules must contain at least one rule');
    expect(errors).toContain('categories[0].requires references unknown id missing');
  });

  test('rejects requirements that can never match', () => {
    const errors = validateCategorySet({
      schema_version: 2,
      id: 'default',
      categories: [
        { id: 'parent', name: ['Work'], rule: { type: 'none' } },
        {
          id: 'child',
          name: ['Work', 'Project'],
          requires: ['parent'],
          rule: { type: 'regex', regex: 'Project' },
        },
      ],
    });

    expect(errors).toContain(
      'categories[1].requires references category without a matching rule parent'
    );
  });

  test('reports unknown active-time sources', () => {
    const profileErrors = validateActivityProfile(
      {
        schema_version: 2,
        id: 'default',
        category_set_ids: ['default'],
        sources: [],
        active_time: {
          type: 'expression',
          rule: { type: 'regex', source: 'meeting', field: 'title', regex: 'Teams' },
        },
      },
      new Set(['default'])
    );

    expect(profileErrors).toContain('active_time.rule references unknown source meeting');
  });

  test('requires sources on active-time regex nodes', () => {
    const profileErrors = validateActivityProfile(
      {
        schema_version: 2,
        id: 'default',
        category_set_ids: ['default'],
        sources: [],
        active_time: {
          type: 'expression',
          rule: { type: 'regex', field: 'title', regex: 'Teams' },
        },
      },
      new Set(['default'])
    );

    expect(profileErrors).toContain('active_time.rule.source must be non-empty');
  });

  test('reports category references to removed sources', () => {
    const errors = validateProfileRulesV2(
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
      [
        {
          schema_version: 2,
          id: 'default',
          categories: [
            {
              id: 'meeting',
              name: ['Meeting'],
              rule: { type: 'regex', source: 'meeting', field: 'title', regex: 'Teams' },
            },
          ],
        },
      ]
    );

    expect(errors).toContain('category meeting references unknown source meeting');
  });

  test('reports invalid regexes and non-integer priorities', () => {
    const errors = validateCategorySet({
      schema_version: 2,
      id: 'default',
      categories: [
        {
          id: 'broken',
          name: ['Broken'],
          priority: 1.5,
          rule: { type: 'regex', regex: '[' },
        },
      ],
    });

    expect(errors).toContain('categories[0].priority must be an integer');
    expect(errors).toContain('categories[0].rule.regex is invalid');
  });

  test('rejects a simple UI marker on an incompatible category', () => {
    const errors = validateCategorySet({
      schema_version: 2,
      id: 'default',
      categories: [
        {
          id: 'advanced',
          name: ['Advanced'],
          simple_ui: true,
          priority: 2,
          rule: { type: 'regex', regex: 'code', source: 'window' },
        },
      ],
    });

    expect(errors).toContain(
      'categories[0].simple_ui is true but the category is not simple-compatible'
    );
  });

  describe('rules editor mode and simplification', () => {
    const profile = {
      schema_version: 2 as const,
      id: 'default',
      category_set_ids: ['default'],
      sources: [
        {
          id: 'calendar',
          label: 'Work calendar',
          bucket_ids: ['calendar'],
          fields: ['subject'],
          activity_mode: 'replace' as const,
        },
      ],
      active_time: {
        type: 'expression' as const,
        rule: { type: 'regex' as const, regex: 'Meeting', source: 'calendar', field: 'subject' },
      },
    };
    const categorySet = {
      schema_version: 2 as const,
      id: 'default',
      categories: [
        {
          id: 'simple',
          name: ['Work'],
          simple_ui: true,
          rule: { type: 'regex' as const, regex: 'code', weight: 0 },
          data: { color: '#123456', score: 1 },
        },
        {
          id: 'advanced',
          name: ['Work', 'Meeting'],
          simple_ui: false,
          priority: 5,
          requires: ['simple'],
          rule: {
            type: 'regex' as const,
            regex: 'Meeting',
            source: 'calendar',
            field: 'subject',
          },
        },
      ],
    };

    test('infers advanced mode for non-simple canonical configuration', () => {
      expect(inferRulesEditorMode(profile, categorySet)).toBe('advanced');
      const simpleProfile = {
        ...profile,
        sources: defaultBuiltinSources(),
        app_title_source_id: BUILTIN_WINDOW_SOURCE_ID,
        browser_focus_source_id: BUILTIN_WINDOW_SOURCE_ID,
        active_time: {
          type: 'legacy' as const,
          use_afk: true,
          include_audible: true,
          always_active_pattern: '',
        },
      };
      expect(
        inferRulesEditorMode(simpleProfile, {
          ...categorySet,
          categories: [categorySet.categories[0]],
        })
      ).toBe('simple');
      expect(
        inferRulesEditorMode(
          { ...simpleProfile, sources: [] },
          { ...categorySet, categories: [categorySet.categories[0]] }
        )
      ).toBe('advanced');
      expect(
        inferRulesEditorMode(
          {
            ...simpleProfile,
            sources: [
              {
                ...defaultBuiltinWindowSource(),
                bucket_ids: ['window'],
                scope: 'global',
              },
              ...defaultBuiltinSources().slice(1),
            ],
          },
          { ...categorySet, categories: [categorySet.categories[0]] }
        )
      ).toBe('advanced');
    });

    test('reports exact simplification losses before mutation', () => {
      expect(computeRulesSimplificationLosses(profile, categorySet)).toEqual({
        categories: [
          {
            id: 'advanced',
            path: 'Work > Meeting',
            reasons: ['rule', 'priority', 'prerequisites'],
          },
        ],
        active_time: {
          type: 'regex',
          regex: 'Meeting',
          source: 'calendar',
          field: 'subject',
        },
        sources: [{ id: 'calendar', label: 'Work calendar' }],
      });
    });

    test('simplifies canonical rules and regenerates the legacy projection', () => {
      const simplified = applyRulesSimplification({
        profile,
        categorySet,
        always_active_pattern: 'Teams',
      });

      expect(simplified.activity_profiles_v2[0]).toMatchObject({
        sources: defaultBuiltinSources(),
        active_time: {
          type: 'legacy',
          use_afk: true,
          include_audible: true,
          always_active_pattern: 'Teams',
        },
      });
      expect(simplified.category_sets_v2[0].categories[1]).toEqual({
        id: 'advanced',
        name: ['Work', 'Meeting'],
        simple_ui: true,
        rule: { type: 'none' },
      });
      expect(simplified.category_sets_v2[0].categories[0].data).toEqual({
        color: '#123456',
        score: 1,
      });
      expect(categorySetToLegacyClasses(simplified.category_sets_v2[0])).toEqual(
        simplified.classes
      );
      expect(simplified.classes[1].rule).toEqual({ type: 'none' });
    });

    test('does not claim an advanced rule has equivalent legacy semantics', () => {
      expect(
        categorySetToLegacyClasses({
          schema_version: 2,
          id: 'default',
          categories: [
            {
              id: 'meeting',
              name: ['Work', 'Meeting'],
              rule: {
                type: 'regex',
                source: 'calendar',
                field: 'subject',
                regex: 'Standup',
              },
              legacy_rule: {
                type: 'regex',
                regex: 'Teams',
                select_keys: ['app'],
              },
            },
          ],
        })
      ).toEqual([
        {
          name: ['Work', 'Meeting'],
          rule: { type: 'none' },
        },
      ]);
    });
  });

  test('reports expressions that exceed safety limits', () => {
    let nested: RuleExpressionV2 = { type: 'regex', regex: 'test' };
    for (let index = 0; index < 32; index++) {
      nested = { type: 'all', rules: [nested] };
    }
    const errors = validateCategorySet({
      schema_version: 2,
      id: 'default',
      categories: [
        { id: 'deep', name: ['Deep'], rule: nested },
        {
          id: 'long',
          name: ['Long'],
          rule: { type: 'regex', regex: 'x'.repeat(4097) },
        },
      ],
    });

    expect(errors.some(error => error.includes('maximum depth'))).toBe(true);
    expect(errors.some(error => error.includes('maximum length'))).toBe(true);
  });

  test('reports requirement cycles and invalid profile references', () => {
    const categoryErrors = validateCategorySet({
      schema_version: 2,
      id: 'default',
      categories: [
        { id: 'a', name: ['A'], requires: ['b'], rule: { type: 'none' } },
        { id: 'b', name: ['B'], requires: ['a'], rule: { type: 'none' } },
      ],
    });

    const profileErrors = validateActivityProfile(
      {
        schema_version: 2,
        id: 'default',
        category_set_ids: ['missing'],
        sources: [],
        active_time: { type: 'expression', rule: { type: 'all', rules: [] } },
      },
      new Set(['default'])
    );

    expect(categoryErrors.some(error => error.includes('cycle'))).toBe(true);
    expect(profileErrors).toContain('activity profile references unknown category set missing');
    expect(profileErrors).toContain('active_time.rule.rules must contain at least one rule');
  });

  test('rejects selecting multiple category sets while preserving inactive sets', () => {
    const profile = {
      schema_version: 2 as const,
      id: 'default',
      category_set_ids: ['primary', 'secondary'],
      sources: [],
      active_time: {
        type: 'legacy' as const,
        use_afk: true,
        include_audible: true,
        always_active_pattern: '',
      },
    };
    const sets = [
      { schema_version: 2 as const, id: 'primary', categories: [] },
      { schema_version: 2 as const, id: 'secondary', categories: [] },
    ];

    expect(validateActivityProfile(profile, new Set(['primary', 'secondary']))).toContain(
      'activity profile must select exactly one category set'
    );
    expect(validateProfileRulesV2(profile, sets)).not.toContain(
      'exactly one category set must be configured'
    );
  });

  test('rejects context sources without fields', () => {
    const errors = validateActivityProfile(
      {
        schema_version: 2,
        id: 'default',
        category_set_ids: ['default'],
        sources: [
          {
            id: 'context',
            label: 'Context',
            bucket_ids: ['context_bucket'],
            fields: [],
          },
        ],
        active_time: {
          type: 'legacy',
          use_afk: true,
          include_audible: true,
          always_active_pattern: '',
        },
      },
      new Set(['default'])
    );

    expect(errors).toContain('sources[0].fields must be non-empty');
  });

  test('rejects an empty active-time expression', () => {
    const errors = validateActivityProfile(
      {
        schema_version: 2,
        id: 'default',
        category_set_ids: ['default'],
        sources: [],
        active_time: {
          type: 'expression',
          rule: { type: 'none' },
        },
      },
      new Set(['default'])
    );

    expect(errors).toContain('active_time.rule must contain at least one matching condition');
  });

  test('rejects incomplete bucket host mappings', () => {
    const errors = validateActivityProfile(
      {
        schema_version: 2,
        id: 'default',
        category_set_ids: ['default'],
        sources: [
          {
            id: 'context',
            label: 'Context',
            bucket_ids: ['context_work', 'context_home'],
            bucket_hosts: { context_work: 'work' },
            fields: ['title'],
          },
        ],
        active_time: {
          type: 'legacy',
          use_afk: true,
          include_audible: true,
          always_active_pattern: '',
        },
      },
      new Set(['default'])
    );

    expect(errors).toContain('sources[0].bucket_hosts is invalid');
  });

  test('rejects missing ownership instead of treating a source as global', () => {
    const errors = validateActivityProfile(
      {
        schema_version: 2,
        id: 'default',
        category_set_ids: ['default'],
        sources: [
          {
            id: 'browser',
            label: 'Browser',
            bucket_ids: ['browser_laptop'],
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
      new Set(['default'])
    );

    expect(errors).toContain('sources[0].scope must be explicit');
  });

  test('accepts an intentionally global source without ownership metadata', () => {
    const errors = validateActivityProfile(
      {
        schema_version: 2,
        id: 'default',
        category_set_ids: ['default'],
        sources: [
          {
            id: 'calendar',
            label: 'Global calendar',
            bucket_ids: ['calendar'],
            scope: 'global',
            fields: ['meeting'],
          },
        ],
        active_time: {
          type: 'legacy',
          use_afk: true,
          include_audible: true,
          always_active_pattern: '',
        },
      },
      new Set(['default'])
    );

    expect(errors).toEqual([]);
  });

  test('allows activity sources in category predicates', () => {
    const errors = validateProfileRulesV2(
      {
        schema_version: 2,
        id: 'default',
        category_set_ids: ['default'],
        sources: [
          {
            id: 'meeting',
            label: 'Meeting',
            bucket_ids: ['meeting'],
            fields: ['subject'],
            activity_mode: 'replace',
            scope: 'global',
          },
        ],
        active_time: {
          type: 'legacy',
          use_afk: true,
          include_audible: true,
          always_active_pattern: '',
        },
      },
      [
        {
          schema_version: 2,
          id: 'default',
          categories: [
            {
              id: 'meeting',
              name: ['Meeting'],
              rule: { type: 'regex', regex: 'Standup', source: 'meeting' },
            },
          ],
        },
      ]
    );

    expect(errors).toEqual([]);
  });

  test('allows background sources in category predicates', () => {
    const errors = validateProfileRulesV2(
      {
        schema_version: 2,
        id: 'default',
        category_set_ids: ['default'],
        sources: [
          {
            id: 'desktop',
            label: 'Virtual desktop',
            bucket_ids: ['desktop'],
            fields: ['vdesktop'],
            activity_mode: 'fill-gaps',
            scope: 'global',
          },
        ],
        active_time: {
          type: 'legacy',
          use_afk: true,
          include_audible: true,
          always_active_pattern: '',
        },
      },
      [
        {
          schema_version: 2,
          id: 'default',
          categories: [
            {
              id: 'personal',
              name: ['Personal'],
              rule: { type: 'regex', regex: 'Personal', source: 'desktop' },
            },
          ],
        },
      ]
    );

    expect(errors).toEqual([]);
  });
});

describe('v2 profile compiler', () => {
  const capabilities = [
    'query.categorize_v2.v1',
    'query.merge_subwatcher_fields.source_namespace.v1',
    'query.active_periods_v2.v1',
    'query.map_event_fields.v1',
  ];

  test('compiles the single configured category set without merging', () => {
    const options = compileProfileQueryOptions(
      {
        schema_version: 2,
        id: 'default',
        category_set_ids: ['default'],
        sources: defaultBuiltinSources(),
        active_time: {
          type: 'legacy',
          use_afk: true,
          include_audible: true,
          always_active_pattern: '',
        },
      },
      [
        {
          schema_version: 2,
          id: 'default',
          categories: [
            { id: 'work', name: ['Work'], rule: { type: 'regex', regex: 'Work' } },
            {
              id: 'child',
              name: ['Work', 'Project'],
              requires: ['work'],
              rule: { type: 'regex', regex: 'Project', weight: 0 },
            },
          ],
        },
      ],
      capabilities
    );

    expect(options.category_specs.map(category => category.id)).toEqual(['work', 'child']);
    expect(options.category_specs[1].requires).toEqual(['work']);
    expect(options.category_specs[1]).not.toHaveProperty('legacy_rule');
    expect(options.category_specs[1]).not.toHaveProperty('simple_ui');
    expect(options.category_specs[1]).not.toHaveProperty('data');
    expect(options.legacy_window_mode).toBe('activity');
    expect(options.legacy_window_fields).toEqual(['app', 'title']);
  });

  test('compiles only the selected category set while preserving inactive sets', () => {
    const options = compileProfileQueryOptions(
      {
        schema_version: 2,
        id: 'default',
        category_set_ids: ['selected'],
        sources: [],
        active_time: {
          type: 'legacy',
          use_afk: true,
          include_audible: true,
          always_active_pattern: '',
        },
      },
      [
        {
          schema_version: 2,
          id: 'inactive',
          categories: [{ id: 'inactive', name: ['Inactive'], rule: { type: 'none' } }],
        },
        {
          schema_version: 2,
          id: 'selected',
          categories: [{ id: 'selected', name: ['Selected'], rule: { type: 'none' } }],
        },
      ],
      capabilities
    );

    expect(options.category_specs.map(category => category.id)).toEqual(['selected']);
  });

  test('compiles adjustable built-in window fields and activity behavior', () => {
    const options = compileProfileQueryOptions(
      {
        schema_version: 2,
        id: 'default',
        category_set_ids: ['default'],
        sources: [
          {
            ...defaultBuiltinWindowSource(false),
            fields: ['title'],
          },
        ],
        active_time: {
          type: 'legacy',
          use_afk: true,
          include_audible: true,
          always_active_pattern: '',
        },
      },
      [
        {
          schema_version: 2,
          id: 'default',
          categories: [
            { id: 'work', name: ['Work'], rule: { type: 'regex', regex: 'Work' } },
          ],
        },
      ],
      capabilities
    );

    expect(options.legacy_window_mode).toBe('context');
    expect(options.legacy_window_fields).toEqual(['title']);
    expect(options.activity_coverage_sources).toEqual([]);
  });

  test('removes implicit window activity from fully explicit advanced profiles', () => {
    const options = compileProfileQueryOptions(
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
            creates_activity: true,
          },
        ],
        active_time: {
          type: 'expression',
          rule: { type: 'regex', source: 'presence', field: 'state', regex: 'active' },
        },
      },
      [
        {
          schema_version: 2,
          id: 'default',
          categories: [
            {
              id: 'present',
              name: ['Present'],
              simple_ui: false,
              rule: { type: 'regex', source: 'presence', field: 'state', regex: 'active' },
            },
          ],
        },
      ],
      capabilities
    );

    // A fully explicit (meeting/presence-only) profile has no window privilege: the
    // window contributes no activity and only the configured source is emitted.
    expect(options.legacy_window_mode).toBe('none');
    expect(options.activity_coverage_sources.map(source => source.source_id)).toEqual([
      'presence',
    ]);
    expect(
      options.activity_coverage_sources.some(source => source.source_id === 'builtin_window')
    ).toBe(false);
    expect(options.context_sources).toEqual([]);
  });

  test('uses legacy window data as context only for advanced always-active matching', () => {
    const options = compileProfileQueryOptions(
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
            creates_activity: true,
          },
        ],
        active_time: {
          type: 'legacy',
          use_afk: true,
          include_audible: true,
          always_active_pattern: 'meeting',
        },
      },
      [
        {
          schema_version: 2,
          id: 'default',
          categories: [
            {
              id: 'present',
              name: ['Present'],
              simple_ui: false,
              rule: { type: 'regex', source: 'presence', field: 'state', regex: 'active' },
            },
          ],
        },
      ],
      capabilities
    );

    expect(options.legacy_window_mode).toBe('context');
  });

  test('infers context and active-time use from references to one neutral source', () => {
    const options = compileProfileQueryOptions(
      {
        schema_version: 2,
        id: 'default',
        category_set_ids: ['default'],
        sources: [
          {
            id: 'vdesktop',
            label: 'Virtual desktop',
            bucket_ids: ['aw-watcher-vdesktop_test'],
            bucket_hosts: { 'aw-watcher-vdesktop_test': 'test' },
            fields: ['vdesktop'],
          },
          {
            id: 'unrelated',
            label: 'Unrelated',
            bucket_ids: ['unrelated'],
            scope: 'global',
            fields: ['value'],
          },
        ],
        active_time: {
          type: 'expression',
          rule: {
            type: 'regex',
            source: 'vdesktop',
            field: 'vdesktop',
            regex: 'Personal',
          },
        },
      },
      [
        {
          schema_version: 2,
          id: 'default',
          categories: [
            {
              id: 'personal',
              name: ['Personal'],
              rule: {
                type: 'regex',
                source: 'vdesktop',
                field: 'vdesktop',
                regex: 'Personal',
              },
            },
          ],
        },
      ],
      capabilities
    );

    expect(options.context_sources[0].source_id).toBe('vdesktop');
    expect(options.context_sources[0].bucket_hosts).toEqual({
      'aw-watcher-vdesktop_test': 'test',
    });
    expect(options.active_time_sources?.[0].source_id).toBe('vdesktop');
    expect(options.active_time_sources).toHaveLength(1);
    expect(options.active_time_rule?.type).toBe('regex');
    expect(options.context_sources).toHaveLength(1);
  });

  test('compiles activity creators as unordered coverage sources', () => {
    const options = compileProfileQueryOptions(
      {
        schema_version: 2,
        id: 'default',
        category_set_ids: ['default'],
        sources: [
          {
            id: 'meeting-high',
            label: 'Meeting high',
            bucket_ids: ['meeting-high'],
            fields: ['subject'],
            creates_activity: true,
            host: 'workstation',
          },
          {
            id: 'meeting-low',
            label: 'Meeting low',
            bucket_ids: ['meeting-low'],
            scope: 'global',
            fields: ['subject'],
            creates_activity: true,
          },
        ],
        active_time: {
          type: 'legacy',
          use_afk: true,
          include_audible: true,
          always_active_pattern: '',
        },
      },
      [{ schema_version: 2, id: 'default', categories: [] }],
      capabilities
    );

    expect(options.activity_coverage_sources.map(source => source.source_id)).toEqual([
      'meeting-high',
      'meeting-low',
    ]);
    expect(options.activity_coverage_sources[0].fields).toEqual(['subject']);
    expect(options.activity_coverage_sources[0].host).toBe('workstation');
    expect(options.activity_sources).toEqual([]);
    expect(options.background_sources).toEqual([]);
  });

  test('does not duplicate activity creator fields as context sources', () => {
    const options = compileProfileQueryOptions(
      {
        schema_version: 2,
        id: 'default',
        category_set_ids: ['default'],
        sources: [
          {
            id: 'desktop-low',
            label: 'Desktop low',
            bucket_ids: ['desktop-low'],
            fields: ['vdesktop'],
            creates_activity: true,
            scope: 'global',
          },
          {
            id: 'desktop-high',
            label: 'Desktop high',
            bucket_ids: ['desktop-high'],
            fields: ['vdesktop'],
            creates_activity: true,
            scope: 'global',
          },
        ],
        active_time: {
          type: 'legacy',
          use_afk: true,
          include_audible: true,
          always_active_pattern: '',
        },
      },
      [{ schema_version: 2, id: 'default', categories: [] }],
      capabilities
    );

    expect(options.activity_coverage_sources.map(source => source.source_id)).toEqual([
      'desktop-low',
      'desktop-high',
    ]);
    expect(options.context_sources).toEqual([]);
  });
});
