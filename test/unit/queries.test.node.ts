/**
 * Tests for browser app name regex patterns in queries.ts.
 *
 * The patterns in browser_appname_regex replaced exhaustive exact-match lists that were
 * previously hardcoded in browser_appnames. Every app name that was in the old lists is
 * tested here as a regression guard. If a real-world app name is discovered that doesn't
 * match, add it to the relevant test below AND update the regex pattern in queries.ts.
 *
 * Historical exact-match lists (pre-regex):
 *
 *   Chrome:   'Google Chrome', 'Google-chrome', 'Chrome.exe', 'chrome.exe',
 *             'google-chrome-stable', 'Chromium', 'Chromium-browser', 'chromium-browser',
 *             'Chromium-browser-chromium', 'Chromium.exe', 'chromium.exe',
 *             'Google-chrome-beta', 'Google-chrome-unstable'
 *             (Flatpak app IDs retained as exact: 'com.google.Chrome', 'com.google.ChromeDev',
 *              'org.chromium.Chromium')
 *
 *   Firefox:  'Firefox', 'Firefox.exe', 'firefox', 'firefox.exe',
 *             'Firefox Developer Edition', 'firefoxdeveloperedition',
 *             'Firefox-esr', 'Firefox Beta', 'Nightly', 'firefox-aurora', 'firefox-trunk-dev',
 *             'LibreWolf-Portable.exe', 'LibreWolf', 'LibreWolf.exe', 'Librewolf', 'Librewolf.exe',
 *             'librewolf', 'librewolf.exe', 'librewolf-default',
 *             'Waterfox', 'Waterfox.exe', 'waterfox', 'waterfox.exe'
 *             (Flatpak app IDs retained as exact: 'org.mozilla.firefox',
 *              'io.gitlab.librewolf-community', 'net.waterfox.waterfox')
 *
 *   Opera:    'opera.exe', 'Opera.exe', 'Opera'
 *             (Flatpak app ID retained: 'com.opera.Opera')
 *
 *   Brave:    'Brave-browser', 'brave-browser', 'Brave Browser', 'brave.exe', 'Brave.exe'
 *             (Flatpak app ID retained: 'com.brave.Browser')
 *
 *   Edge:     'msedge.exe', 'Microsoft Edge', 'Microsoft Edge Beta',
 *             'Microsoft-Edge-Stable', 'Microsoft-edge', 'microsoft-edge',
 *             'microsoft-edge-beta', 'microsoft-edge-dev'
 *             (Flatpak app IDs retained: 'com.microsoft.Edge', 'com.microsoft.EdgeDev')
 *
 *   Arc:      'arc.exe', 'Arc.exe', 'Arc'
 *
 *   Vivaldi:  'Vivaldi-stable', 'Vivaldi-snapshot', 'vivaldi.exe', 'Vivaldi.exe', 'Vivaldi'
 *             (Flatpak app ID retained: 'com.vivaldi.Vivaldi')
 *
 *   Orion:    'Orion'
 *
 *   Yandex:   'Yandex'
 *             (Flatpak app ID retained: 'ru.yandex.Browser')
 *
 *   Zen:      'Zen', 'Zen Browser', 'Zen-browser', 'zen', 'zen browser', 'zen-browser',
 *             'zen.exe', 'Zen.exe'
 *             (Flatpak app ID retained: 'app.zen_browser.zen')
 *
 *   Floorp:   'Floorp', 'floorp.exe', 'Floorp.exe', 'floorp'
 *             (Flatpak app ID retained: 'one.ablaze.floorp')
 */

import {
  appQuery,
  activeTimeQuery,
  browser_appname_regex,
  canonicalEvents,
  canonicalMultideviceEvents,
  queryStringToArray,
  RULE_ENGINE_CAPABILITIES,
  serializeQueryJson,
} from '~/queries';

// Convert ActivityWatch (?i) patterns to JS RegExp with i flag for testing.
// AW server uses Python-style (?i) inline flag; JS uses RegExp 'i' flag instead.
function toRegex(pattern: string): RegExp {
  const stripped = pattern.replace(/^\(\?i\)/, '');
  return new RegExp(stripped, 'i');
}

describe('browser_appname_regex', () => {
  test('chrome pattern matches all known Chrome/Chromium app names', () => {
    const re = toRegex(browser_appname_regex.chrome);
    // Every entry from the old exact-match list
    const knownNames = [
      'Google Chrome',
      'Google-chrome',
      'Chrome.exe',
      'chrome.exe',
      'google-chrome-stable',
      'Google_Chrome',
      'Chromium',
      'Chromium-browser',
      'chromium-browser',
      'Chromium-browser-chromium',
      'Chromium.exe',
      'chromium.exe',
      'Google-chrome-beta',
      'Google-chrome-unstable',
    ];
    for (const name of knownNames) {
      expect(re.test(name)).toBe(true);
    }
  });

  test('chrome pattern does not false-positive', () => {
    const re = toRegex(browser_appname_regex.chrome);
    // Flatpak app IDs are in the exact list, not matched by regex
    expect(re.test('com.google.Chrome')).toBe(false);
    expect(re.test('Slack')).toBe(false);
    expect(re.test('Electron')).toBe(false);
  });

  test('firefox pattern matches all known Firefox/LibreWolf/Waterfox app names', () => {
    const re = toRegex(browser_appname_regex.firefox);
    // Every entry from the old exact-match list
    const knownNames = [
      'Firefox',
      'Firefox.exe',
      'firefox',
      'firefox.exe',
      'Firefox Developer Edition',
      'firefoxdeveloperedition',
      'Firefox-esr',
      'firefox-esr-esr140', // versioned ESR (issue #749)
      'Firefox Beta',
      'Nightly',
      'firefox-aurora',
      'firefox-trunk-dev',
      'LibreWolf-Portable.exe',
      'LibreWolf',
      'LibreWolf.exe',
      'Librewolf',
      'Librewolf.exe',
      'librewolf',
      'librewolf.exe',
      'librewolf-default',
      'Waterfox',
      'Waterfox.exe',
      'waterfox',
      'waterfox.exe',
    ];
    for (const name of knownNames) {
      expect(re.test(name)).toBe(true);
    }
  });

  test('opera pattern matches all known Opera app names', () => {
    const re = toRegex(browser_appname_regex.opera);
    const knownNames = ['opera.exe', 'Opera.exe', 'Opera'];
    for (const name of knownNames) {
      expect(re.test(name)).toBe(true);
    }
  });

  test('brave pattern matches all known Brave app names', () => {
    const re = toRegex(browser_appname_regex.brave);
    const knownNames = [
      'Brave-browser',
      'brave-browser',
      'Brave Browser',
      'brave.exe',
      'Brave.exe',
    ];
    for (const name of knownNames) {
      expect(re.test(name)).toBe(true);
    }
  });

  test('edge pattern matches all known Edge app names', () => {
    const re = toRegex(browser_appname_regex.edge);
    const knownNames = [
      'msedge.exe',
      'Microsoft Edge',
      'Microsoft Edge Beta',
      'Microsoft-Edge-Stable',
      'Microsoft-edge',
      'microsoft-edge',
      'microsoft-edge-beta',
      'microsoft-edge-dev',
    ];
    for (const name of knownNames) {
      expect(re.test(name)).toBe(true);
    }
  });

  test('arc pattern matches known Arc names but not arc-prefixed words', () => {
    const re = toRegex(browser_appname_regex.arc);
    // Known app names
    expect(re.test('Arc')).toBe(true);
    expect(re.test('arc.exe')).toBe(true);
    expect(re.test('Arc.exe')).toBe(true);
    // Must NOT match names that merely contain "arc"
    expect(re.test('archive')).toBe(false);
    expect(re.test('arcade')).toBe(false);
    expect(re.test('ReactNativeArcApp')).toBe(false);
  });

  test('vivaldi pattern matches all known Vivaldi app names', () => {
    const re = toRegex(browser_appname_regex.vivaldi);
    const knownNames = [
      'Vivaldi-stable',
      'Vivaldi-snapshot',
      'vivaldi.exe',
      'Vivaldi.exe',
      'Vivaldi',
    ];
    for (const name of knownNames) {
      expect(re.test(name)).toBe(true);
    }
  });

  test('orion pattern matches known Orion app names', () => {
    const re = toRegex(browser_appname_regex.orion);
    expect(re.test('Orion')).toBe(true);
    expect(re.test('orion')).toBe(true);
  });

  test('yandex pattern matches known Yandex app names', () => {
    const re = toRegex(browser_appname_regex.yandex);
    expect(re.test('Yandex')).toBe(true);
    expect(re.test('yandex')).toBe(true);
  });

  test('zen pattern matches all known Zen Browser app names', () => {
    const re = toRegex(browser_appname_regex.zen);
    const knownNames = [
      'Zen',
      'Zen Browser',
      'Zen-browser',
      'zen',
      'zen browser',
      'zen-browser',
      'zen.exe',
      'Zen.exe',
    ];
    for (const name of knownNames) {
      expect(re.test(name)).toBe(true);
    }
  });

  test('floorp pattern matches all known Floorp app names', () => {
    const re = toRegex(browser_appname_regex.floorp);
    const knownNames = ['Floorp', 'floorp.exe', 'Floorp.exe', 'floorp'];
    for (const name of knownNames) {
      expect(re.test(name)).toBe(true);
    }
  });
});

describe('flexible canonical queries', () => {
  const baseParams = {
    bid_window: 'aw-watcher-window_test',
    bid_afk: 'aw-watcher-afk_test',
    filter_afk: true,
    categories: [],
    filter_categories: [],
  };

  test('enriches context before v2 categorization when capabilities are present', () => {
    const query = canonicalEvents({
      ...baseParams,
      capabilities: [RULE_ENGINE_CAPABILITIES.categorize, RULE_ENGINE_CAPABILITIES.sourceNamespace],
      context_sources: [
        {
          source_id: 'vdesktop',
          bucket_ids: ['aw-watcher-vdesktop_test'],
          scope: 'global',
          fields: ['vdesktop'],
        },
      ],
      category_specs: [
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
    });

    expect(query).toContain('query_bucket_optional("aw-watcher-vdesktop_test")');
    expect(query).toContain('"source_id":"vdesktop"');
    expect(query).toContain('context_fields_0 = ["vdesktop"];');
    expect(query).toContain(
      'events = merge_subwatcher_fields(events, context_0, context_fields_0, context_options_0);'
    );
    expect(query).not.toContain('merge_subwatcher_fields(events, context_0, ["vdesktop"], {');
    expect(query.indexOf('merge_subwatcher_fields')).toBeLessThan(query.indexOf('categorize_v2'));
  });

  test('selects only context buckets belonging to the queried host', () => {
    const query = canonicalEvents({
      ...baseParams,
      hostname: 'laptop',
      capabilities: [RULE_ENGINE_CAPABILITIES.categorize, RULE_ENGINE_CAPABILITIES.sourceNamespace],
      context_sources: [
        {
          source_id: 'browser',
          bucket_ids: ['browser_laptop', 'browser_desktop'],
          scope: 'host',
          bucket_hosts: {
            browser_laptop: 'laptop',
            browser_desktop: 'desktop',
          },
          fields: ['url'],
        },
      ],
      category_specs: [],
    });

    expect(query).toContain('query_bucket_optional("browser_laptop")');
    expect(query).not.toContain('query_bucket_optional("browser_desktop")');
  });

  test('keeps legacy categorization as the default', () => {
    const query = canonicalEvents({
      ...baseParams,
      categories: [[['Work'], { type: 'regex', regex: 'devenv' }]],
    });

    expect(query).toContain('events = categorize(events');
    expect(query).not.toContain('categorize_v2');
  });

  test('treats an explicitly empty v2 category set as uncategorized', () => {
    const query = canonicalEvents({
      ...baseParams,
      categories: [[['Legacy'], { type: 'regex', regex: 'legacy' }]],
      category_specs: [],
      capabilities: [RULE_ENGINE_CAPABILITIES.categorize],
    });

    expect(query).toContain('events = categorize_v2(events, []);');
    expect(query).not.toContain('events = categorize(events');
  });

  test('applies v2 categorization to Android app queries', () => {
    const androidQuery = appQuery('aw-watcher-android_test', [], [], {
      category_specs: [{ id: 'work', name: ['Work'], rule: { type: 'none' } }],
      capabilities: [RULE_ENGINE_CAPABILITIES.categorize],
    }).join('\n');

    expect(androidQuery).toContain('events = categorize_v2(events');
    expect(androidQuery.slice(0, androidQuery.indexOf('events = categorize_v2'))).not.toContain(
      'merge_events_by_keys'
    );
  });

  test('keeps the released-server legacy window query free of v2 functions', () => {
    const query = canonicalEvents(baseParams);

    expect(query).toContain('events = legacy_activity;');
    expect(query).not.toContain('merge_subwatcher_fields');
    expect(query).not.toContain('legacy_activity_period');
  });

  test('projects configured built-in window fields', () => {
    const query = canonicalEvents({
      ...baseParams,
      capabilities: [RULE_ENGINE_CAPABILITIES.sourceNamespace],
      legacy_window_fields: ['title', 'url'],
    });

    expect(query).toContain(
      'events = merge_subwatcher_fields(events, legacy_activity, ["title","url"]);'
    );
  });

  test('serializes backslashes in bucket IDs and rejects unrepresentable trailing ones', () => {
    const query = canonicalEvents({
      ...baseParams,
      bid_window: String.raw`window\bucket`,
      filter_afk: false,
    });

    expect(query).toContain(String.raw`query_bucket("window\bucket")`);
    expect(() =>
      canonicalEvents({
        ...baseParams,
        bid_window: 'window\\',
        filter_afk: false,
      })
    ).toThrow('cannot end with an odd number of backslashes');
  });

  test('serializes quoted source bucket IDs exactly once', () => {
    const query = canonicalEvents({
      ...baseParams,
      capabilities: [RULE_ENGINE_CAPABILITIES.sourceNamespace],
      activity_coverage_sources: [
        {
          source_id: 'presence',
          bucket_ids: ['presence-"quoted'],
          scope: 'global',
          fields: ['state'],
        },
      ],
    });

    expect(query).toContain(String.raw`query_bucket_optional("presence-\"quoted")`);
    expect(query).not.toContain(String.raw`presence-\\\"quoted`);
  });

  test('does not load implicit window activity for explicit advanced sources', () => {
    const query = canonicalEvents({
      ...baseParams,
      legacy_window_mode: 'none',
      capabilities: [RULE_ENGINE_CAPABILITIES.categorize, RULE_ENGINE_CAPABILITIES.sourceNamespace],
      category_specs: [],
      activity_coverage_sources: [
        {
          source_id: 'presence',
          bucket_ids: ['presence'],
          scope: 'global',
          fields: ['state'],
        },
      ],
    });

    expect(query).not.toContain('legacy_activity');
    expect(query).not.toContain('aw-watcher-window_test');
    expect(query).toContain('query_bucket_optional("presence")');
  });

  test('uses the diagnostic categorizer for previews', () => {
    const query = canonicalEvents({
      ...baseParams,
      category_specs: [{ id: 'work', name: ['Work'], rule: { type: 'none' } }],
      explain_categories: true,
      capabilities: [
        RULE_ENGINE_CAPABILITIES.categorize,
        RULE_ENGINE_CAPABILITIES.explainCategorize,
      ],
    });

    expect(query).toContain('events = categorize_v2_explain(events');
  });

  test('keeps semicolons inside query string literals', () => {
    expect(queryStringToArray('rule = {"regex": "foo;bar"}; RETURN = rule;')).toEqual([
      'rule = {"regex": "foo;bar"};',
      'RETURN = rule;',
    ]);
  });

  test('serializes valid regexes ending in a literal backslash', () => {
    const query = canonicalEvents({
      ...baseParams,
      category_specs: [
        {
          id: 'path',
          name: ['Path'],
          rule: { type: 'regex', regex: String.raw`path\\` },
        },
      ],
      capabilities: [RULE_ENGINE_CAPABILITIES.categorize],
    });

    expect(query).toContain(String.raw`"regex":"path\\"`);
    expect(query).toContain('events = categorize_v2(events,');
  });

  test('serializes regexes containing an escaped quote without corrupting the query string', () => {
    expect(serializeQueryJson({ regex: String.raw`a\"b` })).toBe(
      String.raw`{"regex":"a\\\"b"}`
    );
  });

  test('serializes custom field mappings without doubling raw backslashes', () => {
    expect(serializeQueryJson({ 'path\\name': 'source\\field' })).toBe(
      String.raw`{"path\name":"source\field"}`
    );
  });

  test('rejects unrepresentable strings anywhere in structured query values', () => {
    expect(() => serializeQueryJson({ category: ['invalid\\'] })).toThrow(
      'cannot end with an odd number of backslashes'
    );
  });

  test('rejects advanced queries when the server lacks capabilities', () => {
    expect(() =>
      canonicalEvents({
        ...baseParams,
        category_specs: [{ name: ['Work'], rule: { type: 'none' } }],
      })
    ).toThrow(RULE_ENGINE_CAPABILITIES.categorize);
  });

  test('compiles active-time expressions as overlap masks', () => {
    const query = canonicalEvents({
      ...baseParams,
      hostname: 'workstation',
      capabilities: [RULE_ENGINE_CAPABILITIES.activePeriods],
      active_time_sources: [
        {
          source_id: 'window',
          bucket_ids: ['aw-watcher-window_test'],
          scope: 'host',
          host: 'workstation',
        },
        {
          source_id: 'afk',
          bucket_ids: ['aw-watcher-afk_test'],
          scope: 'host',
          host: 'workstation',
        },
      ],
      active_time_rule: {
        type: 'all',
        rules: [
          { type: 'regex', source: 'window', field: 'app', regex: 'Teams' },
          {
            type: 'regex',
            source: 'afk',
            host: 'workstation',
            field: 'status',
            regex: 'not-afk',
          },
        ],
      },
    });

    expect(query).toContain('not_afk = active_periods_v2(');
    expect(query).toContain('["window", active_source_0]');
    expect(query).toContain('active_time_rule, "workstation")');
    expect(query).not.toContain('not_afk = filter_keyvals(not_afk');
    expect(query.indexOf('active_periods_v2')).toBeLessThan(
      query.indexOf('filter_period_intersect(events, not_afk)')
    );
  });

  test('maps and applies replacement activity sources by priority order', () => {
    const query = canonicalEvents({
      ...baseParams,
      capabilities: [RULE_ENGINE_CAPABILITIES.mapEventFields],
      activity_sources: [
        {
          source_id: 'low',
          bucket_ids: ['meeting-low-primary', 'meeting-low-secondary'],
          scope: 'global',
          field_mappings: {},
        },
        {
          source_id: 'high',
          bucket_ids: ['meeting-high'],
          scope: 'global',
          field_mappings: { title: 'subject' },
        },
      ],
    });

    expect(query).toContain('map_event_fields(activity_source_1, {"title":"subject"})');
    expect(query).toContain(
      'activity_source_0 = union_no_overlap(activity_source_0, activity_bucket_0_0)'
    );
    expect(query).toContain(
      'activity_source_0 = union_no_overlap(activity_source_0, activity_bucket_0_1)'
    );
    expect(query.indexOf('events = union_no_overlap(activity_source_0, events)')).toBeLessThan(
      query.indexOf('events = union_no_overlap(activity_source_1, events)')
    );
  });

  test('passes the current host and suppresses sources bound to another host', () => {
    const query = canonicalEvents({
      ...baseParams,
      hostname: 'workstation',
      capabilities: [RULE_ENGINE_CAPABILITIES.categorize, RULE_ENGINE_CAPABILITIES.sourceNamespace],
      category_specs: [
        {
          name: ['Workstation'],
          rule: { type: 'regex', host: 'workstation', regex: 'editor' },
        },
      ],
      context_sources: [
        {
          source_id: 'other',
          bucket_ids: ['context-other'],
          scope: 'host',
          fields: ['project'],
          host: 'laptop',
        },
      ],
    });

    expect(query).toContain('categorize_v2(events,');
    expect(query).toContain(', "workstation");');
    expect(query).not.toContain('context-other');
  });

  test('builds a generic activity stream without window or AFK buckets', () => {
    const query = canonicalEvents({
      hostname: 'desktop',
      filter_afk: false,
      categories: [],
      filter_categories: [],
      capabilities: [
        RULE_ENGINE_CAPABILITIES.mapEventFields,
        RULE_ENGINE_CAPABILITIES.categorize,
        RULE_ENGINE_CAPABILITIES.sourceNamespace,
      ],
      activity_coverage_sources: [
        {
          source_id: 'meeting',
          bucket_ids: ['meeting_desktop'],
          scope: 'host',
          host: 'desktop',
          fields: ['subject'],
        },
        {
          source_id: 'vdesktop',
          bucket_ids: ['vdesktop_desktop'],
          scope: 'host',
          host: 'desktop',
          fields: ['desktop'],
        },
      ],
      category_specs: [
        {
          id: 'work',
          name: ['Work'],
          rule: {
            type: 'regex',
            source: 'vdesktop',
            field: 'desktop',
            regex: '^Work$',
          },
        },
      ],
    });

    expect(query).toContain('events = [];');
    expect(query).toContain('query_bucket_optional("meeting_desktop")');
    expect(query).not.toContain('aw-watcher-window');
    expect(query).not.toContain('aw-watcher-afk');
    expect(query).toContain(
      'events = period_union(events, activity_coverage_period_0)'
    );
    expect(query).toContain(
      'events = period_union(events, activity_coverage_period_1)'
    );
    expect(query).toContain('"source_id":"meeting"');
    expect(query).toContain('"source_id":"vdesktop"');
    expect(query).not.toContain('events = union_no_overlap(activity_coverage_source_');
    expect(query.indexOf('activity_coverage_options_1')).toBeLessThan(
      query.indexOf('categorize_v2')
    );
  });

  test('rejects duplicate abstract activity source ids', () => {
    expect(() =>
      canonicalEvents({
        hostname: 'desktop',
        filter_afk: false,
        categories: [],
        filter_categories: [],
        capabilities: [RULE_ENGINE_CAPABILITIES.sourceNamespace],
        activity_coverage_sources: [
          {
            source_id: 'presence',
            bucket_ids: ['meeting_desktop'],
            scope: 'host',
            host: 'desktop',
            fields: ['subject'],
          },
          {
            source_id: 'presence',
            bucket_ids: ['desktop_desktop'],
            scope: 'host',
            host: 'desktop',
            fields: ['vdesktop'],
          },
        ],
      })
    ).toThrow('Duplicate activity coverage source id: presence');
  });

  test('fills active gaps from background sources without replacing activity', () => {
    const query = canonicalEvents({
      ...baseParams,
      hostname: 'desktop',
      capabilities: [
        RULE_ENGINE_CAPABILITIES.mapEventFields,
        RULE_ENGINE_CAPABILITIES.activePeriods,
      ],
      active_time_sources: [
        {
          source_id: 'presence',
          bucket_ids: ['presence_desktop'],
          scope: 'host',
          host: 'desktop',
        },
      ],
      active_time_rule: {
        type: 'regex',
        source: 'presence',
        field: 'status',
        regex: 'active',
      },
      background_sources: [
        {
          source_id: 'desktop',
          bucket_ids: ['vdesktop_desktop'],
          scope: 'host',
          host: 'desktop',
          field_mappings: { title: 'vdesktop' },
        },
      ],
    });

    expect(query).toContain(
      'background_source_0 = filter_period_intersect(background_source_0, not_afk)'
    );
    expect(query).toContain('map_event_fields(background_source_0, {"title":"vdesktop"})');
    expect(query).toContain('events = union_no_overlap(events, background_source_0)');
    expect(query.indexOf('filter_period_intersect(events, not_afk)')).toBeLessThan(
      query.indexOf('events = union_no_overlap(events, background_source_0)')
    );
  });

  test('requires active-time input for background activity', () => {
    expect(() =>
      canonicalEvents({
        hostname: 'desktop',
        filter_afk: false,
        categories: [],
        filter_categories: [],
        capabilities: [RULE_ENGINE_CAPABILITIES.mapEventFields],
        background_sources: [
          {
            source_id: 'desktop',
            bucket_ids: ['vdesktop_desktop'],
            scope: 'global',
            field_mappings: {},
          },
        ],
      })
    ).toThrow('Background activity sources require an active-time rule or AFK source');
  });

  test('preserves legacy stopwatch activity outside the active-time mask', () => {
    const query = canonicalEvents({
      ...baseParams,
      bid_stopwatch: 'stopwatch',
      filter_afk: true,
    });

    expect(query).not.toContain('stopwatch_period');
    expect(query.indexOf('events = union_no_overlap(stopwatch_events, events)')).toBeGreaterThan(
      query.indexOf('events = filter_period_intersect(events, not_afk)')
    );
  });

  test('masks stopwatch coverage with active time on capable servers', () => {
    const query = canonicalEvents({
      ...baseParams,
      bid_stopwatch: 'stopwatch',
      filter_afk: true,
      capabilities: [RULE_ENGINE_CAPABILITIES.sourceNamespace],
    });

    expect(query).toContain('stopwatch_period');
    expect(query.indexOf('events = period_union(events, stopwatch_period)')).toBeLessThan(
      query.indexOf('events = filter_period_intersect(events, not_afk)')
    );
    expect(query).not.toContain('events = union_no_overlap(stopwatch_events, events)');
  });

  test('combines all host foreground activity before background gap fillers', () => {
    const query = canonicalMultideviceEvents({
      hosts: ['laptop', 'desktop'],
      host_params: {
        laptop: {
          bid_window: 'window_laptop',
          bid_afk: 'afk_laptop',
        },
        desktop: {
          bid_window: 'window_desktop',
          bid_afk: 'afk_desktop',
        },
      },
      filter_afk: false,
      always_active_pattern: '',
      categories: [],
      filter_categories: [['Work']],
      capabilities: [RULE_ENGINE_CAPABILITIES.mapEventFields],
      background_sources: [
        {
          source_id: 'calendar',
          bucket_ids: ['calendar_global'],
          scope: 'global',
          field_mappings: {},
        },
      ],
    });

    const lastForegroundMerge = query.indexOf('events = union_no_overlap(events, events_host_1)');
    const firstBackgroundMerge = query.indexOf(
      'events = union_no_overlap(events, events_background_host_0)'
    );
    expect(lastForegroundMerge).toBeGreaterThan(-1);
    expect(firstBackgroundMerge).toBeGreaterThan(lastForegroundMerge);
    expect(query.lastIndexOf('filter_keyvals(events, "$category"')).toBeGreaterThan(
      firstBackgroundMerge
    );
  });

  test('does not rebuild coverage during the multidevice background-only pass', () => {
    const query = canonicalMultideviceEvents({
      hosts: ['laptop', 'desktop'],
      host_params: {},
      filter_afk: false,
      always_active_pattern: '',
      categories: [],
      filter_categories: [],
      capabilities: [
        RULE_ENGINE_CAPABILITIES.sourceNamespace,
        RULE_ENGINE_CAPABILITIES.mapEventFields,
      ],
      activity_coverage_sources: [
        {
          source_id: 'presence',
          bucket_ids: ['presence_global'],
          scope: 'global',
          fields: ['state'],
        },
      ],
      background_sources: [
        {
          source_id: 'legacy-background',
          bucket_ids: ['background_global'],
          scope: 'global',
          field_mappings: {},
        },
      ],
    });

    expect(query.match(/query_bucket_optional\("presence_global"\)/g)).toHaveLength(2);
  });

  test('uses conventional per-host watcher buckets when no override is supplied', () => {
    const query = canonicalMultideviceEvents({
      hosts: ['laptop'],
      host_params: {},
      filter_afk: true,
      always_active_pattern: '',
      categories: [],
      filter_categories: [],
    });

    expect(query).toContain('query_bucket("aw-watcher-window_laptop")');
    expect(query).toContain('query_bucket("aw-watcher-afk_laptop")');
  });

  test('does not inherit a selected host stopwatch bucket into another host', () => {
    const query = canonicalMultideviceEvents({
      hosts: ['laptop', 'desktop'],
      bid_stopwatch: 'stopwatch_laptop',
      host_params: {
        laptop: { bid_window: 'window_laptop', bid_stopwatch: 'stopwatch_laptop' },
        desktop: { bid_window: 'window_desktop', bid_stopwatch: undefined },
      },
      filter_afk: false,
      always_active_pattern: '',
      categories: [],
      filter_categories: [],
    });

    expect(query.match(/query_bucket\("stopwatch_laptop"\)/g)).toHaveLength(1);
  });

  test('builds active-time-only queries without activity sources', () => {
    const query = activeTimeQuery({
      hostname: 'desktop',
      capabilities: [RULE_ENGINE_CAPABILITIES.activePeriods],
      active_time_sources: [
        {
          source_id: 'presence',
          bucket_ids: ['presence_desktop'],
          scope: 'host',
          host: 'desktop',
        },
      ],
      active_time_rule: {
        type: 'regex',
        source: 'presence',
        field: 'present',
        regex: 'true',
      },
    });

    expect(query).toContain('active_periods_v2');
    expect(query).toContain('RETURN = not_afk;');
    expect(query).not.toContain('events =');
    expect(query).not.toContain('categorize');
  });

  test('does not infer global scope from missing ownership', () => {
    expect(() =>
      canonicalEvents({
        ...baseParams,
        hostname: 'desktop',
        capabilities: [RULE_ENGINE_CAPABILITIES.sourceNamespace],
        context_sources: [
          {
            source_id: 'browser',
            bucket_ids: ['browser_laptop'],
            fields: ['url'],
          },
        ],
      })
    ).toThrow('Source scope must be explicit');
  });

  test('allows explicitly global sources for every host', () => {
    for (const hostname of ['laptop', 'desktop']) {
      const query = canonicalEvents({
        ...baseParams,
        hostname,
        capabilities: [RULE_ENGINE_CAPABILITIES.sourceNamespace],
        context_sources: [
          {
            source_id: 'calendar',
            bucket_ids: ['calendar_global'],
            scope: 'global',
            fields: ['meeting'],
          },
        ],
      });
      expect(query).toContain('query_bucket_optional("calendar_global")');
    }
  });

  test('asks capable servers to enforce host-scoped source ownership', () => {
    const query = canonicalEvents({
      ...baseParams,
      hostname: 'laptop',
      capabilities: [
        RULE_ENGINE_CAPABILITIES.sourceNamespace,
        RULE_ENGINE_CAPABILITIES.expectedBucketHostname,
      ],
      context_sources: [
        {
          source_id: 'editor',
          bucket_ids: ['editor_laptop'],
          host: 'laptop',
          fields: ['project'],
        },
        {
          source_id: 'calendar',
          bucket_ids: ['calendar_global'],
          scope: 'global',
          fields: ['meeting'],
        },
      ],
    });

    expect(query).toContain('query_bucket_optional("editor_laptop", "laptop")');
    expect(query).toContain('query_bucket_optional("calendar_global")');
  });
});
