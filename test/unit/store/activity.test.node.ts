import { setActivePinia, createPinia } from 'pinia';

import {
  buildActiveHistoryHostQueryParts,
  queryNeedsResolvedActiveTime,
  useActivityStore,
} from '~/stores/activity';
import { useBucketsStore } from '~/stores/buckets';
import { useCategoryStore } from '~/stores/categories';
import { useSettingsStore } from '~/stores/settings';
import queries from '~/queries';
import { createClient, getClient } from '~/util/awclient';

describe('activity store', () => {
  setActivePinia(createPinia());
  createClient();

  const activityStore = useActivityStore();
  const bucketsStore = useBucketsStore();
  const categoryStore = useCategoryStore();
  const settingsStore = useSettingsStore();

  beforeEach(async () => {
    bucketsStore.$reset();
    settingsStore.$reset();
    await activityStore.reset();
    await activityStore.load_demo();
  });

  test('loads demo data', async () => {
    // Load
    expect(categoryStore.classes).toHaveLength(0);
    categoryStore.restoreDefaultClasses();
    expect(categoryStore.classes_unsaved_changes).toBeTruthy();
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

  test('does not fall back to the legacy desktop query', async () => {
    const querySpy = jest
      .spyOn(queries, 'fullDesktopQuery')
      .mockReturnValue(['RETURN = {"window": [], "browser": [], "stopwatch": []};']);
    activityStore.buckets.window = ['aw-watcher-window_laptop'];
    activityStore.buckets.afk = ['aw-watcher-afk_laptop'];
    activityStore.buckets.browser = [];
    activityStore.buckets.stopwatch = [];

    await expect(
      activityStore.query_desktop_full({
        host: 'laptop',
        timeperiod: {
          start: '2026-01-01T00:00:00Z',
          length: [1, 'hour'],
        },
        filter_categories: [],
        filter_afk: true,
        include_audible: false,
        include_stopwatch: false,
        always_active_pattern: '',
      })
    ).rejects.toThrow('flexible activity model');

    expect(querySpy).not.toHaveBeenCalled();
  });

  test('active history unions only successfully materialized host suffixes', () => {
    const parts = buildActiveHistoryHostQueryParts(['first', 'skipped', 'third'], (host, suffix) =>
      host === 'skipped' ? null : `${host}:${suffix}`
    );

    expect(parts.hostQueries).toEqual(['first:active_host_0', 'third:active_host_2']);
    expect(parts.union).toContain('active_active_host_0');
    expect(parts.union).toContain('active_active_host_2');
    expect(parts.union).not.toContain('active_active_host_1');
  });

  test('activity-only queries do not require active-time data when AFK filtering is off', () => {
    expect(queryNeedsResolvedActiveTime(false, false)).toBe(false);
    expect(queryNeedsResolvedActiveTime(true, false)).toBe(true);
    expect(queryNeedsResolvedActiveTime(false, true)).toBe(true);
  });

  test('historical category queries do not fall back to legacy multidevice queries', async () => {
    settingsStore.$patch({ _loaded: true, useMultidevice: true });
    bucketsStore.$patch({
      buckets: [
        ...['laptop', 'desktop'].flatMap(host => [
          {
            id: `aw-watcher-window_${host}`,
            hostname: host,
            device_id: host,
            type: 'currentwindow',
            data: {},
          },
          {
            id: `aw-watcher-afk_${host}`,
            hostname: host,
            device_id: host,
            type: 'afkstatus',
            data: {},
          },
        ]),
        {
          id: 'aw-watcher-web_unknown',
          hostname: 'unknown',
          device_id: 'unknown',
          type: 'web.tab.current',
          data: {},
        },
      ],
    });
    const categoryQuerySpy = jest
      .spyOn(queries, 'categoryQuery')
      .mockReturnValue(['RETURN = {"cat_events": []};']);
    await expect(
      activityStore.query_category_time_by_period({
        host: 'laptop',
        timeperiod: {
          start: '2026-01-01T00:00:00Z',
          length: [1, 'day'],
        },
        filter_categories: [],
        filter_afk: true,
        include_audible: true,
        include_stopwatch: false,
        dontQueryInactive: false,
        always_active_pattern: '',
      })
    ).rejects.toThrow('flexible activity model');

    expect(categoryQuerySpy).not.toHaveBeenCalled();
  });
});
