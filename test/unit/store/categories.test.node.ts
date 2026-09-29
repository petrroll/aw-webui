import { isEqual } from 'lodash';
import { setActivePinia, createPinia } from 'pinia';

import { useCategoryStore } from '~/stores/categories';
import { useSettingsStore } from '~/stores/settings';
import { createMissingParents, defaultCategories, Category } from '~/util/classes';
import { defaultBuiltinSources } from '~/util/rulesV2';

describe('categories store', () => {
  setActivePinia(createPinia());
  const categoryStore = useCategoryStore();

  beforeEach(() => {
    categoryStore.clearAll();
  });

  test('loads default categories', async () => {
    // Load categories
    expect(categoryStore.classes).toHaveLength(0);
    categoryStore.restoreDefaultClasses();

    expect(categoryStore.classes_unsaved_changes).toBeTruthy();
    const settingsStore = useSettingsStore();
    settingsStore.$patch({ _loaded: true });
    const saveRules = jest.spyOn(settingsStore, 'saveCanonicalRulesV2').mockResolvedValue();
    await categoryStore.save();
    saveRules.mockRestore();

    expect(categoryStore.classes_unsaved_changes).toBeFalsy();
    expect(categoryStore.classes).not.toHaveLength(0);

    // Retrieve class
    let workCat = categoryStore.get_category(['Work']);
    expect(workCat).not.toBeUndefined();
    workCat = JSON.parse(JSON.stringify(workCat)); // copy

    // Modify class
    const newRegex = 'Just testing';
    workCat.rule.regex = newRegex;
    categoryStore.updateClass(workCat);
    expect(categoryStore.get_category(['Work']).rule.regex).toEqual(newRegex);

    // Check that getters behave somewhat
    expect(categoryStore.all_categories).not.toHaveLength(0);
    expect(categoryStore.classes_hierarchy).not.toHaveLength(0);
  });

  test('loads custom categories', () => {
    expect(categoryStore.classes).toHaveLength(0);
    categoryStore.load([{ name: ['Test'], rule: { type: 'none' } }]);
    expect(categoryStore.all_categories).toHaveLength(1);
  });

  test('get category hierarchy', () => {
    categoryStore.restoreDefaultClasses();
    const hier = categoryStore.classes_hierarchy;
    expect(hier).not.toHaveLength(0);
  });

  test('create missing parents', () => {
    const cats = createMissingParents([
      { name: ['Test', 'Subcat'], rule: { type: 'regex', regex: 'test' } },
    ]);
    expect(cats).toHaveLength(2);
  });

  test('update implicit parent category', () => {
    // The default categories have implicit Media and Comms categories (with 'No Rule')
    // Tests against https://github.com/ActivityWatch/activitywatch/issues/580
    categoryStore.restoreDefaultClasses();

    // Check that the label is available
    expect(categoryStore.all_categories).toContainEqual(['Media']);

    // Get category and modify it
    const media_cat: Category = categoryStore.get_category(['Media']);
    expect(media_cat.id).not.toBeUndefined();
    const new_media_cat = { ...media_cat, name: ['Media2'], data: { test: true } };
    categoryStore.updateClass(new_media_cat);

    // Check that category was modified correctly
    const media2_cat: Category = categoryStore.get_category(['Media2']);
    expect(media2_cat.data.test).toBe(true);

    // Check that child was modified correctly when parent name changed
    const music_cat = categoryStore.get_category(['Media2', 'Music']);
    expect(music_cat.id).not.toBeUndefined();

    // Check that defaultCategories haven't mutated
    expect(defaultCategories.map(c => c.name)).toContainEqual(['Media', 'Music']);
  });

  test('resolves canonical child paths after a pending parent rename', () => {
    categoryStore.load([
      { name: ['Parent'], rule: { type: 'none' } },
      { name: ['Parent', 'Child'], rule: { type: 'none' } },
    ]);
    categoryStore.queueV2Edit({
      categoryId: 'parent',
      originalName: ['Parent'],
      name: ['Renamed'],
      rule: { type: 'none' },
      priority: 0,
      requires: [],
    });

    expect(categoryStore.canonicalNameForPendingPath(['Renamed', 'Child'])).toEqual([
      'Parent',
      'Child',
    ]);
  });

  test('resolves chained pending parent and child renames', () => {
    categoryStore.queueV2Edit({
      categoryId: 'child',
      originalName: ['Parent', 'Child'],
      name: ['Parent', 'Renamed child'],
      rule: { type: 'none' },
      priority: 0,
      requires: [],
    });
    categoryStore.queueV2Edit({
      categoryId: 'parent',
      originalName: ['Parent'],
      name: ['Renamed parent'],
      rule: { type: 'none' },
      priority: 0,
      requires: [],
    });

    expect(categoryStore.canonicalNameForPendingPath(['Renamed parent', 'Renamed child'])).toEqual([
      'Parent',
      'Child',
    ]);
  });

  test('keeps a pending rename before deleting the renamed category', () => {
    categoryStore.queueV2Edit({
      categoryId: 'parent',
      originalName: ['Parent'],
      name: ['Renamed parent'],
      rule: { type: 'none' },
      priority: 0,
      requires: [],
    });

    categoryStore.queueV2Delete(['Parent'], 'parent');

    expect(categoryStore.pending_v2_edits).toHaveLength(2);
    expect(categoryStore.pending_v2_edits[0]).toMatchObject({
      categoryId: 'parent',
      originalName: ['Parent'],
      name: ['Renamed parent'],
    });
    expect(categoryStore.pending_v2_edits[1]).toMatchObject({
      delete: true,
      categoryId: 'parent',
    });
  });

  test('tracks unsaved v2 editor drafts by section', () => {
    categoryStore.setRulesV2DraftDirty('sources', true);
    categoryStore.setRulesV2DraftDirty('active-time', true);
    expect(categoryStore.rules_v2_unsaved_changes).toBe(true);

    categoryStore.setRulesV2DraftDirty('sources', false);
    expect(categoryStore.rules_v2_unsaved_changes).toBe(true);

    categoryStore.setRulesV2DraftDirty('active-time', false);
    expect(categoryStore.rules_v2_unsaved_changes).toBe(false);
  });

  test('keeps inline source definitions pending until categories are saved', () => {
    const sources = [
      {
        id: 'bucket_browser',
        label: 'Browser tabs',
        bucket_ids: ['aw-watcher-web_test'],
        fields: ['title', 'url'],
        auto_generated: true,
      },
    ];

    categoryStore.queueV2Sources(sources, []);

    expect(categoryStore.pendingV2Sources).toEqual([...defaultBuiltinSources(), ...sources]);
    expect(categoryStore.classes_unsaved_changes).toBe(true);
  });

  test('persists updates to existing inline source definitions', async () => {
    const settingsStore = useSettingsStore();
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
              label: 'Virtual desktop',
              bucket_ids: ['desktop'],
              scope: 'global',
              fields: ['vdesktop'],
              auto_generated: true,
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
      category_sets_v2: [
        {
          schema_version: 2,
          id: 'default',
          categories: [
            {
              id: 'personal',
              name: ['Personal'],
              rule: { type: 'regex', source: 'desktop', regex: 'Personal' },
            },
          ],
        },
      ],
    });
    const saveMock = jest.spyOn(settingsStore, 'saveCanonicalRulesV2').mockResolvedValue();
    const baselineSources = settingsStore.rulesV2.activity_profiles_v2[0].sources;
    categoryStore.queueV2Sources(
      [
        {
          id: 'desktop',
          label: 'Virtual desktop',
          bucket_ids: ['desktop'],
          scope: 'global',
          fields: ['vdesktop'],
          activity_mode: 'fill-gaps' as const,
          canonical_fields: { title: 'vdesktop' },
        },
      ],
      baselineSources
    );
    settingsStore.activity_profiles_v2[0].sources.push({
      id: 'browser',
      label: 'Browser',
      bucket_ids: ['browser'],
      scope: 'global',
      fields: ['url'],
    });

    await categoryStore.save();

    expect(
      saveMock.mock.calls[0][0].profiles[0].sources.find(source => source.id === 'desktop')
    ).toMatchObject({
      id: 'desktop',
      activity_mode: 'fill-gaps',
      canonical_fields: { title: 'vdesktop' },
    });
    expect(
      saveMock.mock.calls[0][0].profiles[0].sources.find(source => source.id === 'browser')
    ).toMatchObject({
      id: 'browser',
      label: 'Browser',
    });
  });

  test('refuses to save a combined multi-set view without explicit set selection', async () => {
    const settingsStore = useSettingsStore();
    settingsStore.$reset();
    settingsStore.$patch({
      _loaded: true,
      activity_profiles_v2: [
        {
          schema_version: 2,
          id: 'default',
          category_set_ids: ['one', 'two'],
          sources: defaultBuiltinSources(),
          active_time: { type: 'expression', rule: { type: 'none' } },
        },
      ],
      category_sets_v2: [
        { schema_version: 2, id: 'one', categories: [] },
        { schema_version: 2, id: 'two', categories: [] },
      ],
    });
    categoryStore.load();
    await expect(categoryStore.save()).rejects.toThrow('combined category-set view');
  });

  test('edits the explicitly selected inactive set without changing active composition', async () => {
    const settingsStore = useSettingsStore();
    settingsStore.$reset();
    settingsStore.$patch({
      _loaded: true,
      activity_profiles_v2: [
        {
          schema_version: 2,
          source_defaults_version: 4,
          id: 'default',
          category_set_ids: ['active'],
          sources: defaultBuiltinSources(),
          app_title_source_id: 'builtin_window',
          browser_focus_source_id: 'builtin_window',
          active_time: { type: 'expression', rule: { type: 'none' } },
        },
      ],
      category_sets_v2: [
        {
          schema_version: 2,
          id: 'active',
          categories: [{ id: 'a', name: ['Active'], rule: { type: 'none' } }],
        },
        {
          schema_version: 2,
          id: 'inactive',
          categories: [{ id: 'i', name: ['Inactive'], rule: { type: 'none' } }],
        },
      ],
    });
    const saveMock = jest.spyOn(settingsStore, 'saveCanonicalRulesV2').mockResolvedValue();

    categoryStore.selectCategorySet('inactive');
    const edited = categoryStore.get_category(['Inactive']);
    categoryStore.updateClass({ ...edited, name: ['Edited inactive'] });
    const customSource = {
      id: 'custom',
      label: 'Custom watcher',
      bucket_ids: ['custom_inactive'],
      scope: 'global' as const,
      fields: ['state'],
      auto_generated: true,
    };
    categoryStore.queueV2Sources(
      [...settingsStore.rulesV2.activity_profiles_v2[0].sources, customSource],
      settingsStore.rulesV2.activity_profiles_v2[0].sources
    );
    categoryStore.queueV2Edit({
      categoryId: 'i',
      originalName: ['Inactive'],
      name: ['Edited inactive'],
      rule: { type: 'regex', source: 'custom', field: 'state', regex: 'on' },
      priority: 0,
      requires: [],
    });
    await categoryStore.save();

    const saved = saveMock.mock.calls[saveMock.mock.calls.length - 1][0];
    expect(saved.profiles[0].category_set_ids).toEqual(['active']);
    expect(saved.categorySets.find(set => set.id === 'active').categories[0].name).toEqual([
      'Active',
    ]);
    expect(saved.categorySets.find(set => set.id === 'inactive').categories[0].name).toEqual([
      'Edited inactive',
    ]);
    expect(saved.profiles[0].sources.find(source => source.id === 'custom')).toMatchObject({
      bucket_ids: ['custom_inactive'],
      auto_generated: true,
    });
  });

  test('preserves select_keys semantics on a metadata-only save', async () => {
    const settingsStore = useSettingsStore();
    settingsStore.$reset();
    settingsStore.$patch({
      _loaded: true,
      activity_profiles_v2: [
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
      ],
      category_sets_v2: [
        {
          schema_version: 2,
          id: 'default',
          categories: [
            {
              id: 'work',
              name: ['Work'],
              rule: { type: 'regex', regex: 'Match', select_keys: ['title'] },
              simple_ui: true,
            },
          ],
        },
      ],
    });
    categoryStore.selectCategorySet('default');
    const category = categoryStore.get_category(['Work']);
    categoryStore.updateClass({ ...category, data: { color: '#123456' } });
    const save = jest.spyOn(settingsStore, 'saveCanonicalRulesV2').mockResolvedValue();

    await categoryStore.save();

    const saved = save.mock.calls[save.mock.calls.length - 1][0];
    const rule = saved.categorySets[0].categories[0].rule;
    expect(rule).toMatchObject({ type: 'regex', regex: 'Match', field: 'title' });
  });

  test('keeps draft identity separate from an existing canonical category ID', async () => {
    const settingsStore = useSettingsStore();
    settingsStore.$reset();
    settingsStore.$patch({
      _loaded: true,
      activity_profiles_v2: [
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
      ],
      category_sets_v2: [
        {
          schema_version: 2,
          id: 'default',
          categories: [
            {
              id: 'category-builder-1',
              name: ['Work'],
              rule: {
                type: 'regex',
                source: 'builtin_window',
                field: 'title',
                regex: 'Original',
              },
              simple_ui: false,
            },
          ],
        },
      ],
    });
    categoryStore.selectCategorySet('default');
    categoryStore.addClass({ name: ['Suggested'], rule: { type: 'none' } });
    categoryStore.queueV2Edit({
      draftId: 'category-builder-1',
      originalName: ['Suggested'],
      name: ['Suggested'],
      rule: { type: 'regex', source: 'builtin_window', field: 'title', regex: 'Suggested' },
      priority: 0,
      requires: [],
    });
    const save = jest.spyOn(settingsStore, 'saveCanonicalRulesV2').mockResolvedValue();

    await categoryStore.save();

    const saved = save.mock.calls[save.mock.calls.length - 1][0];
    const categories = saved.categorySets[0].categories;
    expect(categories.find(category => category.id === 'category-builder-1')).toMatchObject({
      name: ['Work'],
      rule: { regex: 'Original' },
    });
    expect(categories.find(category => category.name[0] === 'Suggested')).toMatchObject({
      rule: { regex: 'Suggested' },
    });
  });

  test('rolls back only a cancelled new-category draft', () => {
    const existingEdit = {
      categoryId: 'work',
      originalName: ['Work'],
      name: ['Work'],
      rule: { type: 'regex' as const, regex: 'Pending' },
      priority: 0,
      requires: [],
    };
    categoryStore.queueV2Edit(existingEdit);
    const wasDirty = categoryStore.classes_unsaved_changes;
    const classId = categoryStore.addClass({ name: ['Suggested'], rule: { type: 'none' } });
    categoryStore.queueV2Edit({
      draftId: 'category-builder-draft',
      originalName: ['Suggested'],
      name: ['Suggested'],
      rule: { type: 'regex', regex: 'Suggested' },
      priority: 0,
      requires: [],
    });

    categoryStore.discardNewClassDraft(classId, 'category-builder-draft', ['Suggested'], wasDirty);

    expect(categoryStore.pending_v2_edits).toEqual([existingEdit]);
    expect(categoryStore.classes.some(category => category.name[0] === 'Suggested')).toBe(false);
    expect(categoryStore.classes_unsaved_changes).toBe(true);
  });

  test('retains edits queued while an earlier save is pending', async () => {
    const settingsStore = useSettingsStore();
    settingsStore.$reset();
    const rules = {
      activity_profiles_v2: [
        {
          schema_version: 2 as const,
          id: 'default',
          category_set_ids: ['default'],
          sources: defaultBuiltinSources(),
          active_time: {
            type: 'legacy' as const,
            use_afk: true,
            include_audible: true,
            always_active_pattern: '',
          },
        },
      ],
      category_sets_v2: [
        {
          schema_version: 2 as const,
          id: 'default',
          categories: [
            {
              id: 'work',
              name: ['Work'],
              rule: { type: 'regex' as const, regex: 'Original' },
              simple_ui: true,
            },
          ],
        },
      ],
    };
    settingsStore.$patch({ ...rules, _loaded: true });
    categoryStore.selectCategorySet('default');

    let finishSave!: () => void;
    jest.spyOn(settingsStore, 'saveCanonicalRulesV2').mockImplementation(
      () =>
        new Promise<void>(resolve => {
          finishSave = resolve;
        })
    );
    const baseEdit = {
      categoryId: 'work',
      originalName: ['Work'],
      name: ['Work'],
      priority: 0,
      requires: [],
    };
    categoryStore.queueV2Edit({
      ...baseEdit,
      rule: { type: 'regex', source: 'builtin_window', regex: 'First' },
    });
    const saving = categoryStore.save();
    for (let index = 0; index < 5 && !finishSave; index++) await Promise.resolve();
    categoryStore.queueV2Edit({
      ...baseEdit,
      rule: { type: 'regex', source: 'builtin_window', regex: 'Latest' },
    });
    finishSave();
    await saving;

    expect(categoryStore.classes_unsaved_changes).toBe(true);
    expect(categoryStore.pending_v2_edits).toEqual([
      expect.objectContaining({ rule: expect.objectContaining({ regex: 'Latest' }) }),
    ]);
  });

  test('modify a category after deleting another', () => {
    // Deleting a category, then modifying another with an ID subsequent to it, should not
    // cause the changes to be applied to unintended classes.
    // Test against:
    // https://github.com/ActivityWatch/activitywatch/issues/361#issuecomment-970707045
    categoryStore.restoreDefaultClasses();

    // Check that Image category is available
    expect(categoryStore.all_categories).toContainEqual(['Work', 'Image']);

    // Delete Image category
    const image_cat = categoryStore.get_category(['Work', 'Image']);
    const image_cat_id = image_cat.id;
    expect(image_cat_id).not.toBeUndefined();
    categoryStore.removeClass(image_cat_id);

    // Check that Image category no longer exists
    expect(categoryStore.all_categories).not.toContainEqual(['Work', 'Image']);

    // Get Video category (whose ID succeeds to that of Image) and modify it
    const video_cat: Category = categoryStore.get_category(['Work', 'Video']);
    const video_cat_id = video_cat.id;
    expect(video_cat_id).not.toBeUndefined();
    expect(video_cat_id).toBeGreaterThan(image_cat_id);
    const new_video_cat: Category = {
      ...video_cat,
      name: ['Work', 'Video2'],
      data: { test: true },
    };
    categoryStore.updateClass(new_video_cat);

    // Check that modification on Video was applied
    const video_2_cat = categoryStore.get_category_by_id(video_cat_id);
    expect(video_2_cat.data.test).toBe(true);

    // Check that the category named "Video" no longer exists, and the category named "Video2" exists
    expect(categoryStore.all_categories.filter(c => isEqual(c, ['Work', 'Video']))).toHaveLength(0);
    expect(categoryStore.all_categories.filter(c => isEqual(c, ['Work', 'Video2']))).toHaveLength(
      1
    );
  });

  test('get_category_color decodes URL-encoded category segments', () => {
    categoryStore.load([
      {
        name: ['Work Project'],
        rule: { type: 'regex', regex: 'work-project' },
        data: { color: '#123456' },
      } as Category,
    ]);

    const decoded = categoryStore.get_category_color(['Work Project']);
    const encoded = categoryStore.get_category_color(['Work%20Project']);

    expect(decoded).toEqual('#123456');
    expect(encoded).toEqual('#123456');
  });

  test('get_category_score decodes URL-encoded category segments', () => {
    categoryStore.load([
      {
        name: ['Work Project'],
        rule: { type: 'regex', regex: 'work-project' },
        data: { score: 42 },
      } as Category,
    ]);

    const decoded = categoryStore.get_category_score(['Work Project']);
    const encoded = categoryStore.get_category_score(['Work%20Project']);

    expect(decoded).toEqual(42);
    expect(encoded).toEqual(42);
  });

  test('addClass after clearAll assigns id 0, not NaN/null', () => {
    // Regression test for #427: _.max([]) returns undefined, so
    // `_.max(_.map(this.classes, 'id')) + 1` evaluated to NaN for an empty
    // class list. JSON.stringify(NaN) produces null, creating an uneditable category.
    expect(categoryStore.classes).toHaveLength(0);
    const id = categoryStore.addClass({ name: ['New class'], rule: { type: 'none' } });
    expect(id).toBe(0);
    expect(categoryStore.classes[0].id).toBe(0);
    // Verify the new category is immediately editable (updateClass should find it by id)
    categoryStore.updateClass({ ...categoryStore.classes[0], name: ['Renamed'] });
    expect(categoryStore.classes[0].name).toEqual(['Renamed']);
  });

  test('addClass after partial deletion starts from max existing id', () => {
    categoryStore.load([
      { name: ['A'], rule: { type: 'none' } },
      { name: ['B'], rule: { type: 'none' } },
      { name: ['C'], rule: { type: 'none' } },
    ]);
    const maxBefore = Math.max(...categoryStore.classes.map(c => c.id ?? -1));
    categoryStore.removeClass(categoryStore.classes[1].id);
    const id = categoryStore.addClass({ name: ['D'], rule: { type: 'none' } });
    expect(id).toBe(maxBefore + 1);
  });
});
