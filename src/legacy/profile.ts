import _ from 'lodash';
import { browserAppNameRegex, browserAppNames, browsersWithBuckets } from '~/util/browser';
import {
  RULE_ENGINE_CAPABILITIES,
  activeTimeEvents,
  activityCoverageEvents,
  contextEvents,
  expectedSourceHostname,
  isAndroidParams,
  isDesktopParams,
  queryBucket,
  queryOptionalBucket,
  requireCapability,
  resolveSourceBucketIds,
  serializeQueryJson,
  serializeQueryString,
  type AndroidQueryParams,
  type DesktopQueryParams,
} from '~/queries';

export function resolveLegacyActivityProfile(
  params: DesktopQueryParams | AndroidQueryParams
): string {
  // Query2 strings preserve raw backslashes instead of decoding JSON escapes.
  const categories_str = params.categories ? serializeQueryJson(params.categories) : '';
  const always_active_pattern_str = isDesktopParams(params)
    ? params.always_active_pattern
    : undefined;
  const cat_filter_str = serializeQueryJson(params.filter_categories);
  const hasCategorySpecs = params.category_specs !== undefined;
  const category_specs = params.category_specs ?? [];
  const hasActiveTimeRule = isDesktopParams(params) && !!params.active_time_rule;
  const legacyWindowMode = isDesktopParams(params)
    ? params.legacy_window_mode ?? 'activity'
    : 'none';
  const legacyWindowFields = isDesktopParams(params)
    ? params.legacy_window_fields ?? ['app', 'title']
    : [];
  const supportsSourceNamespace =
    params.capabilities?.includes(RULE_ENGINE_CAPABILITIES.sourceNamespace) ?? false;
  if (
    isDesktopParams(params) &&
    params.bid_window &&
    legacyWindowMode === 'context' &&
    !supportsSourceNamespace
  ) {
    throw new Error(
      `Legacy window context requires server capability ${RULE_ENGINE_CAPABILITIES.sourceNamespace}`
    );
  }
  const category_specs_str = serializeQueryJson(category_specs);
  if (hasCategorySpecs) {
    requireCapability(params, RULE_ENGINE_CAPABILITIES.categorize, 'Flexible categorization');
    if (params.explain_categories) {
      requireCapability(
        params,
        RULE_ENGINE_CAPABILITIES.explainCategorize,
        'Category explanations'
      );
    }
  }

  return [
    isDesktopParams(params) &&
    (params.activity_coverage_sources?.length ?? 0) > 0 &&
    params.capabilities?.includes(RULE_ENGINE_CAPABILITIES.queryPeriod)
      ? 'query_bounds = query_period();'
      : '',
    'events = [];',
    isDesktopParams(params) && params.bid_window && legacyWindowMode !== 'none'
      ? `legacy_activity = flood(${queryBucket(params.bid_window)});` +
        (legacyWindowMode === 'activity'
          ? supportsSourceNamespace
            ? `
         legacy_activity_period = filter_period_intersect(legacy_activity, legacy_activity);
         events = period_union(events, legacy_activity_period);`
            : '\n         events = legacy_activity;'
          : '')
      : isAndroidParams(params)
      ? `events = flood(${queryBucket(params.bid_android)});`
      : '',
    params.bid_stopwatch
      ? `stopwatch_events = flood(query_bucket(${serializeQueryString(
          params.bid_stopwatch,
          'Stopwatch bucket ID'
        )}));`
      : 'stopwatch_events = [];',
    isDesktopParams(params) && params.bid_stopwatch && supportsSourceNamespace
      ? `stopwatch_period = filter_period_intersect(stopwatch_events, stopwatch_events);
         events = period_union(events, stopwatch_period);
         events = merge_subwatcher_fields(events, stopwatch_events, ["label"]);`
      : '',
    isDesktopParams(params) ? activityCoverageEvents(params) : '',
    isDesktopParams(params) &&
    params.bid_window &&
    legacyWindowMode !== 'none' &&
    supportsSourceNamespace
      ? `events = merge_subwatcher_fields(events, legacy_activity, ${serializeQueryJson(
          legacyWindowFields
        )});`
      : '',
    isDesktopParams(params) ? replacementActivityEvents(params) : '',
    isDesktopParams(params) && !hasActiveTimeRule
      ? params.bid_afk
        ? `not_afk = flood(${queryBucket(params.bid_afk)});
         not_afk = filter_keyvals(not_afk, "status", ["not-afk"]);` +
          (always_active_pattern_str
            ? `not_treat_as_afk = filter_keyvals_regex(events, "app", ${serializeQueryJson(
                always_active_pattern_str
              )});
             not_afk = period_union(not_afk, not_treat_as_afk);
             not_treat_as_afk = filter_keyvals_regex(events, "title", ${serializeQueryJson(
               always_active_pattern_str
             )});
             not_afk = period_union(not_afk, not_treat_as_afk);`
            : '')
        : 'not_afk = [];'
      : '',
    // Fetch browser events
    isDesktopParams(params) && params.bid_browsers
      ? browserEvents(params) +
        // Include focused and audible browser events as indications of not-afk
        (params.include_audible && !hasActiveTimeRule
          ? `audible_events = filter_keyvals(browser_events, "audible", [true]);
             not_afk = period_union(not_afk, audible_events);`
          : '')
      : '',
    isDesktopParams(params) ? activeTimeEvents(params) : '',
    isDesktopParams(params) && params.filter_afk
      ? hasActiveTimeRule || params.bid_afk
        ? 'events = filter_period_intersect(events, not_afk);'
        : (() => {
            throw new Error('Active filtering requires an active-time rule or AFK source');
          })()
      : '',
    params.bid_stopwatch && !supportsSourceNamespace
      ? 'events = union_no_overlap(stopwatch_events, events);'
      : '',
    isDesktopParams(params) ? backgroundActivityEvents(params) : '',
    contextEvents(params),
    // Categorize
    hasCategorySpecs
      ? `events = ${
          params.explain_categories ? 'categorize_v2_explain' : 'categorize_v2'
        }(events, ${category_specs_str}${
          params.hostname ? `, ${serializeQueryJson(params.hostname)}` : ''
        });`
      : params.categories
      ? `events = categorize(events, ${categories_str});`
      : '',
    // Filter out selected categories
    (params.filter_categories?.length ?? 0) > 0
      ? `events = filter_keyvals(events, "$category", ${cat_filter_str});`
      : '',
    // "Return" events by setting variable named with return_variable if set
    params.return_variable_suffix
      ? `events_${params.return_variable_suffix} = events;
         not_afk_${params.return_variable_suffix} = not_afk;`
      : '',
  ].join('\n');
}

export function replacementActivityEvents(params: DesktopQueryParams): string {
  const sources = params.activity_sources ?? [];
  if (sources.length === 0) return '';
  requireCapability(
    params,
    RULE_ENGINE_CAPABILITIES.mapEventFields,
    'Replacement activity sources'
  );

  return sources
    .map((source, index) => {
      if (!/^[A-Za-z0-9_-]+$/.test(source.source_id)) {
        throw new Error("Activity source_id may only contain letters, numbers, '_' and '-'");
      }
      if (source.bucket_ids.length === 0) {
        throw new Error('Activity source must contain at least one bucket_id');
      }
      const variable = `activity_source_${index}`;
      return [
        `${variable} = [];`,
        ...resolveSourceBucketIds(source, params.hostname).map(
          (bucketId, bucketIndex) =>
            `activity_bucket_${index}_${bucketIndex} = flood(${queryOptionalBucket(
              bucketId,
              expectedSourceHostname(params, source)
            )});
${variable} = union_no_overlap(${variable}, activity_bucket_${index}_${bucketIndex});`
        ),
        `${variable} = sort_by_timestamp(${variable});`,
        `${variable} = map_event_fields(${variable}, ${serializeQueryJson(
          source.field_mappings
        )});`,
        `events = union_no_overlap(${variable}, events);`,
      ].join('\n');
    })
    .join('\n');
}

export function backgroundActivityEvents(params: DesktopQueryParams): string {
  const sources = params.background_sources ?? [];
  if (sources.length === 0) return '';
  requireCapability(params, RULE_ENGINE_CAPABILITIES.mapEventFields, 'Background activity sources');
  if (!params.active_time_rule && !params.bid_afk) {
    throw new Error('Background activity sources require an active-time rule or AFK source');
  }

  return sources
    .map((source, index) => {
      if (!/^[A-Za-z0-9_-]+$/.test(source.source_id)) {
        throw new Error("Background source_id may only contain letters, numbers, '_' and '-'");
      }
      if (source.bucket_ids.length === 0) {
        throw new Error('Background source must contain at least one bucket_id');
      }
      const variable = `background_source_${index}`;
      return [
        `${variable} = [];`,
        ...resolveSourceBucketIds(source, params.hostname).map(
          (bucketId, bucketIndex) =>
            `background_bucket_${index}_${bucketIndex} = flood(${queryOptionalBucket(
              bucketId,
              expectedSourceHostname(params, source)
            )});
${variable} = union_no_overlap(${variable}, background_bucket_${index}_${bucketIndex});`
        ),
        `${variable} = filter_period_intersect(${variable}, not_afk);`,
        `${variable} = map_event_fields(${variable}, ${serializeQueryJson(
          source.field_mappings
        )});`,
        `${variable} = sort_by_timestamp(${variable});`,
        `events = union_no_overlap(events, ${variable});`,
      ].join('\n');
    })
    .join('\n');
}

export function browserEvents(params: DesktopQueryParams): string {
  let code = `
    browser_events = [];
  `;
  const seenBrowsers = new Set<string>();
  const legacyBrowserBuckets = browsersWithBuckets(params.bid_browsers).filter(([browserName]) => {
    if (seenBrowsers.has(browserName)) return false;
    seenBrowsers.add(browserName);
    return true;
  });

  _.each(legacyBrowserBuckets, ([browserName, bucketId]) => {
    const browser_appnames_str = serializeQueryJson(browserAppNames[browserName]);
    code += `events_${browserName} = flood(query_bucket(${serializeQueryString(
      bucketId,
      'Browser bucket ID'
    )}));
       window_${browserName} = filter_keyvals(events, "app", ${browser_appnames_str});`;

    // Add regex-based matching to cover case/spacing/versioning variants (e.g., Firefox.exe, firefox-esr-esr140)
    const pattern = browserAppNameRegex[browserName];
    if (pattern) {
      code += `
       window_${browserName}_re = filter_keyvals_regex(events, "app", ${serializeQueryJson(
        pattern
      )});
       window_${browserName} = sort_by_timestamp(concat(window_${browserName}, window_${browserName}_re));`;
    }

    code += `
       events_${browserName} = filter_period_intersect(events_${browserName}, window_${browserName});
       events_${browserName} = split_url_events(events_${browserName});
       browser_events = concat(browser_events, events_${browserName});
       browser_events = sort_by_timestamp(browser_events);`;
  });
  return code;
}
