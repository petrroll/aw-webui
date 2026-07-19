import { setActivePinia, createPinia } from 'pinia';

import { queryNeedsResolvedActiveTime, useActivityStore } from '~/stores/activity';
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

  test('loads demo data', () => {
    // Load
    expect(categoryStore.classes).toHaveLength(0);
    categoryStore.restoreDefaultClasses();
    expect(categoryStore.classes_unsaved_changes).toBeTruthy();
    categoryStore.save();
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

  test('passes the requested host into desktop canonical queries', async () => {
    const querySpy = jest
      .spyOn(queries, 'fullDesktopQuery')
      .mockReturnValue(['RETURN = {"window": [], "browser": [], "stopwatch": []};']);
    jest
      .spyOn(getClient(), 'query')
      .mockResolvedValue([{ window: [], browser: [], stopwatch: [] }]);
    activityStore.buckets.window = ['aw-watcher-window_laptop'];
    activityStore.buckets.afk = ['aw-watcher-afk_laptop'];
    activityStore.buckets.browser = [];
    activityStore.buckets.stopwatch = [];

    await activityStore.query_desktop_full({
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
    });

    expect(querySpy).toHaveBeenCalledWith(expect.objectContaining({ hostname: 'laptop' }));
  });

  test('activity-only queries do not require active-time data when AFK filtering is off', () => {
    expect(queryNeedsResolvedActiveTime(false, false)).toBe(false);
    expect(queryNeedsResolvedActiveTime(true, false)).toBe(true);
    expect(queryNeedsResolvedActiveTime(false, true)).toBe(true);
  });

  test('historical category queries include every eligible multidevice host', async () => {
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
    jest.spyOn(getClient(), 'query').mockResolvedValue([{ cat_events: [] }]);

    await activityStore.query_category_time_by_period({
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
    });

    expect(categoryQuerySpy).toHaveBeenCalled();
    for (const [params] of categoryQuerySpy.mock.calls) {
      expect(params).toMatchObject({
        hosts: expect.arrayContaining(['laptop', 'desktop']),
        include_audible: true,
        host_params: {
          laptop: {
            bid_window: 'aw-watcher-window_laptop',
            bid_afk: 'aw-watcher-afk_laptop',
            bid_browsers: [],
          },
          desktop: {
            bid_window: 'aw-watcher-window_desktop',
            bid_afk: 'aw-watcher-afk_desktop',
            bid_browsers: [],
          },
        },
      });
    }
  });
});
