import {
  fullActivityQueryV2,
  fullActivityMultiQueryV2,
  categoryActivityQueryV2,
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
];

function windowCoverageParams(): CanonicalQueryParamsV2 {
  return {
    hostname: 'workstation',
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
      browser_bucket_ids: ['aw-watcher-web-chrome_workstation'],
    } as ActivityReportParamsV2).join('\n');

    expect(query).toContain('aw-watcher-web-chrome_workstation');
    expect(query).toContain(`$source.${BUILTIN_WINDOW_SOURCE_ID}.app`);
    // The browser focus filter must use the namespaced key, never bare "app".
    expect(query).not.toMatch(/filter_keyvals\(events, "app"/);
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
      browser_bucket_ids: ['aw-watcher-web-chrome_workstation'],
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
    const perHost = [windowCoverageParams(), { ...windowCoverageParams(), hostname: 'laptop' }];
    const query = fullActivityMultiQueryV2(perHost, {
      app_title_source_id: BUILTIN_WINDOW_SOURCE_ID,
      browser_focus_source_id: BUILTIN_WINDOW_SOURCE_ID,
      browser_bucket_ids: [],
    }).join('\n');
    expect(query).toContain('events_mdev_0');
    expect(query).toContain('events_mdev_1');
    expect(query).toContain('union_no_overlap');
    expect(query).toContain('"activity"');
    expect(query).not.toContain('bid_window');
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
