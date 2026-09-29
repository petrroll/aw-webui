import {
  buildWorkReportQuery,
  buildWorkReportQueryV2,
  getSupportedWorkReportHosts,
  getUnsupportedWorkReportHosts,
  getWorkReportHostOptions,
} from '~/util/workReport';

const buckets = [
  {
    id: 'aw-watcher-window_laptop',
    hostname: 'laptop',
    device_id: 'laptop',
    type: 'currentwindow',
    data: {},
  },
  {
    id: 'aw-watcher-afk_laptop',
    hostname: 'laptop',
    device_id: 'laptop',
    type: 'afkstatus',
    data: {},
  },
  {
    id: 'aw-watcher-window_phone',
    hostname: 'phone',
    device_id: 'phone',
    type: 'currentwindow',
    data: {},
  },
];

describe('workReport host helpers', () => {
  const queryParams = (hosts: string[]) => ({
    hosts,
    host_params: Object.fromEntries(
      hosts.map(host => [
        host,
        {
          bid_window: `aw-watcher-window_${host}`,
          bid_afk: `aw-watcher-afk_${host}`,
        },
      ])
    ),
    filter_afk: true,
    categories: [],
    filter_categories: [],
    always_active_pattern: '',
  });

  test('getWorkReportHostOptions does not expose legacy-only hosts', () => {
    expect(getWorkReportHostOptions(buckets as any)).toEqual([]);
  });

  test('getUnsupportedWorkReportHosts rejects legacy-only hosts', () => {
    expect(getUnsupportedWorkReportHosts(['laptop', 'phone'], buckets as any)).toEqual([
      'laptop',
      'phone',
    ]);
  });

  test('getSupportedWorkReportHosts returns no legacy-only hosts', () => {
    expect(getSupportedWorkReportHosts(['laptop', 'phone'], buckets as any)).toEqual([]);
  });

  test('buildWorkReportQuery resolves the legacy profile through canonical host queries', () => {
    // Regression: aw-query's flood() takes one argument. A previous version
    // passed breakTimeSeconds as a second argument, which made aw-server
    // respond with HTTP 400 "Tried to call function flood with invalid amount
    // of arguments" and broke the whole report.
    const query = buildWorkReportQuery(queryParams(['laptop']), []);
    expect(query).toContain('legacy_activity = flood(query_bucket("aw-watcher-window_laptop"))');
    expect(query).toContain('not_afk = flood(query_bucket("aw-watcher-afk_laptop"))');
    // Must NOT contain flood() with two arguments
    expect(query).not.toMatch(/flood\([^)]+,[^)]+\)/);
  });

  test('buildWorkReportQuery produces a snapshot-stable query for multiple hosts', () => {
    const query = buildWorkReportQuery(queryParams(['laptop', 'desktop']), [['Work']]);
    expect(query).toMatchSnapshot();
  });

  test('getSupportedWorkReportHosts preserves selected host order', () => {
    const moreBuckets = [
      ...buckets,
      {
        id: 'aw-watcher-window_desktop',
        hostname: 'desktop',
        device_id: 'desktop',
        type: 'currentwindow',
        data: {},
      },
      {
        id: 'aw-watcher-afk_desktop',
        hostname: 'desktop',
        device_id: 'desktop',
        type: 'afkstatus',
        data: {},
      },
    ];

    expect(getSupportedWorkReportHosts(['desktop', 'phone', 'laptop'], moreBuckets as any)).toEqual(
      []
    );
  });

  test('supports a host resolved entirely from configured generic sources', () => {
    const genericBuckets = [
      {
        id: 'custom-activity',
        hostname: 'custom',
        device_id: 'custom',
        type: 'custom.activity',
        data: {},
      },
      {
        id: 'custom-active',
        hostname: 'custom',
        device_id: 'custom',
        type: 'custom.active',
        data: {},
      },
    ];
    const compiledV2 = {
      category_specs: [],
      context_sources: [],
      activity_coverage_sources: [
        {
          source_id: 'activity',
          bucket_ids: ['custom-activity'],
          scope: 'host' as const,
          bucket_hosts: { 'custom-activity': 'custom' },
          fields: ['name'],
        },
      ],
      active_time_rule: {
        type: 'regex' as const,
        source: 'active',
        field: 'state',
        regex: 'yes',
      },
      active_time_sources: [
        {
          source_id: 'active',
          bucket_ids: ['custom-active'],
          scope: 'host' as const,
          bucket_hosts: { 'custom-active': 'custom' },
        },
      ],
      capabilities: [
        'query.categorize_v2.v1',
        'query.merge_subwatcher_fields.source_namespace.v1',
        'query.active_periods_v2.v1',
        'query.query_bucket_optional_raw.v1',
        'query.query_period.v1',
        'query.flood_v2.v1',
      ],
    };

    expect(getWorkReportHostOptions(genericBuckets as any, compiledV2)).toEqual([
      { value: 'custom', text: 'custom', disabled: false },
    ]);

    const query = buildWorkReportQueryV2(
      [{ ...compiledV2, hostname: 'custom', filter_categories: [] }],
      []
    );
    expect(query).toContain('query_bucket_optional_raw("custom-activity", "custom")');
    expect(query).toContain('query_bucket_optional_raw("custom-active", "custom")');
    expect(query).not.toContain('aw-watcher-window');
    expect(query).not.toContain('aw-watcher-afk');
  });

  test('uses v2 host eligibility when a source-only profile is available', () => {
    const genericBuckets = [
      {
        id: 'custom-activity',
        hostname: 'custom',
        device_id: 'custom',
        type: 'custom.activity',
        data: {},
      },
      {
        id: 'custom-active',
        hostname: 'custom',
        device_id: 'custom',
        type: 'custom.active',
        data: {},
      },
    ];
    const compiledV2 = {
      category_specs: [],
      context_sources: [],
      activity_coverage_sources: [
        {
          source_id: 'activity',
          bucket_ids: ['custom-activity'],
          scope: 'host' as const,
          bucket_hosts: { 'custom-activity': 'custom' },
          fields: ['state'],
        },
      ],
      active_time_rule: {
        type: 'regex' as const,
        source: 'active',
        field: 'state',
        regex: 'yes',
      },
      active_time_sources: [
        {
          source_id: 'active',
          bucket_ids: ['custom-active'],
          scope: 'host' as const,
          bucket_hosts: { 'custom-active': 'custom' },
        },
      ],
      capabilities: [],
    };

    expect(getWorkReportHostOptions(genericBuckets as any, compiledV2)).toEqual([
      { value: 'custom', text: 'custom', disabled: false },
    ]);
    expect(getSupportedWorkReportHosts(['custom'], genericBuckets as any, compiledV2)).toEqual([
      'custom',
    ]);
  });

  test('v2 audible eligibility requires a configured browser-focus source', () => {
    const fallbackBuckets = [
      {
        id: 'custom-activity',
        hostname: 'custom',
        device_id: 'custom',
        type: 'custom.activity',
        data: {},
      },
      {
        id: 'aw-watcher-web-chrome',
        hostname: 'unknown',
        device_id: 'unknown',
        type: 'web.tab.current',
        data: {},
      },
    ];
    const compiledV2 = {
      category_specs: [],
      context_sources: [],
      activity_coverage_sources: [
        {
          source_id: 'activity',
          bucket_ids: ['custom-activity'],
          scope: 'host' as const,
          bucket_hosts: { 'custom-activity': 'custom' },
          fields: ['state'],
        },
      ],
      active_time_sources: [],
      browser_source: {
        source_id: 'browser',
        builtin: 'browser' as const,
        bucket_ids: [],
        scope: 'host' as const,
        fields: ['url', 'title', 'audible'],
        interval_policy: 'heartbeat' as const,
      },
      legacy_active_time: {
        use_afk: false,
        include_audible: true,
        always_active_pattern: '',
      },
      capabilities: [],
    };

    expect(getWorkReportHostOptions(fallbackBuckets as any, compiledV2, true)).toEqual([
      {
        value: 'custom',
        text: 'custom (requires an active-time source)',
        disabled: true,
      },
    ]);

    const focusedCompiledV2 = {
      ...compiledV2,
      browser_focus_source_id: 'focus',
      context_sources: [
        {
          source_id: 'focus',
          bucket_ids: ['custom-focus'],
          scope: 'host' as const,
          bucket_hosts: { 'custom-focus': 'custom' },
          fields: ['app'],
          conflict: 'base_wins' as const,
        },
      ],
    };
    const focusedBuckets = [
      ...fallbackBuckets,
      {
        id: 'custom-focus',
        hostname: 'custom',
        device_id: 'custom',
        type: 'currentwindow',
        data: {},
      },
    ];
    expect(
      getWorkReportHostOptions(focusedBuckets as any, focusedCompiledV2, true)
    ).toEqual([{ value: 'custom', text: 'custom', disabled: false }]);
  });
});
