import {
  compileActivityQueryV2,
  BUILTIN_WINDOW_SOURCE_ID,
  defaultBuiltinBrowserSource,
  defaultBuiltinStopwatchSource,
  defaultBuiltinWindowSource,
  resolveRulesV2Settings,
  type ActivityProfileV2,
  type CategorySetV2,
} from '~/util/rulesV2';
import { materializeActivityQueryV2, findWindowBucketIds } from '~/util/materializeV2';
import { resolveActivityProfileV2 } from '~/queries';
import { hostHasResolvedActivityV2, hostHasResolvedActiveTimeV2 } from '~/util/activityProfile';
import type { IBucket } from '~/util/interfaces';

const capabilities = [
  'query.categorize_v2.v1',
  'query.merge_subwatcher_fields.source_namespace.v1',
  'query.active_periods_v2.v1',
  'query.map_event_fields.v1',
];

const host = 'workstation';

function bucket(id: string, type: string): IBucket {
  return {
    id,
    hostname: host,
    device_id: 'device',
    type,
    data: {},
  } as IBucket;
}

const windowBucket = bucket('aw-watcher-window_workstation', 'currentwindow');
const afkBucket = bucket('aw-watcher-afk_workstation', 'afkstatus');
const stopwatchBucket = bucket('aw-stopwatch_workstation', 'general.stopwatch');
const browserBucket = bucket('aw-watcher-web-chrome_workstation', 'web.tab.current');
const meetingBucket = bucket('aw-watcher-meetings_workstation', 'meetings');

function meetingSet(sourceId: string): CategorySetV2 {
  return {
    schema_version: 2,
    id: 'default',
    categories: [
      {
        id: 'meeting',
        name: ['Meeting'],
        simple_ui: false,
        rule: { type: 'regex', source: sourceId, field: 'status', regex: 'busy' },
      },
    ],
  };
}

function simpleSet(): CategorySetV2 {
  return {
    schema_version: 2,
    id: 'default',
    categories: [
      { id: 'work', name: ['Work'], simple_ui: true, rule: { type: 'regex', regex: 'Code' } },
    ],
  };
}

describe('v2 clean resolver — window is an ordinary source', () => {
  test('meeting-only profile compiles and queries without any window source', () => {
    const profile: ActivityProfileV2 = {
      schema_version: 2,
      id: 'default',
      category_set_ids: ['default'],
      sources: [
        {
          id: 'meetings',
          label: 'Meetings',
          bucket_ids: [meetingBucket.id],
          scope: 'host',
          host,
          fields: ['status'],
          creates_activity: true,
        },
      ],
      active_time: {
        type: 'legacy',
        use_afk: true,
        include_audible: true,
        always_active_pattern: '',
      },
    };
    const compiled = compileActivityQueryV2(profile, [meetingSet('meetings')], capabilities);

    expect(compiled.activity_coverage_sources.map(s => s.source_id)).toEqual(['meetings']);
    expect(compiled.activity_coverage_sources.some(s => s.builtin === 'window')).toBe(false);
    expect(compiled).not.toHaveProperty('legacy_window_mode');

    const params = materializeActivityQueryV2({
      compiled,
      buckets: [meetingBucket, afkBucket],
      host,
      filterAfk: true,
    });
    const query = resolveActivityProfileV2(params);

    expect(query).not.toContain('aw-watcher-window');
    expect(query).not.toContain('bid_window');
    expect(query).toContain('aw-watcher-meetings_workstation');
    // AFK masking materialized from legacy settings.
    expect(query).toContain('active_periods_v2');
    expect(query).toContain('filter_period_intersect(events, not_afk)');
    expect(hostHasResolvedActivityV2(host, [meetingBucket], compiled)).toBe(true);
  });

  test('configured stopwatch materializes as an ordinary namespaced coverage source', () => {
    const profile: ActivityProfileV2 = {
      schema_version: 2,
      id: 'default',
      category_set_ids: ['default'],
      sources: [defaultBuiltinStopwatchSource()],
      active_time: {
        type: 'legacy',
        use_afk: true,
        include_audible: true,
        always_active_pattern: '',
      },
    };
    const emptySet: CategorySetV2 = { schema_version: 2, id: 'default', categories: [] };
    const compiled = compileActivityQueryV2(profile, [emptySet], capabilities);

    expect(compiled.activity_coverage_sources).toEqual([
      expect.objectContaining({
        source_id: 'stopwatch',
        builtin: 'stopwatch',
        bucket_ids: [],
      }),
    ]);

    const params = materializeActivityQueryV2({
      compiled,
      buckets: [stopwatchBucket],
      host,
      includeStopwatch: true,
    });
    expect(params.activity_coverage_sources.map(s => s.source_id)).toEqual(['stopwatch']);
    expect(
      hostHasResolvedActivityV2(host, [stopwatchBucket], compiled, {
        includeStopwatch: true,
      })
    ).toBe(true);

    const query = resolveActivityProfileV2(params);
    expect(query).not.toContain('aw-watcher-window');
    expect(query).toContain('aw-stopwatch_workstation');
    // Namespaced under a source id, not bid_stopwatch.
    expect(query).toContain('"source_id":"stopwatch"');
    expect(query).not.toContain('bid_stopwatch');
  });

  test('an unknown-host configured stopwatch fallback is global', () => {
    const profile: ActivityProfileV2 = {
      schema_version: 2,
      id: 'default',
      category_set_ids: ['default'],
      sources: [defaultBuiltinStopwatchSource()],
      active_time: {
        type: 'legacy',
        use_afk: false,
        include_audible: false,
        always_active_pattern: '',
      },
    };
    const compiled = compileActivityQueryV2(
      profile,
      [{ schema_version: 2, id: 'default', categories: [] }],
      capabilities
    );
    const unknownStopwatch = {
      ...stopwatchBucket,
      id: 'aw-stopwatch',
      hostname: 'unknown',
    };
    const params = materializeActivityQueryV2({
      compiled,
      buckets: [unknownStopwatch],
      host,
      includeStopwatch: true,
    });

    expect(params.activity_coverage_sources[0]).toMatchObject({
      source_id: 'stopwatch',
      bucket_ids: ['aw-stopwatch'],
      scope: 'global',
    });
    expect(params.activity_coverage_sources[0]).not.toHaveProperty('host');
  });

  test('includeStopwatch cannot inject an unconfigured coverage source', () => {
    const profile: ActivityProfileV2 = {
      schema_version: 2,
      source_defaults_version: 2,
      id: 'default',
      category_set_ids: ['default'],
      sources: [],
      active_time: {
        type: 'legacy',
        use_afk: false,
        include_audible: false,
        always_active_pattern: '',
      },
    };
    const compiled = compileActivityQueryV2(
      profile,
      [{ schema_version: 2, id: 'default', categories: [] }],
      capabilities
    );
    const params = materializeActivityQueryV2({
      compiled,
      buckets: [stopwatchBucket],
      host,
      includeStopwatch: true,
    });

    expect(params.activity_coverage_sources).toEqual([]);
  });

  test('configured browser context auto-discovers buckets only when a rule references it', () => {
    const profile: ActivityProfileV2 = {
      schema_version: 2,
      source_defaults_version: 2,
      id: 'default',
      category_set_ids: ['default'],
      sources: [defaultBuiltinWindowSource(), defaultBuiltinBrowserSource()],
      active_time: {
        type: 'legacy',
        use_afk: false,
        include_audible: false,
        always_active_pattern: '',
      },
    };
    const browserSet: CategorySetV2 = {
      schema_version: 2,
      id: 'default',
      categories: [
        {
          id: 'browser',
          name: ['Browser'],
          simple_ui: false,
          rule: { type: 'regex', source: 'browser', field: 'url', regex: 'github' },
        },
      ],
    };
    const compiled = compileActivityQueryV2(profile, [browserSet], capabilities);
    expect(compiled.context_sources).toEqual([
      expect.objectContaining({
        source_id: 'browser',
        builtin: 'browser',
        bucket_ids: [],
      }),
    ]);

    const params = materializeActivityQueryV2({
      compiled,
      buckets: [windowBucket, browserBucket],
      host,
    });
    expect(params.context_sources).toEqual([
      expect.objectContaining({
        source_id: 'browser',
        bucket_ids: [browserBucket.id],
        host,
      }),
    ]);
  });

  test('missing built-in active-time inputs remain named empty sources', () => {
    const profile: ActivityProfileV2 = {
      schema_version: 2,
      source_defaults_version: 2,
      id: 'default',
      category_set_ids: ['default'],
      sources: [defaultBuiltinWindowSource(), defaultBuiltinBrowserSource()],
      active_time: {
        type: 'expression',
        rule: {
          type: 'any',
          rules: [
            { type: 'regex', source: BUILTIN_WINDOW_SOURCE_ID, field: 'app', regex: 'Code' },
            { type: 'regex', source: 'browser', field: 'audible', regex: 'true' },
          ],
        },
      },
    };
    const compiled = compileActivityQueryV2(
      profile,
      [{ schema_version: 2, id: 'default', categories: [] }],
      capabilities
    );
    const params = materializeActivityQueryV2({
      compiled,
      buckets: [windowBucket],
      host,
      filterAfk: true,
    });

    expect(params.active_time_sources).toEqual([
      expect.objectContaining({
        source_id: BUILTIN_WINDOW_SOURCE_ID,
        bucket_ids: [windowBucket.id],
      }),
      expect.objectContaining({
        source_id: 'browser',
        bucket_ids: [],
      }),
    ]);
  });

  test('unconfigured window bucket is inert', () => {
    // Profile removed the window source; a currentwindow bucket is present but must
    // do nothing because no source references it.
    const profile: ActivityProfileV2 = {
      schema_version: 2,
      id: 'default',
      category_set_ids: ['default'],
      sources: [
        {
          id: 'meetings',
          label: 'Meetings',
          bucket_ids: [meetingBucket.id],
          scope: 'host',
          host,
          fields: ['status'],
          creates_activity: true,
        },
      ],
      active_time: {
        type: 'legacy',
        use_afk: true,
        include_audible: true,
        always_active_pattern: '',
      },
    };
    const compiled = compileActivityQueryV2(profile, [meetingSet('meetings')], capabilities);

    const params = materializeActivityQueryV2({
      compiled,
      buckets: [meetingBucket, windowBucket, afkBucket],
      host,
    });
    // Discovery finds the window bucket, but materialization must not inject it.
    expect(findWindowBucketIds([windowBucket], host)).toEqual([windowBucket.id]);
    expect(params.activity_coverage_sources.map(s => s.source_id)).toEqual(['meetings']);
    const query = resolveActivityProfileV2(params);
    expect(query).not.toContain('aw-watcher-window');
  });

  test('a configured window source with no host bucket is inert', () => {
    const profile: ActivityProfileV2 = {
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
    };
    const compiled = compileActivityQueryV2(profile, [simpleSet()], capabilities);
    expect(compiled.activity_coverage_sources.map(s => s.source_id)).toEqual([
      BUILTIN_WINDOW_SOURCE_ID,
    ]);

    // Host has no currentwindow bucket → window source drops out.
    const params = materializeActivityQueryV2({ compiled, buckets: [afkBucket], host });
    expect(params.activity_coverage_sources).toEqual([]);
    expect(hostHasResolvedActivityV2(host, [afkBucket], compiled)).toBe(false);
  });

  test('an unresolved expression source yields empty active coverage without throwing', () => {
    const profile: ActivityProfileV2 = {
      schema_version: 2,
      id: 'default',
      category_set_ids: ['default'],
      sources: [defaultBuiltinWindowSource()],
      active_time: {
        type: 'expression',
        rule: {
          type: 'regex',
          source: BUILTIN_WINDOW_SOURCE_ID,
          field: 'app',
          regex: 'Code',
        },
      },
    };
    const compiled = compileActivityQueryV2(profile, [simpleSet()], capabilities);
    const params = materializeActivityQueryV2({
      compiled,
      buckets: [],
      host,
      filterAfk: true,
    });

    expect(params.active_time_rule).toEqual(profile.active_time.rule);
    expect(params.active_time_sources).toEqual([
      expect.objectContaining({
        source_id: BUILTIN_WINDOW_SOURCE_ID,
        bucket_ids: [],
      }),
    ]);
    expect(resolveActivityProfileV2(params)).toContain(
      'events = filter_period_intersect(events, not_afk);'
    );
  });

  test('explicit configured window source is materialized as a namespaced source', () => {
    const profile: ActivityProfileV2 = {
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
    };
    const compiled = compileActivityQueryV2(profile, [simpleSet()], capabilities);
    // Unsourced simple rules are rewritten to reference the window source.
    expect(compiled.category_specs[0].rule).toMatchObject({
      type: 'regex',
      source: BUILTIN_WINDOW_SOURCE_ID,
    });

    const params = materializeActivityQueryV2({
      compiled,
      buckets: [windowBucket, afkBucket],
      host,
    });
    const windowCoverage = params.activity_coverage_sources.find(
      s => s.source_id === BUILTIN_WINDOW_SOURCE_ID
    );
    expect(windowCoverage?.bucket_ids).toEqual([windowBucket.id]);

    const query = resolveActivityProfileV2(params);
    expect(query).toContain('aw-watcher-window_workstation');
    // Enriched under a namespaced source id, never as authoritative root fields.
    expect(query).toContain(`"source_id":"${BUILTIN_WINDOW_SOURCE_ID}"`);
    expect(hostHasResolvedActivityV2(host, [windowBucket], compiled)).toBe(true);
  });

  test('a pinned builtin window source keeps its explicit buckets and ownership', () => {
    const pinnedWindow = {
      ...defaultBuiltinWindowSource(),
      bucket_ids: ['pinned-window'],
      scope: 'global' as const,
    };
    const profile: ActivityProfileV2 = {
      schema_version: 2,
      id: 'default',
      category_set_ids: ['default'],
      sources: [pinnedWindow],
      active_time: {
        type: 'legacy',
        use_afk: false,
        include_audible: false,
        always_active_pattern: '',
      },
    };
    const compiled = compileActivityQueryV2(profile, [simpleSet()], capabilities);
    const params = materializeActivityQueryV2({
      compiled,
      buckets: [windowBucket, bucket('pinned-window', 'custom-window')],
      host,
    });

    expect(params.activity_coverage_sources[0]).toMatchObject({
      source_id: BUILTIN_WINDOW_SOURCE_ID,
      bucket_ids: ['pinned-window'],
      scope: 'global',
    });
    expect(params.activity_coverage_sources[0].bucket_ids).not.toContain(windowBucket.id);
  });

  test('removing the window source round-trips without reinjection', () => {
    const stored: ActivityProfileV2 = {
      schema_version: 2,
      id: 'default',
      category_set_ids: ['default'],
      sources: [
        {
          id: 'meetings',
          label: 'Meetings',
          bucket_ids: [meetingBucket.id],
          scope: 'host',
          host,
          fields: ['status'],
          creates_activity: true,
        },
      ],
      active_time: {
        type: 'legacy',
        use_afk: true,
        include_audible: true,
        always_active_pattern: '',
      },
    };
    const resolved = resolveRulesV2Settings({
      activity_profiles_v2: [stored],
      category_sets_v2: [meetingSet('meetings')],
      classes: [],
    });
    expect(resolved.activity_profiles_v2[0].sources.some(s => s.builtin === 'window')).toBe(false);

    const compiled = compileActivityQueryV2(
      resolved.activity_profiles_v2[0],
      resolved.category_sets_v2,
      capabilities
    );
    expect(compiled.activity_coverage_sources.some(s => s.builtin === 'window')).toBe(false);
    expect(compiled.context_sources.some(s => s.builtin === 'window')).toBe(false);
  });

  test('active masking is uniform across legacy and expression active time', () => {
    // Expression active time keeps its explicit rule/sources.
    const expressionProfile: ActivityProfileV2 = {
      schema_version: 2,
      id: 'default',
      category_set_ids: ['default'],
      sources: [
        {
          id: 'presence',
          label: 'Presence',
          bucket_ids: ['aw-watcher-input_workstation'],
          scope: 'host',
          host,
          fields: ['state'],
          creates_activity: true,
        },
      ],
      active_time: {
        type: 'expression',
        rule: { type: 'regex', source: 'presence', field: 'state', regex: 'active' },
      },
    };
    const compiledExpr = compileActivityQueryV2(
      expressionProfile,
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
    const exprParams = materializeActivityQueryV2({
      compiled: compiledExpr,
      buckets: [bucket('aw-watcher-input_workstation', 'presence')],
      host,
      filterAfk: true,
    });
    expect(exprParams.active_time_rule).toMatchObject({ source: 'presence' });
    expect(resolveActivityProfileV2(exprParams)).toContain('active_periods_v2');

    // Legacy active time materializes an explicit AFK source + rule, plus a window
    // always-active branch when a pattern is configured.
    const legacyProfile: ActivityProfileV2 = {
      schema_version: 2,
      id: 'default',
      category_set_ids: ['default'],
      sources: [defaultBuiltinWindowSource()],
      active_time: {
        type: 'legacy',
        use_afk: true,
        include_audible: true,
        always_active_pattern: 'zoom',
      },
    };
    const compiledLegacy = compileActivityQueryV2(legacyProfile, [simpleSet()], capabilities);
    expect(compiledLegacy.legacy_active_time).toMatchObject({ always_active_pattern: 'zoom' });

    const legacyParams = materializeActivityQueryV2({
      compiled: compiledLegacy,
      buckets: [windowBucket, afkBucket],
      host,
      filterAfk: true,
    });
    expect(legacyParams.active_time_sources.map(s => s.source_id).sort()).toEqual([
      'afk',
      BUILTIN_WINDOW_SOURCE_ID,
    ]);
    const legacyQuery = resolveActivityProfileV2(legacyParams);
    expect(legacyQuery).toContain('active_periods_v2');
    expect(legacyQuery).toContain('filter_period_intersect(events, not_afk)');
    expect(hostHasResolvedActiveTimeV2(host, [windowBucket, afkBucket], compiledLegacy)).toBe(true);
  });
});

describe('v2 always-active pattern requires a configured window source', () => {
  const removedWindowProfile = (pattern: string): ActivityProfileV2 => ({
    schema_version: 2,
    id: 'default',
    category_set_ids: ['default'],
    sources: [
      {
        id: 'meetings',
        label: 'Meetings',
        bucket_ids: [meetingBucket.id],
        scope: 'host',
        host,
        fields: ['status'],
        creates_activity: true,
      },
    ],
    active_time: {
      type: 'legacy',
      use_afk: true,
      include_audible: false,
      always_active_pattern: pattern,
    },
  });

  test('compile rejects a nonempty always-active pattern when the window source was removed', () => {
    expect(() =>
      compileActivityQueryV2(removedWindowProfile('zoom'), [meetingSet('meetings')], capabilities)
    ).toThrow(/always_active_pattern requires a configured window source/);
  });

  test('with the window source removed and no pattern, a discovered window bucket is inert', () => {
    const compiled = compileActivityQueryV2(
      removedWindowProfile(''),
      [meetingSet('meetings')],
      capabilities
    );
    // The stray currentwindow bucket is present but no source references it.
    const params = materializeActivityQueryV2({
      compiled,
      buckets: [meetingBucket, windowBucket, afkBucket],
      host,
      filterAfk: true,
    });
    // No window always-active branch is rediscovered from the stray bucket.
    expect(params.active_time_sources.some(s => s.source_id === BUILTIN_WINDOW_SOURCE_ID)).toBe(
      false
    );
    const query = resolveActivityProfileV2(params);
    expect(query).not.toContain('aw-watcher-window');
  });

  test('a context-only window source still materializes the always-active branch', () => {
    // Window source is context-only (does not create activity) but referenced by a
    // category rule, so it survives compilation as a context source. The legacy
    // always-active pattern branch must still be materialized against it.
    const profile: ActivityProfileV2 = {
      schema_version: 2,
      id: 'default',
      category_set_ids: ['default'],
      sources: [
        defaultBuiltinWindowSource(false),
        {
          id: 'meetings',
          label: 'Meetings',
          bucket_ids: [meetingBucket.id],
          scope: 'host',
          host,
          fields: ['status'],
          creates_activity: true,
        },
      ],
      active_time: {
        type: 'legacy',
        use_afk: true,
        include_audible: false,
        always_active_pattern: 'zoom',
      },
    };
    const set: CategorySetV2 = {
      schema_version: 2,
      id: 'default',
      categories: [
        {
          id: 'meeting',
          name: ['Meeting'],
          simple_ui: false,
          rule: { type: 'regex', source: 'meetings', field: 'status', regex: 'busy' },
        },
        {
          id: 'coding',
          name: ['Coding'],
          simple_ui: false,
          rule: { type: 'regex', source: BUILTIN_WINDOW_SOURCE_ID, field: 'app', regex: 'Code' },
        },
      ],
    };
    const compiled = compileActivityQueryV2(profile, [set], capabilities);
    // Window source is a context source (not activity coverage).
    expect(compiled.activity_coverage_sources.some(s => s.builtin === 'window')).toBe(false);
    expect(compiled.context_sources.some(s => s.builtin === 'window')).toBe(true);

    const params = materializeActivityQueryV2({
      compiled,
      buckets: [meetingBucket, windowBucket, afkBucket],
      host,
      filterAfk: true,
    });
    expect(params.active_time_sources.some(s => s.source_id === BUILTIN_WINDOW_SOURCE_ID)).toBe(
      true
    );
    const query = resolveActivityProfileV2(params);
    expect(query).toContain('aw-watcher-window_workstation');
  });

  test('include_audible materializes explicit browser active-time branches', () => {
    const profile: ActivityProfileV2 = {
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
    };
    const compiled = compileActivityQueryV2(profile, [simpleSet()], capabilities);
    const browserBucketId = 'aw-watcher-web-chrome_workstation';
    const params = materializeActivityQueryV2({
      compiled,
      buckets: [windowBucket, afkBucket],
      host,
      filterAfk: true,
      includeAudible: true,
      browserBucketIds: [browserBucketId],
    });
    // An explicit generated browser active-time source (not a root injection).
    const audible = params.active_time_sources.find(s => s.source_id === 'browser_audible_0');
    expect(audible?.bucket_ids).toEqual([browserBucketId]);
    const query = resolveActivityProfileV2(params);
    expect(query).toContain(browserBucketId);
    expect(query).toContain('"field":"audible"');
    // AFK remains the base branch; audible is additive, never a root field.
    expect(query).not.toContain('bid_afk');
    expect(
      hostHasResolvedActiveTimeV2(
        host,
        [windowBucket, bucket(browserBucketId, 'web.tab.current')],
        compiled,
        {
          includeAudible: true,
          browserBucketIds: [browserBucketId],
        }
      )
    ).toBe(true);
  });

  test('an unknown-host audible fallback is a global active-time source', () => {
    const profile: ActivityProfileV2 = {
      schema_version: 2,
      id: 'default',
      category_set_ids: ['default'],
      sources: [defaultBuiltinWindowSource()],
      active_time: {
        type: 'legacy',
        use_afk: false,
        include_audible: true,
        always_active_pattern: '',
      },
    };
    const compiled = compileActivityQueryV2(profile, [simpleSet()], capabilities);
    const browserBucket = {
      ...bucket('aw-watcher-web-chrome', 'web.tab.current'),
      hostname: 'unknown',
    };
    const params = materializeActivityQueryV2({
      compiled,
      buckets: [windowBucket, browserBucket],
      host,
      includeAudible: true,
      browserBucketIds: [browserBucket.id],
    });

    expect(params.active_time_sources[0]).toMatchObject({
      bucket_ids: [browserBucket.id],
      scope: 'global',
    });
    expect(params.active_time_sources[0]).not.toHaveProperty('host');
  });
});
