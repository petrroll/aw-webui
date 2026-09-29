import {
  fullActivityQueryV2,
  fullActivityMultiQueryV2,
  categoryActivityQueryV2,
  categoryActivityMultiQueryV2,
  canonicalMultideviceEventsV2,
  type ActivityReportParamsV2,
  type CanonicalQueryParamsV2,
} from '~/queries';
import {
  selectAppTitleSourceId,
  selectBrowserFocusSourceId,
  selectStopwatchSourceId,
  remapNamespacedAppTitle,
} from '~/util/activityQuery';
import { BUILTIN_WINDOW_SOURCE_ID } from '~/util/rulesV2';
import type { IEvent } from '~/util/interfaces';

const capabilities = [
  'query.categorize_v2.v1',
  'query.merge_subwatcher_fields.source_namespace.v1',
  'query.active_periods_v2.v1',
  'query.map_event_fields.v1',
  'query.query_bucket_optional_raw.v1',
  'query.query_period.v1',
  'query.flood_v2.v1',
];

function browserSource(bucketIds: string[], host = 'workstation') {
  return {
    source_id: 'browser',
    builtin: 'browser' as const,
    bucket_ids: bucketIds,
    scope: 'host' as const,
    bucket_hosts: Object.fromEntries(bucketIds.map(bucketId => [bucketId, host])),
    fields: ['title', 'url', 'audible', 'incognito', 'tabCount'],
    interval_policy: 'heartbeat' as const,
  };
}

function windowCoverageParams(): CanonicalQueryParamsV2 {
  return {
    hostname: 'workstation',
    filter_afk: false,
    filter_categories: null,
    capabilities,
    category_specs: [],
    activity_coverage_sources: [
      {
        source_id: BUILTIN_WINDOW_SOURCE_ID,
        builtin: 'window',
        bucket_ids: ['aw-watcher-window_workstation'],
        bucket_hosts: { 'aw-watcher-window_workstation': 'workstation' },
        fields: ['app', 'title'],
      },
    ],
  } as CanonicalQueryParamsV2;
}

describe('v2 report builders — generic activity, namespaced projection', () => {
  test('app/title summaries project from a namespaced source, never root fields', () => {
    const params = windowCoverageParams();
    const appTitleSourceId = selectAppTitleSourceId(params, BUILTIN_WINDOW_SOURCE_ID);
    expect(appTitleSourceId).toBe(BUILTIN_WINDOW_SOURCE_ID);

    const query = fullActivityQueryV2({
      ...params,
      app_title_source_id: appTitleSourceId,
    } as ActivityReportParamsV2).join('\n');

    // App/title merge keys are namespaced, not the canonical root "app"/"title".
    expect(query).toContain(`$source.${BUILTIN_WINDOW_SOURCE_ID}.app`);
    expect(query).toContain(`$source.${BUILTIN_WINDOW_SOURCE_ID}.title`);
    expect(query).toMatch(/merge_events_by_keys\(events, \["\$source/);
    // The report exposes a generic activity section, not authoritative window.
    expect(query).toContain('"activity"');
    expect(query).not.toContain('"window"');
    // Never any privileged root injection.
    expect(query).not.toContain('bid_window');
    expect(query).not.toContain('bid_afk');
    expect(query).not.toContain('bid_stopwatch');
  });

  test('with no app/title source the app/title arrays are empty', () => {
    const params: CanonicalQueryParamsV2 = {
      hostname: 'workstation',
      filter_afk: false,
      filter_categories: null,
      capabilities,
      category_specs: [],
      activity_coverage_sources: [
        {
          source_id: 'meetings',
          bucket_ids: ['aw-watcher-meetings_workstation'],
          bucket_hosts: { 'aw-watcher-meetings_workstation': 'workstation' },
          fields: ['status'],
        },
      ],
    } as CanonicalQueryParamsV2;
    expect(selectAppTitleSourceId(params, BUILTIN_WINDOW_SOURCE_ID)).toBeUndefined();

    const query = fullActivityQueryV2({
      ...params,
      app_title_source_id: selectAppTitleSourceId(params, BUILTIN_WINDOW_SOURCE_ID),
    } as ActivityReportParamsV2).join('\n');
    expect(query).toContain('app_events = [];');
    expect(query).toContain('title_events = [];');
    // Category/duration/active results still work generically.
    expect(query).toContain('cat_events');
    expect(query).toContain('duration = sum_durations(events);');
  });

  test('browser focus filters on a namespaced source app key, never root app', () => {
    const params = windowCoverageParams();
    const browserFocusSourceId = selectBrowserFocusSourceId(params, BUILTIN_WINDOW_SOURCE_ID);
    expect(browserFocusSourceId).toBe(BUILTIN_WINDOW_SOURCE_ID);

    const query = fullActivityQueryV2({
      ...params,
      app_title_source_id: selectAppTitleSourceId(params, BUILTIN_WINDOW_SOURCE_ID),
      browser_focus_source_id: browserFocusSourceId,
      browser_source: browserSource(['aw-watcher-web-chrome_workstation']),
    } as ActivityReportParamsV2).join('\n');

    expect(query).toContain('aw-watcher-web-chrome_workstation');
    expect(query).toContain(`$source.${BUILTIN_WINDOW_SOURCE_ID}.app`);
    // The browser focus filter must use the namespaced key, never bare "app".
    expect(query).not.toMatch(/filter_keyvals\(events, "app"/);
  });

  test('browser report uses configured interval policy and exposed fields', () => {
    const params = windowCoverageParams();
    const bucketId = 'aw-watcher-web-firefox_workstation';
    const exactQuery = fullActivityQueryV2({
      ...params,
      browser_focus_source_id: BUILTIN_WINDOW_SOURCE_ID,
      browser_source: {
        ...browserSource([bucketId]),
        interval_policy: 'exact',
      },
    }).join('\n');
    expect(exactQuery).toContain(`query_bucket_optional_raw("${bucketId}", "workstation")`);
    expect(exactQuery).not.toContain('browser_single_0 = flood_v2(browser_single_0)');

    const heartbeatQuery = fullActivityQueryV2({
      ...params,
      browser_focus_source_id: BUILTIN_WINDOW_SOURCE_ID,
      browser_source: browserSource([bucketId]),
    }).join('\n');
    expect(heartbeatQuery).toContain(`query_bucket_optional_raw("${bucketId}", "workstation", 5)`);
    expect(heartbeatQuery).toContain('browser_single_0 = flood_v2(browser_single_0)');

    const audibleOnlyQuery = fullActivityQueryV2({
      ...params,
      browser_focus_source_id: BUILTIN_WINDOW_SOURCE_ID,
      browser_source: { ...browserSource([bucketId]), fields: ['audible'] },
    }).join('\n');
    expect(audibleOnlyQuery).toContain('["audible"]');
    expect(audibleOnlyQuery).toContain('browser_urls = [];');
    expect(audibleOnlyQuery).toContain('browser_titles = [];');
    expect(audibleOnlyQuery).not.toContain('["url","title","audible","incognito","tabCount"]');

    const urlOnlyQuery = fullActivityQueryV2({
      ...params,
      browser_focus_source_id: BUILTIN_WINDOW_SOURCE_ID,
      browser_source: { ...browserSource([bucketId]), fields: ['url'] },
    }).join('\n');
    expect(urlOnlyQuery).toContain('["url"]');
    expect(urlOnlyQuery).toContain('browser_titles = [];');
    expect(urlOnlyQuery).not.toContain('["url","title","audible","incognito","tabCount"]');
  });

  test('browser report honors global fallback ownership and rejects foreign host sources', () => {
    const params = windowCoverageParams();
    const fallbackBucket = 'aw-watcher-web-firefox_unknown';
    const globalQuery = fullActivityQueryV2({
      ...params,
      browser_focus_source_id: BUILTIN_WINDOW_SOURCE_ID,
      browser_source: {
        ...browserSource([fallbackBucket]),
        scope: 'global',
        bucket_hosts: undefined,
      },
    }).join('\n');
    expect(globalQuery).toContain(`query_bucket_optional_raw("${fallbackBucket}", null, 5)`);

    const foreignBucket = 'aw-watcher-web-firefox_laptop';
    const foreignQuery = fullActivityQueryV2({
      ...params,
      browser_focus_source_id: BUILTIN_WINDOW_SOURCE_ID,
      browser_source: browserSource([foreignBucket], 'laptop'),
    }).join('\n');
    expect(foreignQuery).not.toContain(foreignBucket);
  });

  test('context-only app/title sources can drive presentation and browser focus', () => {
    const params: CanonicalQueryParamsV2 = {
      hostname: 'workstation',
      filter_categories: null,
      capabilities,
      category_specs: [],
      activity_coverage_sources: [
        {
          source_id: 'meetings',
          bucket_ids: ['aw-watcher-meetings_workstation'],
          fields: ['status'],
        },
      ],
      context_sources: [
        {
          source_id: 'desktop_context',
          bucket_ids: ['aw-watcher-desktop-context_workstation'],
          fields: ['app', 'title'],
          conflict: 'base_wins',
        },
      ],
    };

    expect(selectAppTitleSourceId(params, 'desktop_context')).toBe('desktop_context');
    expect(selectBrowserFocusSourceId(params, 'desktop_context')).toBe('desktop_context');
  });

  test('presentation uses only the explicitly configured source', () => {
    const params: CanonicalQueryParamsV2 = {
      hostname: 'workstation',
      filter_categories: null,
      capabilities,
      category_specs: [],
      activity_coverage_sources: [
        {
          source_id: 'first',
          bucket_ids: ['first'],
          fields: ['app', 'title'],
        },
        {
          source_id: 'selected',
          bucket_ids: ['selected'],
          fields: ['app', 'title'],
        },
      ],
    };

    expect(selectAppTitleSourceId(params, 'selected')).toBe('selected');
    expect(selectAppTitleSourceId(params, 'missing')).toBeUndefined();
  });

  test('browser results are unavailable when no source has an app field', () => {
    const params: CanonicalQueryParamsV2 = {
      hostname: 'workstation',
      filter_afk: false,
      filter_categories: null,
      capabilities,
      category_specs: [],
      activity_coverage_sources: [
        {
          source_id: 'meetings',
          bucket_ids: ['aw-watcher-meetings_workstation'],
          bucket_hosts: { 'aw-watcher-meetings_workstation': 'workstation' },
          fields: ['status'],
        },
      ],
    } as CanonicalQueryParamsV2;
    expect(selectBrowserFocusSourceId(params, BUILTIN_WINDOW_SOURCE_ID)).toBeUndefined();

    const query = fullActivityQueryV2({
      ...params,
      browser_focus_source_id: selectBrowserFocusSourceId(params, BUILTIN_WINDOW_SOURCE_ID),
      browser_source: browserSource(['aw-watcher-web-chrome_workstation']),
    } as ActivityReportParamsV2).join('\n');
    expect(query).toContain('browser_events = [];');
    expect(query).not.toContain('aw-watcher-web-chrome_workstation');
  });

  test('stopwatch is projected from a namespaced label, never bid_stopwatch', () => {
    const params: CanonicalQueryParamsV2 = {
      ...windowCoverageParams(),
      activity_coverage_sources: [
        ...(windowCoverageParams().activity_coverage_sources ?? []),
        {
          source_id: 'stopwatch',
          bucket_ids: ['aw-stopwatch_workstation'],
          bucket_hosts: { 'aw-stopwatch_workstation': 'workstation' },
          fields: ['label', 'running'],
        },
      ],
    };
    expect(selectStopwatchSourceId(params, true)).toBe('stopwatch');
    expect(selectStopwatchSourceId(params, false)).toBeUndefined();

    const query = fullActivityQueryV2({
      ...params,
      stopwatch_source_id: selectStopwatchSourceId(params, true),
    } as ActivityReportParamsV2).join('\n');
    expect(query).toContain('$source.stopwatch.label');
    expect(query).not.toContain('bid_stopwatch');
  });

  test('multidevice v2 report unions per-host events with shared projection', () => {
    const perHost: ActivityReportParamsV2[] = [
      {
        ...windowCoverageParams(),
        app_title_source_id: BUILTIN_WINDOW_SOURCE_ID,
        browser_focus_source_id: BUILTIN_WINDOW_SOURCE_ID,
        browser_source: browserSource(['aw-watcher-web-chrome_workstation']),
      },
      {
        ...windowCoverageParams(),
        hostname: 'laptop',
        app_title_source_id: BUILTIN_WINDOW_SOURCE_ID,
        browser_focus_source_id: BUILTIN_WINDOW_SOURCE_ID,
        browser_source: browserSource(['aw-watcher-web-chrome_laptop'], 'laptop'),
      },
    ];
    const query = fullActivityMultiQueryV2(perHost).join('\n');
    expect(query).toContain('events_mdev_0');
    expect(query).toContain('events_mdev_1');
    expect(query).toContain('browser_projection_mdev_0');
    expect(query).toContain('browser_projection_mdev_1');
    expect(query).toContain(
      'period_union([], filter_period_intersect(query_bounds, events_mdev_0))'
    );
    expect(query).toContain('aw-watcher-web-chrome_workstation');
    expect(query).toContain('aw-watcher-web-chrome_laptop');
    expect(query).toContain('union_no_overlap');
    expect(query).toContain('"activity"');
    expect(query).not.toContain('bid_window');
  });

  test('all browser buckets are loaded and resolved against their own host activity', () => {
    const first = {
      ...windowCoverageParams(),
      app_title_source_id: BUILTIN_WINDOW_SOURCE_ID,
      browser_focus_source_id: BUILTIN_WINDOW_SOURCE_ID,
      browser_source: browserSource([
        'aw-watcher-web-chrome_workstation',
        'aw-watcher-web-chrome-work_workstation',
      ]),
    };
    const second = {
      ...windowCoverageParams(),
      hostname: 'laptop',
      browser_focus_source_id: BUILTIN_WINDOW_SOURCE_ID,
      browser_source: browserSource(['aw-watcher-web-chrome_laptop'], 'laptop'),
    };
    const query = fullActivityMultiQueryV2([first, second]).join('\n');

    expect(query).toContain('aw-watcher-web-chrome_workstation');
    expect(query).toContain('aw-watcher-web-chrome-work_workstation');
    expect(query).toContain('aw-watcher-web-chrome_laptop');
    const firstBucket = query.indexOf(
      'query_bucket_optional_raw("aw-watcher-web-chrome_workstation", "workstation", 5)'
    );
    const secondBucket = query.indexOf(
      'query_bucket_optional_raw("aw-watcher-web-chrome-work_workstation", "workstation", 5)'
    );
    const familyProjection = query.indexOf(
      'browser_mdev_0_0_projected = merge_subwatcher_fields(\n    browser_mdev_0_0_presence,\n    browser_mdev_0_0'
    );
    expect(firstBucket).toBeGreaterThan(-1);
    expect(secondBucket).toBeGreaterThan(firstBucket);
    expect(familyProjection).toBeGreaterThan(secondBucket);
    expect(query.match(/browser_mdev_0_0 = flood_v2\(browser_mdev_0_0\)/g)).toHaveLength(1);
    // Both same-family raw streams are concatenated and heartbeat-normalized
    // once before one timestamp-aware projection; there is no separately
    // restamped second-bucket projection.
    expect(query).not.toContain('browser_mdev_0_1_projected');
    expect(query).not.toContain(
      'browser_mdev_0_0 = filter_period_intersect(browser_mdev_0_0, browser_focus_mdev_0_0)'
    );
    expect(query).toContain(
      'browser_projection_events = union_no_overlap(browser_projection_events, browser_projection_mdev_0)'
    );
    expect(query.indexOf('browser_projection_mdev_0 = merge_subwatcher_fields')).toBeLessThan(
      query.indexOf(
        'browser_projection_events = union_no_overlap(browser_projection_events, browser_projection_mdev_0)'
      )
    );
  });

  test('same-family browser buckets are combined before projection regardless of order', () => {
    const build = (bucketIds: string[]) =>
      fullActivityQueryV2({
        ...windowCoverageParams(),
        browser_focus_source_id: BUILTIN_WINDOW_SOURCE_ID,
        browser_source: browserSource(bucketIds),
      }).join('\n');
    const oldBucket = 'aw-watcher-web-chrome-old_workstation';
    const newBucket = 'aw-watcher-web-chrome-new_workstation';

    for (const query of [
      build([oldBucket]),
      build([oldBucket, newBucket]),
      build([newBucket, oldBucket]),
    ]) {
      const projection = query.indexOf(
        'browser_single_0_projected = merge_subwatcher_fields(\n    browser_single_0_presence,\n    browser_single_0'
      );
      expect(projection).toBeGreaterThan(
        query.indexOf(`query_bucket_optional_raw("${oldBucket}", "workstation", 5)`)
      );
      if (query.includes(newBucket)) {
        expect(projection).toBeGreaterThan(
          query.indexOf(`query_bucket_optional_raw("${newBucket}", "workstation", 5)`)
        );
      }
      expect(query).not.toContain('browser_single_1_projected');
    }
  });

  test('multidevice filters are applied only after host precedence across every API', () => {
    const workFilter = [['Work']];
    const perHost = [
      { ...windowCoverageParams(), filter_categories: workFilter },
      { ...windowCoverageParams(), hostname: 'laptop', filter_categories: workFilter },
    ];
    const assertPostPrecedenceFilter = (query: string) => {
      const union = query.lastIndexOf('events = union_no_overlap');
      const filter = query.indexOf('events = filter_keyvals(events, "$category"');
      expect(union).toBeGreaterThan(-1);
      expect(filter).toBeGreaterThan(union);
      expect(query.slice(0, union)).not.toContain('events = filter_keyvals(events, "$category"');
    };

    assertPostPrecedenceFilter(canonicalMultideviceEventsV2(perHost));
    assertPostPrecedenceFilter(fullActivityMultiQueryV2(perHost, workFilter).join('\n'));
    assertPostPrecedenceFilter(categoryActivityMultiQueryV2(perHost, workFilter).join('\n'));
  });

  test('multidevice projection can come from a later materialized host', () => {
    const withoutProjection: ActivityReportParamsV2 = {
      hostname: 'first',
      filter_afk: false,
      filter_categories: null,
      capabilities,
      category_specs: [],
      activity_coverage_sources: [
        {
          source_id: 'meeting',
          bucket_ids: ['meeting-first'],
          scope: 'global',
          fields: ['subject'],
        },
      ],
    };
    const withProjection: ActivityReportParamsV2 = {
      ...windowCoverageParams(),
      hostname: 'second',
      app_title_source_id: BUILTIN_WINDOW_SOURCE_ID,
    };
    const query = fullActivityMultiQueryV2([withoutProjection, withProjection]).join('\n');
    expect(query).toContain(`$source.${BUILTIN_WINDOW_SOURCE_ID}.app`);
    expect(query).not.toContain('app_events = [];');
  });

  test('category-only v2 queries yield cat_events without injection', () => {
    const single = categoryActivityQueryV2(windowCoverageParams()).join('\n');
    expect(single).toContain('cat_events');
    expect(single).not.toContain('bid_window');

    const multi = canonicalMultideviceEventsV2([
      windowCoverageParams(),
      { ...windowCoverageParams(), hostname: 'laptop' },
    ]);
    expect(multi).toContain('events_host_0');
    expect(multi).toContain('union_no_overlap');
    expect(multi).not.toContain('bid_window');
  });
});

describe('remapNamespacedAppTitle — presentation projection at the boundary', () => {
  const events: IEvent[] = [
    {
      id: 1,
      timestamp: '2024-01-01T00:00:00Z',
      duration: 60,
      data: {
        [`$source.${BUILTIN_WINDOW_SOURCE_ID}.app`]: 'Code',
        [`$source.${BUILTIN_WINDOW_SOURCE_ID}.title`]: 'file.ts',
        $category: ['Work'],
      },
    } as unknown as IEvent,
  ];

  test('copies namespaced app/title onto plain data.app/title', () => {
    const remapped = remapNamespacedAppTitle(events, BUILTIN_WINDOW_SOURCE_ID);
    expect(remapped[0].data.app).toBe('Code');
    expect(remapped[0].data.title).toBe('file.ts');
    // Does not mutate the original event data.
    expect(events[0].data.app).toBeUndefined();
  });

  test('returns events unchanged when no projection source is configured', () => {
    const remapped = remapNamespacedAppTitle(events, undefined);
    expect(remapped).toBe(events);
  });

  test('returns an empty array for undefined events', () => {
    expect(remapNamespacedAppTitle(undefined, BUILTIN_WINDOW_SOURCE_ID)).toEqual([]);
  });
});
