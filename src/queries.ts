import _ from 'lodash';
import type { RuleExpressionV2 } from '~/util/rulesV2';

// TODO: Sanitize string input of buckets

export function queryStringToArray(querystr: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inString = false;
  let escaped = false;
  for (const character of querystr) {
    current += character;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
    } else if (character === '"') {
      inString = true;
    } else if (character === ';') {
      if (current.slice(0, -1).trim()) statements.push(current.trim());
      current = '';
    }
  }
  if (current.trim()) statements.push(`${current.trim()};`);
  return statements;
}

export function serializeQueryJson(value: unknown): string {
  assertQueryValueRepresentable(value);
  const json = JSON.stringify(value);
  let serialized = '';
  for (let index = 0; index < json.length; ) {
    if (json[index] !== '\\') {
      serialized += json[index++];
      continue;
    }
    let end = index;
    while (json[end] === '\\') end++;
    const count = end - index;
    serialized += '\\'.repeat(count % 2 === 0 ? count / 2 : count);
    index = end;
  }
  return serialized;
}

function assertQueryValueRepresentable(value: unknown, path = 'value'): void {
  if (typeof value === 'string') {
    const trailingBackslashes = value.match(/\\+$/)?.[0].length ?? 0;
    if (trailingBackslashes % 2 === 1) {
      throw new Error(`${path} cannot end with an odd number of backslashes in Query2`);
    }
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => assertQueryValueRepresentable(item, `${path}[${index}]`));
  } else if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, item]) => {
      assertQueryValueRepresentable(key, `${path} key`);
      assertQueryValueRepresentable(item, `${path}.${key}`);
    });
  }
}

// Hostname safe for using as a variable name
export function safeHostname(hostname: string): string {
  return hostname.replace(/[^a-zA-Z0-9_]/g, '');
}

interface Rule {
  type: string;
  regex?: string;
}

type Category = [string[], Rule];

export interface ContextSource {
  source_id: string;
  bucket_ids: string[];
  scope?: 'host' | 'global';
  bucket_hosts?: Record<string, string>;
  fields: string[];
  conflict?: 'base_wins' | 'sub_wins';
  host?: string;
}

export interface ActiveTimeSource {
  source_id: string;
  bucket_ids: string[];
  scope?: 'host' | 'global';
  bucket_hosts?: Record<string, string>;
  host?: string;
}

export interface ActivitySource {
  source_id: string;
  bucket_ids: string[];
  scope?: 'host' | 'global';
  bucket_hosts?: Record<string, string>;
  field_mappings: Record<string, string>;
  host?: string;
}

export interface ActivityCoverageSource {
  source_id: string;
  bucket_ids: string[];
  scope?: 'host' | 'global';
  bucket_hosts?: Record<string, string>;
  fields: string[];
  host?: string;
}

export type CategorySpecV2 = Record<string, unknown>;

export const RULE_ENGINE_CAPABILITIES = {
  categorize: 'query.categorize_v2.v1',
  explainCategorize: 'query.categorize_v2_explain.v1',
  sourceNamespace: 'query.merge_subwatcher_fields.source_namespace.v1',
  activePeriods: 'query.active_periods_v2.v1',
  mapEventFields: 'query.map_event_fields.v1',
  expectedBucketHostname: 'query.query_bucket_optional.expected_hostname.v1',
} as const;

interface BaseQueryParams {
  hostname?: string;
  include_audible?: boolean;
  categories: Category[];
  category_specs?: CategorySpecV2[];
  explain_categories?: boolean;
  context_sources?: ContextSource[];
  capabilities?: string[];
  filter_categories: string[][];
  bid_browsers?: string[];
  bid_stopwatch?: string;
  return_variable_suffix?: string;
}

export interface DesktopQueryParams extends BaseQueryParams {
  bid_window?: string;
  bid_afk?: string;
  legacy_window_mode?: 'activity' | 'context' | 'none';
  legacy_window_fields?: string[];
  filter_afk: boolean;
  always_active_pattern?: string;
  active_time_rule?: RuleExpressionV2;
  active_time_sources?: ActiveTimeSource[];
  activity_coverage_sources?: ActivityCoverageSource[];
  /** @deprecated Replacement semantics retained for compatibility. */
  activity_sources?: ActivitySource[];
  /** @deprecated Post-mask gap-filling semantics retained for compatibility. */
  background_sources?: ActivitySource[];
}

export interface AndroidQueryParams extends BaseQueryParams {
  bid_android: string;
}

export interface MultiQueryParams extends BaseQueryParams {
  hosts: string[];
  filter_afk: boolean;
  always_active_pattern: string;
  // This can be used to override params on a per-host basis
  host_params: {
    [host: string]: Partial<DesktopQueryParams> | Partial<AndroidQueryParams>;
  };
}

function get_params(
  params: MultiQueryParams,
  host: string,
  returnVariableSuffix: string
): DesktopQueryParams | AndroidQueryParams {
  // Return the params for a given host, based on the self params and any overrides in host_params.
  // If no overrides are found, return the base params.
  const new_params: DesktopQueryParams = {
    ...params,
    hostname: host,
    bid_window: 'aw-watcher-window_' + host,
    bid_afk: 'aw-watcher-afk_' + host,
    bid_browsers: [],
    bid_stopwatch: undefined,
    return_variable_suffix: returnVariableSuffix,
  };

  const host_params = params.host_params[host];
  if (host_params) {
    if (isAndroidParams(host_params)) {
      console.error(`Invalid host_params for host ${host}: ${JSON.stringify(host_params)}`);
    }
    // Host-specific values, including empty arrays and explicit undefined values,
    // must override the multidevice defaults to prevent cross-host bucket leakage.
    Object.keys(host_params).forEach(key => {
      new_params[key] = host_params[key];
    });
  }
  return new_params;
}

function isDesktopParams(object: any): object is DesktopQueryParams {
  return !isAndroidParams(object);
}

function isAndroidParams(object: any): object is AndroidQueryParams {
  return 'bid_android' in object;
}

function isMultiParams(object: any): object is MultiQueryParams {
  return 'hosts' in object;
}

// Use query_bucket directly when we have a full bucket ID (contains hostname after the prefix).
// Fall back to find_bucket only when the ID is partial (ends with '_', meaning hostname is unknown).
// This avoids find_bucket matching wrong buckets when similar names exist (e.g. host vs host.local).
// See: https://github.com/ActivityWatch/aw-webui/issues/590
function queryBucket(bid: string): string {
  const serializedBid = serializeQueryString(bid, 'Bucket ID');
  if (bid.endsWith('_')) {
    return `query_bucket(find_bucket(${serializedBid}))`;
  }
  return `query_bucket(${serializedBid})`;
}

function queryOptionalBucket(bid: string, expectedHostname?: string): string {
  const args = [serializeQueryString(bid, 'Bucket ID')];
  if (expectedHostname) args.push(serializeQueryJson(expectedHostname));
  return `query_bucket_optional(${args.join(', ')})`;
}

function expectedSourceHostname(
  params: BaseQueryParams,
  source: { scope?: 'host' | 'global'; host?: string }
): string | undefined {
  return source.scope !== 'global' &&
    params.hostname &&
    params.capabilities?.includes(RULE_ENGINE_CAPABILITIES.expectedBucketHostname)
    ? params.hostname
    : undefined;
}

function serializeQueryString(value: string, label: string): string {
  const trailingBackslashes = value.match(/\\+$/)?.[0].length ?? 0;
  if (trailingBackslashes % 2 === 1) {
    throw new Error(`${label} cannot end with an odd number of backslashes in Query2`);
  }
  return serializeQueryJson(value);
}

function requireCapability(params: BaseQueryParams, capability: string, feature: string): void {
  if (!params.capabilities?.includes(capability)) {
    throw new Error(`${feature} requires server capability ${capability}`);
  }
}

export function resolveSourceBucketIds(
  source: {
    bucket_ids: string[];
    scope?: 'host' | 'global';
    bucket_hosts?: Record<string, string>;
    host?: string;
  },
  hostname?: string
) {
  if (new Set(source.bucket_ids).size !== source.bucket_ids.length) {
    throw new Error('Source bucket_ids must be unique');
  }
  const mappedBucketIds = Object.keys(source.bucket_hosts ?? {});
  const hasCompleteBucketHosts =
    mappedBucketIds.length === source.bucket_ids.length &&
    source.bucket_ids.every(bucketId => !!source.bucket_hosts?.[bucketId]) &&
    mappedBucketIds.every(bucketId => source.bucket_ids.includes(bucketId));
  const scope = source.scope ?? (source.host || hasCompleteBucketHosts ? 'host' : undefined);
  if (!scope) {
    throw new Error('Source scope must be explicit; missing ownership is not global');
  }
  if (scope === 'global') {
    if (source.host || source.bucket_hosts) {
      throw new Error('Global sources cannot define host ownership');
    }
    return source.bucket_ids;
  }
  if (!hostname) {
    throw new Error('Host-scoped sources require a query hostname');
  }
  if (source.host && source.bucket_hosts) {
    throw new Error('Host-scoped sources must use either host or bucket_hosts');
  }
  if (source.host) {
    return source.host === hostname ? source.bucket_ids : [];
  }
  if (!hasCompleteBucketHosts) {
    throw new Error('Host-scoped sources require a complete bucket_hosts mapping');
  }
  return source.bucket_ids.filter(bucketId => source.bucket_hosts?.[bucketId] === hostname);
}

function validateUniqueSourceIds(sources: Array<{ source_id: string }>, sourceKind: string): void {
  const seen = new Set<string>();
  for (const source of sources) {
    if (seen.has(source.source_id)) {
      throw new Error(`Duplicate ${sourceKind.toLowerCase()} source id: ${source.source_id}`);
    }
    seen.add(source.source_id);
  }
}

function contextEvents(params: BaseQueryParams): string {
  const sources = params.context_sources ?? [];
  if (sources.length === 0) {
    return '';
  }

  requireCapability(params, RULE_ENGINE_CAPABILITIES.sourceNamespace, 'Context enrichment');
  validateUniqueSourceIds(sources, 'Context');

  return sources
    .map((source, index) => {
      if (!/^[A-Za-z0-9_-]+$/.test(source.source_id)) {
        throw new Error("Context source_id may only contain letters, numbers, '_' and '-'");
      }
      if (source.bucket_ids.length === 0) {
        throw new Error('Context source must contain at least one bucket_id');
      }
      if (source.fields.length === 0) {
        throw new Error('Context source must contain at least one field');
      }

      const variable = `context_${index}`;
      const fieldsVariable = `context_fields_${index}`;
      const optionsVariable = `context_options_${index}`;
      const options = serializeQueryJson({
        source_id: source.source_id,
        conflict: source.conflict ?? 'base_wins',
      });
      return [
        `${variable} = [];`,
        ...resolveSourceBucketIds(source, params.hostname).map(
          bucketId =>
            `${variable} = concat(${variable}, flood(${queryOptionalBucket(
              bucketId,
              expectedSourceHostname(params, source)
            )}));`
        ),
        `${variable} = filter_period_intersect(${variable}, events);`,
        `${fieldsVariable} = ${serializeQueryJson(source.fields)};`,
        `${optionsVariable} = ${options};`,
        `events = merge_subwatcher_fields(events, ${variable}, ${fieldsVariable}, ${optionsVariable});`,
      ].join('\n');
    })
    .join('\n');
}

function replacementActivityEvents(params: DesktopQueryParams): string {
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

function activityCoverageEvents(params: DesktopQueryParams): string {
  const sources = params.activity_coverage_sources ?? [];
  if (sources.length === 0) return '';
  requireCapability(params, RULE_ENGINE_CAPABILITIES.sourceNamespace, 'Activity coverage sources');
  validateUniqueSourceIds(sources, 'Activity coverage');

  const loadCoverage = sources
    .map((source, index) => {
      if (!/^[A-Za-z0-9_-]+$/.test(source.source_id)) {
        throw new Error(
          "Activity coverage source_id may only contain letters, numbers, '_' and '-'"
        );
      }
      if (source.bucket_ids.length === 0) {
        throw new Error('Activity coverage source must contain at least one bucket_id');
      }
      if (source.fields.length === 0) {
        throw new Error('Activity coverage source must contain at least one field');
      }
      const variable = `activity_coverage_source_${index}`;
      return [
        `${variable} = [];`,
        ...resolveSourceBucketIds(source, params.hostname).map(
          (bucketId, bucketIndex) =>
            `activity_coverage_bucket_${index}_${bucketIndex} = flood(${queryOptionalBucket(
              bucketId,
              expectedSourceHostname(params, source)
            )});
${variable} = union_no_overlap(${variable}, activity_coverage_bucket_${index}_${bucketIndex});`
        ),
        `activity_coverage_period_${index} = filter_period_intersect(${variable}, ${variable});`,
        `events = period_union(events, activity_coverage_period_${index});`,
      ].join('\n');
    })
    .join('\n');

  const enrichCoverage = sources
    .map((source, index) => {
      const variable = `activity_coverage_source_${index}`;
      return [
        `${variable} = filter_period_intersect(${variable}, events);`,
        `activity_coverage_fields_${index} = ${serializeQueryJson(source.fields)};`,
        `activity_coverage_options_${index} = ${serializeQueryJson({
          source_id: source.source_id,
          conflict: 'base_wins',
        })};`,
        `events = merge_subwatcher_fields(events, ${variable}, activity_coverage_fields_${index}, activity_coverage_options_${index});`,
      ].join('\n');
    })
    .join('\n');

  return `${loadCoverage}\n${enrichCoverage}`;
}

function backgroundActivityEvents(params: DesktopQueryParams): string {
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

export function activeTimeEvents(params: DesktopQueryParams): string {
  if (!params.active_time_rule) return '';
  requireCapability(params, RULE_ENGINE_CAPABILITIES.activePeriods, 'Active-time expressions');

  const sources = params.active_time_sources ?? [];
  if (sources.length === 0) {
    throw new Error('Active-time expressions require at least one source');
  }
  const sourceVariables = sources.map((source, index) => {
    if (!/^[A-Za-z0-9_-]+$/.test(source.source_id)) {
      throw new Error("Active-time source_id may only contain letters, numbers, '_' and '-'");
    }
    const variable = `active_source_${index}`;
    return {
      source,
      variable,
      code: [
        `${variable} = [];`,
        ...resolveSourceBucketIds(source, params.hostname).map(
          bucketId =>
            `${variable} = concat(${variable}, flood(${queryOptionalBucket(
              bucketId,
              expectedSourceHostname(params, source)
            )}));`
        ),
      ].join('\n'),
    };
  });
  const namedSources = sourceVariables.map(({ source, variable }) => [source.source_id, variable]);
  const namedSourcesCode = `[${namedSources
    .map(([sourceId, variable]) => `["${sourceId}", ${variable}]`)
    .join(', ')}]`;
  const rule = serializeQueryJson(params.active_time_rule);
  return [
    ...sourceVariables.map(source => source.code),
    `active_time_rule = ${rule};`,
    `active_time_sources = ${namedSourcesCode};`,
    `not_afk = active_periods_v2(active_time_sources, active_time_rule${
      params.hostname ? `, ${serializeQueryJson(params.hostname)}` : ''
    });`,
    'not_afk = period_union(not_afk, []);',
  ].join('\n');
}

export function activeTimeQuery(params: {
  hostname?: string;
  active_time_rule: RuleExpressionV2;
  active_time_sources: ActiveTimeSource[];
  capabilities?: string[];
  return_variable_suffix?: string;
}): string {
  const desktopParams: DesktopQueryParams = {
    hostname: params.hostname,
    active_time_rule: params.active_time_rule,
    active_time_sources: params.active_time_sources,
    capabilities: params.capabilities,
    categories: [],
    filter_categories: null,
    filter_afk: false,
  };
  return [
    activeTimeEvents(desktopParams),
    params.return_variable_suffix
      ? `not_afk_${params.return_variable_suffix} = not_afk;`
      : 'RETURN = not_afk;',
  ].join('\n');
}

// Resolves a per-host activity profile into categorized activity events.
// Performs:
//  - AFK filtering (if filter_afk is true)
//  - Categorization (if categories specified)
//  - Filters by category (if filter_categories set)
// Puts it's results in `events` and `not_afk` (if not_afk available for platform).
export function resolveActivityProfile(params: DesktopQueryParams | AndroidQueryParams): string {
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
    params.filter_categories
      ? `events = filter_keyvals(events, "$category", ${cat_filter_str});`
      : '',
    // "Return" events by setting variable named with return_variable if set
    params.return_variable_suffix
      ? `events_${params.return_variable_suffix} = events;
         not_afk_${params.return_variable_suffix} = not_afk;`
      : '',
  ].join('\n');
}

// Compatibility entry point retained for custom UIs and existing query-builder consumers.
export function canonicalEvents(params: DesktopQueryParams | AndroidQueryParams): string {
  return resolveActivityProfile(params);
}

export function canonicalMultideviceEvents(params: MultiQueryParams): string {
  const hostParams = params.hosts.map((hostname, index) =>
    get_params(params, hostname, `host_${index}`)
  );
  // Resolve foreground activity independently for each host.
  const queries: string[] = hostParams.map(hostParamsForQuery => {
    return resolveActivityProfile(
      isDesktopParams(hostParamsForQuery)
        ? { ...hostParamsForQuery, background_sources: [], filter_categories: null }
        : hostParamsForQuery
    );
  });
  // Resolve background streams separately so every host's foreground wins before
  // host-priority ordering is applied to gap fillers.
  const backgroundQueries = hostParams.map((hostParamsForQuery, index) => {
    if (!isDesktopParams(hostParamsForQuery) || !hostParamsForQuery.background_sources?.length) {
      return `events_background_host_${index} = [];`;
    }
    return resolveActivityProfile({
      ...hostParamsForQuery,
      bid_window: undefined,
      bid_browsers: [],
      bid_stopwatch: undefined,
      activity_coverage_sources: [],
      activity_sources: [],
      filter_afk: false,
      filter_categories: null,
      return_variable_suffix: `background_host_${index}`,
    });
  });

  // Now we need to combine the queries to get a single series of events.
  // To do this, we can use the union_no_overlap function, which merges events
  // but avoids overlaps by giving priority according to the order of hosts.
  let query = `${queries.join('\n')}\n${backgroundQueries.join('\n')}\n`;
  query += 'events = [];';
  query += 'not_afk = [];';
  for (let i = 0; i < queries.length; i++) {
    query += `
    events = union_no_overlap(events, events_host_${i});
    not_afk = union_no_overlap(not_afk, not_afk_host_${i});
    `;
  }
  for (let i = 0; i < backgroundQueries.length; i++) {
    query += `
    events = union_no_overlap(events, events_background_host_${i});
    `;
  }
  if (params.filter_categories) {
    query += `events = filter_keyvals(events, "$category", ${serializeQueryJson(
      params.filter_categories
    )});`;
  }

  return query;
}

const default_limit = 100; // Hardcoded limit per group

export function appQuery(
  appbucket: string,
  categories: Category[],
  filter_categories: string[][],
  advanced: Partial<
    Pick<BaseQueryParams, 'hostname' | 'category_specs' | 'context_sources' | 'capabilities'>
  > = {}
): string[] {
  const params: AndroidQueryParams = {
    bid_android: appbucket,
    categories,
    filter_categories,
    ...advanced,
  };

  const code = `
    ${resolveActivityProfile(params)}

    title_events = sort_by_duration(merge_events_by_keys(events, ["app", "classname"]));
    app_events   = sort_by_duration(merge_events_by_keys(title_events, ["app"]));
    cat_events   = sort_by_duration(merge_events_by_keys(events, ["$category"]));

    events = sort_by_timestamp(events);
    app_events  = limit_events(app_events, ${default_limit});
    title_events  = limit_events(title_events, ${default_limit});
    duration = sum_durations(events);
    RETURN  = {"app_events": app_events, "title_events": title_events, "cat_events": cat_events, "duration": duration, "active_events": app_events};
  `;
  return queryStringToArray(code);
}

// Exact app names (Flatpak app IDs and similar reverse-domain identifiers) used for bucket discovery and as a
// fallback for names that don't match the regex patterns below. Process name
// variants (upper/lowercase, spacing, .exe suffix) are handled by
// browser_appname_regex using (?i) flag. See test/unit/queries.test.node.ts for
// the complete list of known app names these patterns cover.
const browser_appnames: Record<string, string[]> = {
  chrome: ['com.google.Chrome', 'com.google.ChromeDev', 'org.chromium.Chromium'],
  firefox: ['org.mozilla.firefox', 'io.gitlab.librewolf-community', 'net.waterfox.waterfox'],
  opera: ['com.opera.Opera'],
  brave: ['com.brave.Browser'],
  edge: ['com.microsoft.Edge', 'com.microsoft.EdgeDev'],
  arc: [],
  vivaldi: ['com.vivaldi.Vivaldi'],
  orion: ['Orion'],
  yandex: ['ru.yandex.Browser'],
  zen: ['app.zen_browser.zen'],
  floorp: ['one.ablaze.floorp'],
  helium: ['net.imput.helium'],
};

// Returns a list of (browserName, bucketId) pairs for found browser buckets
function browsersWithBuckets(browserbuckets: string[]): [string, string][] {
  const browsername_to_bucketid: [string, string | undefined][] = _.map(
    Object.keys(browser_appnames),
    browserName => {
      const bucketId = _.find(browserbuckets, bucket_id => _.includes(bucket_id, browserName));
      return [browserName, bucketId];
    }
  );
  // Skip browsers for which a bucket couldn't be found
  return _.filter(browsername_to_bucketid, ([, bucketId]) => bucketId !== undefined);
}

// Case-insensitive regex patterns covering all OS/platform process name variants
// (Windows .exe, Linux lowercase, macOS capitalized, versioned names like firefox-esr-esr140).
// Used with filter_keyvals_regex in addition to the exact names in browser_appnames.
// The full set of historical app names these patterns replace is documented in the unit tests.
// See: test/unit/queries.test.node.ts, https://github.com/ActivityWatch/aw-webui/issues/749
export const browser_appname_regex: Record<string, string> = {
  chrome: '(?i)^(google[-_ ]?chrome|chrome|chromium)',
  firefox: '(?i)(firefox|librewolf|waterfox|nightly)',
  opera: '(?i)(opera)',
  brave: '(?i)(brave)',
  edge: '(?i)^(microsoft[-_ ]?edge|msedge)',
  arc: '(?i)^arc(\\.exe)?$',
  vivaldi: '(?i)(vivaldi)',
  orion: '(?i)(orion)',
  yandex: '(?i)(yandex)',
  zen: '(?i)(zen)',
  floorp: '(?i)(floorp)',
  helium: '(?i)(helium)',
};

// Returns a list of active browser events (where the browser was the active window) from all browser buckets
function browserEvents(params: DesktopQueryParams): string {
  let code = `
    browser_events = [];
  `;

  _.each(browsersWithBuckets(params.bid_browsers), ([browserName, bucketId]) => {
    const browser_appnames_str = serializeQueryJson(browser_appnames[browserName]);
    code += `events_${browserName} = flood(query_bucket(${serializeQueryString(
      bucketId,
      'Browser bucket ID'
    )}));
       window_${browserName} = filter_keyvals(events, "app", ${browser_appnames_str});`;

    // Add regex-based matching to cover case/spacing/versioning variants (e.g., Firefox.exe, firefox-esr-esr140)
    const pattern = browser_appname_regex[browserName];
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

export function fullDesktopQuery(params: DesktopQueryParams): string[] {
  return queryStringToArray(
    `
    ${resolveActivityProfile({
      ...params,
      // Escape `"`
      bid_window: params.bid_window,
      bid_afk: params.bid_afk,
      bid_browsers: params.bid_browsers,
    })}
    title_events = sort_by_duration(merge_events_by_keys(events, ["app", "title"]));
    app_events   = sort_by_duration(merge_events_by_keys(title_events, ["app"]));
    cat_events   = sort_by_duration(merge_events_by_keys(events, ["$category"]));

    app_events  = limit_events(app_events, ${default_limit});
    title_events  = limit_events(title_events, ${default_limit});
    duration = sum_durations(events);
    ` + // Browser events are retrieved in canonicalQuery
      `
    browser_events = split_url_events(browser_events);
    browser_urls = merge_events_by_keys(browser_events, ["url"]);
    browser_urls = sort_by_duration(browser_urls);
    browser_urls = limit_events(browser_urls, ${default_limit});
    browser_domains = merge_events_by_keys(browser_events, ["$domain"]);
    browser_domains = sort_by_duration(browser_domains);
    browser_domains = limit_events(browser_domains, ${default_limit});
    browser_titles = merge_events_by_keys(browser_events, ["title"]);
    browser_titles = sort_by_duration(browser_titles);
    browser_titles = limit_events(browser_titles, ${default_limit});
    browser_duration = sum_durations(browser_events);
    stopwatch_events = merge_events_by_keys(stopwatch_events, ["label"]);
    stopwatch_events = sort_by_duration(stopwatch_events);
    stopwatch_events = limit_events(stopwatch_events, ${default_limit});

    RETURN = {
        "window": {
            "app_events": app_events,
            "title_events": title_events,
            "cat_events": cat_events,
            "active_events": not_afk,
            "duration": duration
        },
        "browser": {
            "domains": browser_domains,
            "urls": browser_urls,
            "titles": browser_titles,
            "duration": browser_duration
        },
        "stopwatch": {
            "stopwatch_events": stopwatch_events
        }
    };`
  );
}

// Performs a query that combines data from multiple devices.
// A multidevice-variant of fullDesktopQuery (with limitations).
//
// 1. Performs one canonicalEvents query per device.
// 2. Combines the results into a single list of events using the transform union_no_overlap (which gives priority to events earlier in the list of devices).
// 3. Compute the statistics of interest.
//
// NOTE: Events from devices are picked in the order of the hostnames array, such that if overlaps are detected the conflict will be resolved by choosing events from the earlier device.
// NOTE: Only supports desktop devices (for now)
// NOTE: Doesn't support browser buckets (and therefore not browser audible detection either)
//       This is due to the 'unknown' hostname of browser buckets (will hopefully be fixed soon).
export function multideviceQuery(params: MultiQueryParams): string[] {
  return queryStringToArray(
    `
    ${canonicalMultideviceEvents(params)}
    title_events = sort_by_duration(merge_events_by_keys(events, ["app", "title"]));
    app_events   = sort_by_duration(merge_events_by_keys(title_events, ["app"]));
    cat_events   = sort_by_duration(merge_events_by_keys(events, ["$category"]));

    app_events  = limit_events(app_events, ${default_limit});
    title_events  = limit_events(title_events, ${default_limit});
    duration = sum_durations(events);

    RETURN = {
        "window": {
            "app_events": app_events,
            "title_events": title_events,
            "cat_events": cat_events,
            "active_events": not_afk,
            "duration": duration
        }
    };`
  );
}

export function editorActivityQuery(editorbuckets: string[]): string[] {
  let q = ['events = [];'];
  for (const editorbucket of editorbuckets) {
    q.push(
      `events = concat(events, flood(query_bucket(${serializeQueryString(
        editorbucket,
        'Editor bucket ID'
      )})));`
    );
  }
  q = q.concat([
    'files = sort_by_duration(merge_events_by_keys(events, ["file", "language"]));',
    `files = limit_events(files, ${default_limit});`,
    'languages = sort_by_duration(merge_events_by_keys(events, ["language"]));',
    `languages = limit_events(languages, ${default_limit});`,
    'projects = sort_by_duration(merge_events_by_keys(events, ["project"]));',
    `projects = limit_events(projects, ${default_limit});`,
    'duration = sum_durations(events);',
    'RETURN = {"files": files, "languages": languages, "projects": projects, "duration": duration};',
  ]);
  return q;
}

// Returns a query that yields a single event with the duration set to
// the sum of all non-afk time in the queried period
// TODO: Would ideally account for `filter_afk` and `always_active_pattern`
// TODO: rename to something like `activeDurationQuery`
// FIXME: Doesn't respect audible-as-active and always-active-pattern
export function activityQuery(afkbuckets: string[]): string[] {
  let q = ['not_afk = [];'];
  for (const afkbucket of afkbuckets) {
    q = q.concat([
      `not_afk_curr = query_bucket(${serializeQueryString(afkbucket, 'AFK bucket ID')});`,
      `not_afk_curr = filter_keyvals(not_afk_curr, "status", ["not-afk"]);`,
      `not_afk = union_no_overlap(not_afk, not_afk_curr);`,
    ]);
  }
  q = q.concat(['not_afk = merge_events_by_keys(not_afk, ["status"]);', 'RETURN = not_afk;']);
  return q;
}

// Equivalent function to activityQuery, but for Android (which doesn't have an afk bucket)
export function activityQueryAndroid(androidbucket: string): string[] {
  return [
    `events = query_bucket(${serializeQueryString(androidbucket, 'Android bucket ID')});`,
    'RETURN = sum_durations(events);',
  ];
}

// Returns a query that yields a dict with a key "cat_events" which is an
// array of one event per category, with the duration of each event set to the sum of the category durations.
export function categoryQuery(
  params: MultiQueryParams | DesktopQueryParams | AndroidQueryParams
): string[] {
  const q = `
  ${isMultiParams(params) ? canonicalMultideviceEvents(params) : resolveActivityProfile(params)}
  cat_events   = sort_by_duration(merge_events_by_keys(events, ["$category"]));
  RETURN = { "cat_events": cat_events };
`;
  return queryStringToArray(q);
}

export default {
  fullDesktopQuery,
  multideviceQuery,
  appQuery,
  activityQuery,
  activityQueryAndroid,
  categoryQuery,
  editorActivityQuery,
};
