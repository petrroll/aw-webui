import _ from 'lodash';
import { allocateGeneratedSourceId, type RuleExpressionV2 } from '~/util/rulesV2';
import { resolveLegacyActivityProfile } from '~/legacy/profile';
export { resolveLegacyActivityProfile } from '~/legacy/profile';
import { browserAppNameRegex, browserAppNames, browserFamiliesWithBuckets } from '~/util/browser';

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
  ignore_case?: boolean;
  select_keys?: string[];
}

type Category = [string[], Rule];

export type SourceIntervalPolicy = 'exact' | 'heartbeat';

export interface ContextSource {
  source_id: string;
  builtin?: 'window' | 'browser' | 'stopwatch';
  bucket_ids: string[];
  interval_policy?: SourceIntervalPolicy;
  scope?: 'host' | 'global';
  bucket_hosts?: Record<string, string>;
  fields: string[];
  conflict?: 'base_wins' | 'sub_wins';
  host?: string;
}

export interface ActiveTimeSource {
  source_id: string;
  builtin?: 'window' | 'browser' | 'stopwatch' | 'afk';
  bucket_ids: string[];
  interval_policy?: SourceIntervalPolicy;
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
  builtin?: 'window' | 'browser' | 'stopwatch';
  bucket_ids: string[];
  interval_policy?: SourceIntervalPolicy;
  scope?: 'host' | 'global';
  bucket_hosts?: Record<string, string>;
  fields: string[];
  keeps_active?: boolean;
  host?: string;
}

export interface CategorySpecV2 {
  id: string;
  name: string[];
  rule: RuleExpressionV2;
  priority?: number;
  set_priority?: number;
  requires?: string[];
}

export const RULE_ENGINE_CAPABILITIES = {
  categorize: 'query.categorize_v2.v1',
  explainCategorize: 'query.categorize_v2_explain.v1',
  sourceNamespace: 'query.merge_subwatcher_fields.source_namespace.v1',
  activePeriods: 'query.active_periods_v2.v1',
  mapEventFields: 'query.map_event_fields.v1',
  expectedBucketHostname: 'query.query_bucket_optional.expected_hostname.v1',
  optionalRawBucket: 'query.query_bucket_optional_raw.v1',
  queryPeriod: 'query.query_period.v1',
  floodV2: 'query.flood_v2.v1',
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

export function isDesktopParams(object: any): object is DesktopQueryParams {
  return !isAndroidParams(object);
}

export function isAndroidParams(object: any): object is AndroidQueryParams {
  return 'bid_android' in object;
}

function isMultiParams(object: any): object is MultiQueryParams {
  return 'hosts' in object;
}

// Use query_bucket directly when we have a full bucket ID (contains hostname after the prefix).
// Fall back to find_bucket only when the ID is partial (ends with '_', meaning hostname is unknown).
// This avoids find_bucket matching wrong buckets when similar names exist (e.g. host vs host.local).
// See: https://github.com/ActivityWatch/aw-webui/issues/590
export function queryBucket(bid: string): string {
  const serializedBid = serializeQueryString(bid, 'Bucket ID');
  if (bid.endsWith('_')) {
    return `query_bucket(find_bucket(${serializedBid}))`;
  }
  return `query_bucket(${serializedBid})`;
}

export function queryOptionalBucket(bid: string, expectedHostname?: string): string {
  const args = [serializeQueryString(bid, 'Bucket ID')];
  if (expectedHostname) args.push(serializeQueryJson(expectedHostname));
  return `query_bucket_optional(${args.join(', ')})`;
}

function queryOptionalRawBucket(
  bid: string,
  expectedHostname?: string,
  paddingSeconds = 0,
  bucketExpression?: string
): string {
  const args = [bucketExpression ?? serializeQueryString(bid, 'Bucket ID')];
  if (expectedHostname || paddingSeconds > 0) {
    args.push(expectedHostname ? serializeQueryJson(expectedHostname) : 'null');
  }
  if (paddingSeconds > 0) args.push(String(paddingSeconds));
  return `query_bucket_optional_raw(${args.join(', ')})`;
}

function loadSourceBucket(
  params: { capabilities?: string[] },
  source: { interval_policy?: SourceIntervalPolicy; scope?: 'host' | 'global'; host?: string },
  bucketId: string,
  expectedHostname?: string,
  bucketExpression?: string
): string {
  const supportsRaw =
    params.capabilities?.includes(RULE_ENGINE_CAPABILITIES.optionalRawBucket) ?? false;
  if (!supportsRaw) {
    // Explicit old-server compatibility boundary. Current-server v2 callers are
    // capability-gated before compilation and always take the raw branch.
    return `flood(${queryOptionalBucket(bucketId, expectedHostname)})`;
  }
  const heartbeat = (source.interval_policy ?? 'exact') === 'heartbeat';
  if (heartbeat) {
    requireCapability(params, RULE_ENGINE_CAPABILITIES.floodV2, 'Heartbeat interval policy');
  }
  return queryOptionalRawBucket(bucketId, expectedHostname, heartbeat ? 5 : 0, bucketExpression);
}

function normalizeLoadedSource(
  params: { capabilities?: string[] },
  source: { interval_policy?: SourceIntervalPolicy },
  variable: string
): string {
  // Flood once after every competing bucket in this logical source has been
  // concatenated. Flooding buckets independently can invent overlapping gap
  // extensions and make the result depend on bucket order.
  return params.capabilities?.includes(RULE_ENGINE_CAPABILITIES.optionalRawBucket) &&
    (source.interval_policy ?? 'exact') === 'heartbeat'
    ? `${variable} = flood_v2(${variable});`
    : '';
}

export function expectedSourceHostname(
  params: BaseQueryParams,
  source: { scope?: 'host' | 'global'; host?: string }
): string | undefined {
  return source.scope !== 'global' &&
    params.hostname &&
    (params.capabilities?.includes(RULE_ENGINE_CAPABILITIES.optionalRawBucket) ||
      params.capabilities?.includes(RULE_ENGINE_CAPABILITIES.expectedBucketHostname))
    ? params.hostname
    : undefined;
}

export function serializeQueryString(value: string, label: string): string {
  const trailingBackslashes = value.match(/\\+$/)?.[0].length ?? 0;
  if (trailingBackslashes % 2 === 1) {
    throw new Error(`${label} cannot end with an odd number of backslashes in Query2`);
  }
  return serializeQueryJson(value);
}

export function requireCapability(
  params: { capabilities?: string[] },
  capability: string,
  feature: string
): void {
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

function materializeBuiltinBucketIds(
  source: {
    builtin?: 'window' | 'browser' | 'stopwatch' | 'afk';
    bucket_ids: string[];
  },
  params: BaseQueryParams
): string[] {
  if (source.bucket_ids.length > 0) return source.bucket_ids;
  if (source.builtin === 'browser') return params.bid_browsers ?? [];
  if (source.builtin === 'stopwatch') {
    return params.bid_stopwatch ? [params.bid_stopwatch] : [];
  }
  return source.bucket_ids;
}

interface CanonicalPipelineInternals {
  bucketExpressions?: Record<string, string[]>;
  activeAliases?: Record<string, string>;
  auxiliarySources?: ActiveTimeSource[];
}

export function contextEvents(
  params: BaseQueryParams,
  internals: CanonicalPipelineInternals = {}
): string {
  const sources = params.context_sources ?? [];
  if (sources.length === 0) {
    return '';
  }

  requireCapability(params, RULE_ENGINE_CAPABILITIES.sourceNamespace, 'Context enrichment');
  validateUniqueSourceIds(sources, 'Context');

  return sources
    .map((configuredSource, index) => {
      const source = {
        ...configuredSource,
        bucket_ids: materializeBuiltinBucketIds(configuredSource, params),
        scope:
          (configuredSource.builtin === 'browser' || configuredSource.builtin === 'stopwatch') &&
          !configuredSource.scope &&
          configuredSource.bucket_ids.length === 0
            ? ('global' as const)
            : configuredSource.scope,
      };
      if (!/^[A-Za-z0-9_-]+$/.test(source.source_id)) {
        throw new Error("Context source_id may only contain letters, numbers, '_' and '-'");
      }
      if (source.bucket_ids.length === 0 && !source.builtin) {
        throw new Error('Context source must contain at least one bucket_id');
      }
      if (source.bucket_ids.length === 0) return '';
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
          (bucketId, bucketIndex) =>
            `${variable} = concat(${variable}, ${loadSourceBucket(
              params,
              source,
              bucketId,
              expectedSourceHostname(params, source),
              internals.bucketExpressions?.[source.source_id]?.[bucketIndex]
            )});`
        ),
        normalizeLoadedSource(params, source, variable),
        `${fieldsVariable} = ${serializeQueryJson(source.fields)};`,
        `${optionsVariable} = ${options};`,
        `events = merge_subwatcher_fields(events, ${variable}, ${fieldsVariable}, ${optionsVariable});`,
      ].join('\n');
    })
    .join('\n');
}

function resolvedActivityCoverageSources(params: DesktopQueryParams): ActivityCoverageSource[] {
  return (params.activity_coverage_sources ?? [])
    .map(source => ({
      ...source,
      bucket_ids: materializeBuiltinBucketIds(source, params),
      scope:
        (source.builtin === 'browser' || source.builtin === 'stopwatch') &&
        !source.scope &&
        source.bucket_ids.length === 0
          ? ('global' as const)
          : source.scope,
    }))
    .filter(source => source.bucket_ids.length > 0 || !source.builtin);
}

export function activityCoverageEvents(
  params: DesktopQueryParams,
  internals: CanonicalPipelineInternals = {}
): string {
  const sources = resolvedActivityCoverageSources(params);
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
      if (source.bucket_ids.length === 0 && !source.builtin) {
        throw new Error('Activity coverage source must contain at least one bucket_id');
      }
      if (source.bucket_ids.length === 0) return '';
      if (source.fields.length === 0) {
        throw new Error('Activity coverage source must contain at least one field');
      }
      const variable = `activity_coverage_source_${index}`;
      return [
        `${variable} = [];`,
        ...resolveSourceBucketIds(source, params.hostname).map(
          (bucketId, bucketIndex) =>
            `activity_coverage_bucket_${index}_${bucketIndex} = ${loadSourceBucket(
              params,
              source,
              bucketId,
              expectedSourceHostname(params, source),
              internals.bucketExpressions?.[source.source_id]?.[bucketIndex]
            )};
${variable} = concat(${variable}, activity_coverage_bucket_${index}_${bucketIndex});`
        ),
        normalizeLoadedSource(params, source, variable),
        `activity_coverage_period_${index} = filter_period_intersect(${variable}, ${
          params.capabilities?.includes(RULE_ENGINE_CAPABILITIES.queryPeriod)
            ? 'query_bounds'
            : variable
        });`,
        `events = period_union(events, activity_coverage_period_${index});`,
      ].join('\n');
    })
    .join('\n');

  const enrichCoverage = sources
    .map((source, index) => {
      const variable = `activity_coverage_source_${index}`;
      return [
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

function activityCoverageActiveOverrides(params: DesktopQueryParams): string {
  return resolvedActivityCoverageSources(params)
    .map((source, index) =>
      source.keeps_active
        ? `not_afk = period_union(not_afk, activity_coverage_period_${index});`
        : ''
    )
    .filter(Boolean)
    .join('\n');
}

export function activeTimeEvents(
  params: DesktopQueryParams,
  internals: CanonicalPipelineInternals = {}
): string {
  if (!params.active_time_rule) return '';
  requireCapability(params, RULE_ENGINE_CAPABILITIES.activePeriods, 'Active-time expressions');

  // Source-free expressions such as {type: "none"}, including nested none
  // groups, are meaningful masks and are evaluated against an empty source list.
  const sources = params.active_time_sources ?? [];
  const sourceVariables = sources.map((configuredSource, index) => {
    const source = {
      ...configuredSource,
      bucket_ids: materializeBuiltinBucketIds(configuredSource, params),
      scope:
        (configuredSource.builtin === 'browser' || configuredSource.builtin === 'stopwatch') &&
        !configuredSource.scope &&
        configuredSource.bucket_ids.length === 0
          ? ('global' as const)
          : configuredSource.scope,
    };
    if (!/^[A-Za-z0-9_-]+$/.test(source.source_id)) {
      throw new Error("Active-time source_id may only contain letters, numbers, '_' and '-'");
    }
    const variable = `active_source_${index}`;
    const alias = internals.activeAliases?.[source.source_id];
    return {
      source,
      variable,
      code: [
        alias
          ? `${variable} = ${alias};`
          : [
              `${variable} = [];`,
              ...resolveSourceBucketIds(source, params.hostname).map(
                (bucketId, bucketIndex) =>
                  `${variable} = concat(${variable}, ${loadSourceBucket(
                    params,
                    source,
                    bucketId,
                    expectedSourceHostname(params, source),
                    internals.bucketExpressions?.[source.source_id]?.[bucketIndex]
                  )});`
              ),
              normalizeLoadedSource(params, source, variable),
            ].join('\n'),
      ]
        .filter(Boolean)
        .join('\n'),
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
  ].join('\n');
}

function auxiliarySourceEvents(
  params: DesktopQueryParams,
  internals: CanonicalPipelineInternals
): string {
  return (internals.auxiliarySources ?? [])
    .map((source, index) => {
      const variable = `auxiliary_source_${index}`;
      return [
        `${variable} = [];`,
        ...resolveSourceBucketIds(source, params.hostname).map(
          (bucketId, bucketIndex) =>
            `${variable} = concat(${variable}, ${loadSourceBucket(
              params,
              source,
              bucketId,
              expectedSourceHostname(params, source),
              internals.bucketExpressions?.[source.source_id]?.[bucketIndex]
            )});`
        ),
        normalizeLoadedSource(params, source, variable),
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n');
}

// Resolves a per-host activity profile into categorized activity events.
// Performs:
//  - AFK filtering (if filter_afk is true)
//  - Categorization (if categories specified)
//  - Filters by category (if filter_categories set)
// Puts it's results in `events` and `not_afk` (if not_afk available for platform).
function legacyBucketSelector(bucketId: string, hostname?: string): string {
  const args = [serializeQueryString(bucketId, 'Bucket ID')];
  if (hostname) args.push(serializeQueryJson(hostname));
  return `find_bucket(${args.join(', ')})`;
}

interface LegacyBrowserStream {
  browserName: string;
  variable: string;
  focusVariable: string;
  focusSourceId: string;
}

interface LegacyV2Adaptation {
  queryParams: CanonicalQueryParamsV2;
  internals: CanonicalPipelineInternals;
  browserStreams: LegacyBrowserStream[];
  stopwatchVariable?: string;
}

function browserFamilyFocusRule(sourceId: string, browserName: string): RuleExpressionV2 {
  const rules: RuleExpressionV2[] = [];
  if (browserAppNames[browserName].length > 0) {
    const exactNames = browserAppNames[browserName]
      .map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');
    rules.push({
      type: 'regex',
      source: sourceId,
      field: 'app',
      regex: `^(?:${exactNames})$`,
    });
  }
  if (browserAppNameRegex[browserName]) {
    rules.push({
      type: 'regex',
      source: sourceId,
      field: 'app',
      regex: browserAppNameRegex[browserName],
    });
  }
  return rules.length === 1 ? rules[0] : { type: 'any', rules };
}

function adaptDesktopQueryToV2(params: DesktopQueryParams): LegacyV2Adaptation {
  if (params.activity_sources?.length || params.background_sources?.length) {
    throw new Error(
      'Deprecated replacement/background sources require the explicit resolveLegacyActivityProfile API'
    );
  }
  const coverage = [...(params.activity_coverage_sources ?? [])];
  const context = [...(params.context_sources ?? [])];
  const internals: CanonicalPipelineInternals = {
    bucketExpressions: {},
    activeAliases: {},
    auxiliarySources: [],
  };
  const windowMode = params.legacy_window_mode ?? 'activity';
  if (windowMode === 'none' && params.always_active_pattern) {
    throw new Error(
      "always_active_pattern requires a legacy window projection; legacy_window_mode='none' is unsupported"
    );
  }
  let projectionVariable = 'events';
  if (params.bid_window && windowMode !== 'none') {
    const windowSource = {
      source_id: 'builtin_window',
      builtin: 'window' as const,
      bucket_ids: [params.bid_window],
      interval_policy: 'heartbeat' as const,
      scope: params.hostname ? ('host' as const) : ('global' as const),
      ...(params.hostname ? { host: params.hostname } : {}),
      fields: params.legacy_window_fields ?? ['app', 'title'],
    };
    internals.bucketExpressions.builtin_window = [
      legacyBucketSelector(params.bid_window, params.hostname),
    ];
    if (windowMode === 'activity') {
      coverage.unshift(windowSource);
      projectionVariable = 'activity_coverage_source_0';
    } else {
      context.unshift({ ...windowSource, conflict: 'base_wins' as const });
      projectionVariable = 'context_0';
    }
  }
  let stopwatchVariable: string | undefined;
  if (params.bid_stopwatch) {
    stopwatchVariable = `activity_coverage_source_${coverage.length}`;
    coverage.push({
      source_id: 'stopwatch',
      builtin: 'stopwatch',
      bucket_ids: [params.bid_stopwatch],
      interval_policy: 'exact',
      scope: 'global',
      fields: ['label'],
      keeps_active: true,
    });
  }

  const hasCustomActiveRule = !!params.active_time_rule;
  const activeBranches: RuleExpressionV2[] = params.active_time_rule
    ? [params.active_time_rule]
    : [];
  const activeSources = [...(params.active_time_sources ?? [])];
  const occupiedSourceIds = new Set([
    ...coverage.map(source => source.source_id),
    ...context.map(source => source.source_id),
    ...activeSources.map(source => source.source_id),
    ...(params.activity_sources ?? []).map(source => source.source_id),
    ...(params.background_sources ?? []).map(source => source.source_id),
  ]);

  if (!hasCustomActiveRule && params.bid_afk) {
    const afkSourceId = allocateGeneratedSourceId(occupiedSourceIds, 'afk');
    activeSources.push({
      source_id: afkSourceId,
      builtin: 'afk',
      bucket_ids: [params.bid_afk],
      interval_policy: 'heartbeat',
      scope: params.hostname ? 'host' : 'global',
      ...(params.hostname ? { host: params.hostname } : {}),
    });
    internals.bucketExpressions[afkSourceId] = [
      legacyBucketSelector(params.bid_afk, params.hostname),
    ];
    activeBranches.push({
      type: 'regex',
      source: afkSourceId,
      field: 'status',
      regex: '^not-afk$',
    });
  }

  const ensureWindowActiveSource = () => {
    if (!params.bid_window) return;
    if (!activeSources.some(source => source.source_id === 'builtin_window')) {
      activeSources.push({
        source_id: 'builtin_window',
        builtin: 'window',
        bucket_ids: [params.bid_window],
        interval_policy: 'heartbeat',
        scope: params.hostname ? 'host' : 'global',
        ...(params.hostname ? { host: params.hostname } : {}),
      });
    }
    internals.activeAliases.builtin_window = projectionVariable;
  };

  if (!hasCustomActiveRule && params.always_active_pattern && params.bid_window) {
    ensureWindowActiveSource();
    activeBranches.push({
      type: 'regex',
      source: 'builtin_window',
      fields: ['app', 'title'],
      regex: params.always_active_pattern,
    });
  }

  const browserStreams: LegacyBrowserStream[] = [];
  const audibleBranches: RuleExpressionV2[] = [];
  for (const [browserName, bucketIds] of browserFamiliesWithBuckets(params.bid_browsers ?? [])) {
    const useForAudible = !!params.include_audible && !hasCustomActiveRule && !!params.bid_window;
    const sourceId = allocateGeneratedSourceId(
      occupiedSourceIds,
      useForAudible
        ? `browser_audible_${browserStreams.length}`
        : `browser_projection_${browserStreams.length}`
    );
    const source: ActiveTimeSource = {
      source_id: sourceId,
      builtin: 'browser',
      bucket_ids: [...bucketIds],
      interval_policy: 'heartbeat',
      scope: 'global',
    };
    let variable: string;
    if (useForAudible) {
      const activeIndex = activeSources.length;
      activeSources.push(source);
      variable = `active_source_${activeIndex}`;
      ensureWindowActiveSource();
      audibleBranches.push({
        type: 'all',
        rules: [
          {
            type: 'regex',
            source: sourceId,
            field: 'audible',
            regex: '^true$',
            value_mode: 'scalar',
          },
          browserFamilyFocusRule('builtin_window', browserName),
        ],
      });
    } else {
      const auxiliaryIndex = internals.auxiliarySources.length;
      internals.auxiliarySources.push(source);
      variable = `auxiliary_source_${auxiliaryIndex}`;
    }
    browserStreams.push({
      browserName,
      variable,
      focusVariable: projectionVariable,
      focusSourceId: 'builtin_window',
    });
  }
  activeBranches.push(...audibleBranches);
  const activeRule =
    activeBranches.length === 0
      ? undefined
      : activeBranches.length === 1
      ? activeBranches[0]
      : { type: 'any' as const, rules: activeBranches };

  return {
    internals,
    browserStreams,
    stopwatchVariable,
    queryParams: {
      hostname: params.hostname,
      // Legacy categorization is an output projection. Running it here would
      // expose v2 diagnostics and would evaluate select_keys before old root
      // app/title fields have been restored.
      category_specs: undefined,
      explain_categories: params.explain_categories,
      context_sources: context.map(source => ({
        ...source,
        interval_policy: source.interval_policy ?? 'exact',
      })),
      activity_coverage_sources: coverage.map(source => ({
        ...source,
        interval_policy: source.interval_policy ?? 'exact',
      })),
      active_time_rule: activeRule,
      active_time_sources: activeSources.map(source => ({
        ...source,
        interval_policy: source.interval_policy ?? 'exact',
      })),
      capabilities: params.capabilities,
      filter_categories: null,
      filter_afk: params.filter_afk,
    },
  };
}

// Compatibility entry point: capable current servers normalize legacy desktop
// inputs into the one v2 source pipeline. Android and genuinely old servers are
// the automatic legacy boundary; deprecated replacement/background callers must
// opt into the exported resolveLegacyActivityProfile API.
export function resolveActivityProfile(params: DesktopQueryParams | AndroidQueryParams): string {
  const capabilities = params.capabilities ?? [];
  const currentServer = [
    RULE_ENGINE_CAPABILITIES.categorize,
    RULE_ENGINE_CAPABILITIES.sourceNamespace,
    RULE_ENGINE_CAPABILITIES.activePeriods,
    RULE_ENGINE_CAPABILITIES.optionalRawBucket,
    RULE_ENGINE_CAPABILITIES.queryPeriod,
    RULE_ENGINE_CAPABILITIES.floodV2,
  ].every(capability => capabilities.includes(capability));
  if (!isDesktopParams(params) || !currentServer) return resolveLegacyActivityProfile(params);

  const adaptation = adaptDesktopQueryToV2(params);
  let query = resolveActivityProfileV2Internal(adaptation.queryParams, adaptation.internals);
  const windowMode = params.legacy_window_mode ?? 'activity';
  if (params.bid_window && windowMode !== 'none') {
    const sourceVariable = windowMode === 'activity' ? 'activity_coverage_source_0' : 'context_0';
    // Project the historical root shape from source facts already loaded by the
    // v2 pipeline. Rebuild non-stopwatch coverage before applying stopwatch-first
    // precedence so its coverage is not present twice in the legacy output.
    if (adaptation.stopwatchVariable) {
      const stopwatchIndex = Number(adaptation.stopwatchVariable.split('_').pop());
      query += '\nevents = [];';
      (adaptation.queryParams.activity_coverage_sources ?? []).forEach((_source, index) => {
        if (index !== stopwatchIndex) {
          query += `\nevents = period_union(events, activity_coverage_period_${index});`;
        }
      });
      if (params.filter_afk) query += '\nevents = filter_period_intersect(events, not_afk);';
    } else {
      query += `\nevents = period_union([], events);`;
    }
    query += `\nevents = merge_subwatcher_fields(events, ${sourceVariable}, ${serializeQueryJson(
      params.legacy_window_fields ?? ['app', 'title']
    )});`;
    const coverageOffset = windowMode === 'activity' ? 1 : 0;
    (params.activity_coverage_sources ?? []).forEach((source, index) => {
      const sourceIndex = index + coverageOffset;
      query += `\nevents = merge_subwatcher_fields(events, activity_coverage_source_${sourceIndex}, ${serializeQueryJson(
        source.fields
      )}, ${serializeQueryJson({
        source_id: source.source_id,
        conflict: 'base_wins',
      })});`;
    });
    const contextOffset = windowMode === 'context' ? 1 : 0;
    (params.context_sources ?? []).forEach((source, index) => {
      query += `\nevents = merge_subwatcher_fields(events, context_${
        index + contextOffset
      }, ${serializeQueryJson(source.fields)}, ${serializeQueryJson({
        source_id: source.source_id,
        conflict: source.conflict ?? 'base_wins',
      })});`;
    });
    if (params.category_specs !== undefined) {
      query += `\nevents = merge_subwatcher_fields(events, ${sourceVariable}, ${serializeQueryJson(
        params.legacy_window_fields ?? ['app', 'title']
      )}, ${serializeQueryJson({ source_id: 'builtin_window', conflict: 'base_wins' })});`;
    }
  }

  if (adaptation.stopwatchVariable) {
    query += `\nstopwatch_events = filter_period_intersect(${adaptation.stopwatchVariable}, query_bounds);`;
    query += '\nevents = union_no_overlap(stopwatch_events, events);';
  } else {
    query += '\nstopwatch_events = [];';
  }

  if (params.category_specs !== undefined) {
    query += `\nevents = ${
      params.explain_categories ? 'categorize_v2_explain' : 'categorize_v2'
    }(events, ${serializeQueryJson(params.category_specs)}${
      params.hostname ? `, ${serializeQueryJson(params.hostname)}` : ''
    });`;
  } else {
    // `categorize`, including an explicit empty list, is the old output-shape
    // adapter: it preserves select_keys over projected/namespaced fields and
    // does not leak v2 score/rule diagnostics.
    query += `\nevents = categorize(events, ${serializeQueryJson(params.categories ?? [])});`;
  }
  if ((params.filter_categories?.length ?? 0) > 0) {
    query += `\nevents = filter_keyvals(events, "$category", ${serializeQueryJson(
      params.filter_categories
    )});`;
  }
  if (adaptation.stopwatchVariable) {
    query += '\nstopwatch_events = filter_period_intersect(stopwatch_events, events);';
  }
  if (params.return_variable_suffix) {
    query += `\nevents_${params.return_variable_suffix} = events;`;
    query += `\nnot_afk_${params.return_variable_suffix} = not_afk;`;
  }
  query += '\nbrowser_events = [];';
  adaptation.browserStreams.forEach(
    ({ browserName, variable, focusVariable, focusSourceId }, index) => {
      const focusRule = browserFamilyFocusRule(focusSourceId, browserName);
      query += `\nbrowser_focus_rule_${index} = ${serializeQueryJson(focusRule)};`;
      query += `\nbrowser_focus_${index} = active_periods_v2([[${serializeQueryJson(
        focusSourceId
      )}, ${focusVariable}]], browser_focus_rule_${index}${
        params.hostname ? `, ${serializeQueryJson(params.hostname)}` : ''
      });`;
      query += `\nbrowser_focus_${index} = filter_period_intersect(query_bounds, browser_focus_${index});`;
      query += `\n${projectBrowserEvents(
        `browser_focus_${index}`,
        variable,
        `browser_${browserName}_projected`,
        ['url', 'title', 'audible', 'incognito', 'tabCount']
      )}`;
      query += `\nbrowser_${browserName} = filter_keyvals_regex(browser_${browserName}_projected, "url", ".");`;
      query += `\nbrowser_${browserName} = split_url_events(browser_${browserName});`;
      query += `\nbrowser_events = concat(browser_events, browser_${browserName});`;
    }
  );
  if (adaptation.browserStreams.length > 0) {
    query += '\nbrowser_events = sort_by_timestamp(browser_events);';
    query += '\nbrowser_events = filter_period_intersect(browser_events, query_bounds);';
    query += '\nbrowser_events = filter_period_intersect(browser_events, events);';
  }
  return query;
}

export function canonicalEvents(params: DesktopQueryParams | AndroidQueryParams): string {
  return resolveActivityProfile(params);
}

// ---------------------------------------------------------------------------
// v2 clean resolver / query path.
//
// A source-only pipeline aligned with the Python/Rust engine: it accepts only
// explicit namespaced sources and never injects or accepts bid_window/bid_afk/
// bid_browsers/bid_stopwatch, legacy window modes, always-active patterns,
// replacement/background sources, or root app/title fields. The configured
// default window source (when present) arrives here as an ordinary coverage or
// context source with a namespaced source_id. Callers must materialize
// per-host bucket_ids before building the query (see materializeActivityQueryV2).
// ---------------------------------------------------------------------------

export interface CanonicalQueryParamsV2 {
  hostname?: string;
  category_specs?: CategorySpecV2[];
  explain_categories?: boolean;
  context_sources?: ContextSource[];
  activity_coverage_sources?: ActivityCoverageSource[];
  active_time_rule?: RuleExpressionV2;
  active_time_sources?: ActiveTimeSource[];
  capabilities?: string[];
  filter_categories: string[][] | null;
  filter_afk?: boolean;
  return_variable_suffix?: string;
}

export function resolveActivityProfileV2(params: CanonicalQueryParamsV2): string {
  return resolveActivityProfileV2Internal(params, {});
}

function resolveActivityProfileV2Internal(
  params: CanonicalQueryParamsV2,
  internals: CanonicalPipelineInternals
): string {
  requireCapability(params, RULE_ENGINE_CAPABILITIES.optionalRawBucket, 'Original source bounds');
  requireCapability(params, RULE_ENGINE_CAPABILITIES.queryPeriod, 'Query coverage bounds');
  const hasCategorySpecs = params.category_specs !== undefined;
  const category_specs = params.category_specs ?? [];
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
  const hasActiveTimeRule = !!params.active_time_rule;
  const hasKeepsActiveCoverage = (params.activity_coverage_sources ?? []).some(
    source => source.keeps_active
  );
  const filterAfk = params.filter_afk ?? true;
  if (filterAfk && !hasActiveTimeRule && !hasKeepsActiveCoverage) {
    throw new Error(
      'Active filtering requires an active-time rule or a keeps-active coverage source'
    );
  }
  // Adapt to the shared source-only helpers without ever setting a root/legacy
  // field (no bid_window, bid_afk, legacy_window_mode, always_active_pattern).
  const helperParams: DesktopQueryParams = {
    hostname: params.hostname,
    categories: [],
    filter_categories: params.filter_categories,
    filter_afk: filterAfk,
    category_specs: params.category_specs,
    explain_categories: params.explain_categories,
    context_sources: params.context_sources,
    activity_coverage_sources: params.activity_coverage_sources,
    active_time_rule: params.active_time_rule,
    active_time_sources: params.active_time_sources,
    capabilities: params.capabilities,
    return_variable_suffix: params.return_variable_suffix,
  };
  return [
    'query_bounds = query_period();',
    'events = [];',
    hasActiveTimeRule ? '' : 'not_afk = [];',
    activityCoverageEvents(helperParams, internals),
    auxiliarySourceEvents(helperParams, internals),
    // Context facts are loaded before active-time aliases can refer to them.
    contextEvents(helperParams, internals),
    activeTimeEvents(helperParams, internals),
    // `not_afk` is the effective active mask whether or not this particular
    // query filters its event output. History and availability rely on the same
    // keeps-active coverage as full reports.
    activityCoverageActiveOverrides(helperParams),
    // Normalize after every active contribution so all current builders expose
    // one period representation before clipping canonical events.
    'not_afk = period_union(not_afk, []);',
    'not_afk = filter_period_intersect(not_afk, events);',
    filterAfk ? 'events = filter_period_intersect(events, not_afk);' : '',
    hasCategorySpecs
      ? `events = ${
          params.explain_categories ? 'categorize_v2_explain' : 'categorize_v2'
        }(events, ${serializeQueryJson(category_specs)}${
          params.hostname ? `, ${serializeQueryJson(params.hostname)}` : ''
        });`
      : '',
    (params.filter_categories?.length ?? 0) > 0
      ? `events = filter_keyvals(events, "$category", ${serializeQueryJson(
          params.filter_categories
        )});`
      : '',
    params.return_variable_suffix
      ? `events_${params.return_variable_suffix} = events;
         not_afk_${params.return_variable_suffix} = not_afk;`
      : '',
  ]
    .filter(part => part !== '')
    .join('\n');
}

// Compatibility alias mirroring canonicalEvents for the v2 pipeline.
export function canonicalEventsV2(params: CanonicalQueryParamsV2): string {
  return resolveActivityProfileV2(params);
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
  if ((params.filter_categories?.length ?? 0) > 0) {
    query += `events = filter_keyvals(events, "$category", ${serializeQueryJson(
      params.filter_categories
    )});`;
  }

  return query;
}

const default_limit = 100; // Hardcoded limit per group

// v2 multidevice canonical events: unions per-host source-only events and active
// periods into `events` / `not_afk`, optionally filtering by category. No
// bid_window / background / root injection. Leaves `events` populated for the
// caller to summarize or return.
export function canonicalMultideviceEventsV2(
  perHostParams: CanonicalQueryParamsV2[],
  filterCategories?: string[][] | null
): string {
  const effectiveFilter =
    filterCategories === undefined
      ? perHostParams.find(params => (params.filter_categories?.length ?? 0) > 0)
          ?.filter_categories ?? null
      : filterCategories;
  const prelude = perHostParams
    .map((params, index) =>
      resolveActivityProfileV2({
        ...params,
        filter_categories: null,
        return_variable_suffix: `host_${index}`,
      })
    )
    .join('\n');
  let query = `${prelude}\nevents = [];\nnot_afk = [];\n`;
  for (let i = 0; i < perHostParams.length; i++) {
    query += `
    events = union_no_overlap(events, events_host_${i});
    not_afk = union_no_overlap(not_afk, not_afk_host_${i});
    `;
  }
  if ((effectiveFilter?.length ?? 0) > 0) {
    query += `events = filter_keyvals(events, "$category", ${serializeQueryJson(
      effectiveFilter
    )});`;
  }
  return query;
}

// Backwards-compatible export for callers/tests that import the established
// process-pattern name from this module.
export const browser_appname_regex = browserAppNameRegex;

// Returns active browser events (where the browser was the active window).
// Keep the legacy builder's historical one-bucket-per-browser selection; the v2
// report path below handles every bucket with explicit host ownership.
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

// ---------------------------------------------------------------------------
// v2 report builders — emit a generic `activity` section (never an authoritative
// `window`). App/title summaries are a presentation projection from an explicit
// configured source whose flat fields include app/title, using the flat
// namespaced keys `$source.<id>.app` / `$source.<id>.title`. When no such source
// is configured the app/title arrays are simply empty. Browser focus filters
// canonical events on an explicit `$source.<id>.app` key, never a root app field.
// ---------------------------------------------------------------------------

export interface ActivityReportParamsV2 extends CanonicalQueryParamsV2 {
  // Configured source whose flat fields include app/title (e.g. builtin_window).
  app_title_source_id?: string;
  // Configured source whose flat field includes app, used to detect browser focus.
  browser_focus_source_id?: string;
  browser_source?: ActivityCoverageSource;
  // Coverage source id under which stopwatch labels were merged.
  stopwatch_source_id?: string;
}

function namespacedKey(sourceId: string, field: string): string {
  return `$source.${sourceId}.${field}`;
}

// Browser enrichment for the v2 pipeline: focus is derived from an explicit
// namespaced source key rather than a root app field. Padded raw events from
// every bucket in one browser family are combined before one heartbeat pass and
// the single projection which resolves latest-overlapping-event precedence.
// Suffixes keep hosts/families independent.
function browserEventsV2(
  browserSource: ActivityCoverageSource,
  focusAppKey: string,
  canonicalEventsVariable = 'events',
  browserEventsVariable = 'browser_events',
  variableSuffix = 'single',
  hostname?: string
): string {
  let code = `
    ${browserEventsVariable} = [];
  `;
  const browserBucketIds = resolveSourceBucketIds(browserSource, hostname);
  const expectedHostname = browserSource.scope === 'global' ? undefined : hostname;
  const heartbeat = (browserSource.interval_policy ?? 'exact') === 'heartbeat';
  const fields = [...browserSource.fields];
  _.each(browserFamiliesWithBuckets(browserBucketIds), ([browserName, bucketIds], index) => {
    const browserAppNamesJson = serializeQueryJson(browserAppNames[browserName]);
    const browserVariable = `browser_${variableSuffix}_${index}`;
    const focusVariable = `browser_focus_${variableSuffix}_${index}`;
    code += `${browserVariable} = [];`;
    _.each(bucketIds, bucketId => {
      code += `
       ${browserVariable} = concat(${browserVariable}, ${queryOptionalRawBucket(
        bucketId,
        expectedHostname,
        heartbeat ? 5 : 0
      )});`;
    });
    code += `
       ${heartbeat ? `${browserVariable} = flood_v2(${browserVariable});` : ''}
       ${browserVariable} = sort_by_timestamp(${browserVariable});
       ${focusVariable} = filter_keyvals(${canonicalEventsVariable}, ${serializeQueryJson(
      focusAppKey
    )}, ${browserAppNamesJson});`;
    const pattern = browserAppNameRegex[browserName];
    if (pattern) {
      code += `
       ${focusVariable}_re = filter_keyvals_regex(${canonicalEventsVariable}, ${serializeQueryJson(
        focusAppKey
      )}, ${serializeQueryJson(pattern)});
       ${focusVariable} = sort_by_timestamp(concat(${focusVariable}, ${focusVariable}_re));`;
    }
    code += `
       ${browserVariable}_presence = filter_period_intersect(${focusVariable}, ${browserVariable});
       ${browserVariable}_presence = period_union(${browserVariable}_presence, []);
       ${projectBrowserEvents(
         `${browserVariable}_presence`,
         browserVariable,
         `${browserVariable}_projected`,
         fields
       )}
       ${
         fields.includes('url')
           ? `${browserVariable} = filter_keyvals_regex(${browserVariable}_projected, "url", ".");
       ${browserVariable} = split_url_events(${browserVariable});`
           : `${browserVariable} = ${browserVariable}_projected;`
       }
       ${browserEventsVariable} = concat(${browserEventsVariable}, ${browserVariable});
       ${browserEventsVariable} = sort_by_timestamp(${browserEventsVariable});`;
  });
  return code;
}

function projectBrowserEvents(
  canonicalEventsVariable: string,
  browserEventsVariable: string,
  projectionVariable: string,
  fields: string[]
): string {
  return `${projectionVariable} = merge_subwatcher_fields(
    ${canonicalEventsVariable},
    ${browserEventsVariable},
    ${serializeQueryJson(fields)}
  );`;
}

// Report tail shared by single- and multi-host v2 report builders. Operates on
// an already-populated `events` (canonical, categorized) and `not_afk` variable.
// Multihost callers provide browser preparation that has already applied the
// same host precedence as canonical activity.
function activityReportTail(
  params: ActivityReportParamsV2,
  preparedBrowserEvents?: string
): string {
  const appKey = params.app_title_source_id
    ? namespacedKey(params.app_title_source_id, 'app')
    : undefined;
  const titleKey = params.app_title_source_id
    ? namespacedKey(params.app_title_source_id, 'title')
    : undefined;
  const focusAppKey = params.browser_focus_source_id
    ? namespacedKey(params.browser_focus_source_id, 'app')
    : undefined;
  const stopwatchKey = params.stopwatch_source_id
    ? namespacedKey(params.stopwatch_source_id, 'label')
    : undefined;
  const browserFields = params.browser_source?.fields ?? [];

  const appTitleSection =
    appKey && titleKey
      ? `
    title_events = sort_by_duration(merge_events_by_keys(events, [${serializeQueryJson(
      appKey
    )}, ${serializeQueryJson(titleKey)}]));
    app_events   = sort_by_duration(merge_events_by_keys(title_events, [${serializeQueryJson(
      appKey
    )}]));
    app_events  = limit_events(app_events, ${default_limit});
    title_events  = limit_events(title_events, ${default_limit});`
      : `
    title_events = [];
    app_events = [];`;

  const browserSection =
    preparedBrowserEvents !== undefined
      ? preparedBrowserEvents
      : focusAppKey
      ? params.browser_source
        ? `${browserEventsV2(
            params.browser_source,
            focusAppKey,
            'events',
            'browser_events_raw',
            'single',
            params.hostname
          )}
         ${projectBrowserEvents('browser_events_raw', 'events', 'browser_projection_events', [
           '$category',
         ])}
         browser_events = ${
           params.browser_source.fields.includes('url')
             ? 'filter_keyvals_regex(browser_projection_events, "url", ".")'
             : 'browser_projection_events'
         };`
        : 'browser_events = [];'
      : 'browser_events = [];';

  const stopwatchSection = stopwatchKey
    ? `stopwatch_events = merge_events_by_keys(events, [${serializeQueryJson(stopwatchKey)}]);
       stopwatch_events = filter_keyvals_regex(stopwatch_events, ${serializeQueryJson(
         stopwatchKey
       )}, ".");
       stopwatch_events = sort_by_duration(stopwatch_events);
       stopwatch_events = limit_events(stopwatch_events, ${default_limit});`
    : 'stopwatch_events = [];';

  const browserUrlSection = browserFields.includes('url')
    ? `browser_events = split_url_events(browser_events);
    browser_urls = merge_events_by_keys(browser_events, ["url"]);
    browser_urls = sort_by_duration(browser_urls);
    browser_urls = limit_events(browser_urls, ${default_limit});
    browser_domains = merge_events_by_keys(browser_events, ["$domain"]);
    browser_domains = sort_by_duration(browser_domains);
    browser_domains = limit_events(browser_domains, ${default_limit});`
    : `browser_urls = [];
    browser_domains = [];`;
  const browserTitleSection = browserFields.includes('title')
    ? `browser_title_events = filter_keyvals_regex(browser_events, "title", ".");
    browser_titles = merge_events_by_keys(browser_title_events, ["title"]);
    browser_titles = sort_by_duration(browser_titles);
    browser_titles = limit_events(browser_titles, ${default_limit});`
    : 'browser_titles = [];';

  return `
    ${appTitleSection}
    cat_events   = sort_by_duration(merge_events_by_keys(events, ["$category"]));
    duration = sum_durations(events);
    ${browserSection}
    ${browserUrlSection}
    ${browserTitleSection}
    browser_duration = sum_durations(browser_events);
    ${stopwatchSection}
    RETURN = {
        "activity": {
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
    };`;
}

export function fullActivityQueryV2(params: ActivityReportParamsV2): string[] {
  return queryStringToArray(
    `
    ${resolveActivityProfileV2(params)}
    ${activityReportTail(params)}`
  );
}

// Multi-device v2 report. Browser facts are first resolved against each host's
// local focus stream, attached to that host's full canonical coverage, and only
// then combined in host-priority order. This prevents a lower-priority host (or
// the first bucket for a browser family) from supplying facts for another
// host's winning activity slice.
export function fullActivityMultiQueryV2(
  perHostParams: ActivityReportParamsV2[],
  filterCategories?: string[][] | null
): string[] {
  const effectiveFilter =
    filterCategories === undefined
      ? perHostParams.find(params => (params.filter_categories?.length ?? 0) > 0)
          ?.filter_categories ?? null
      : filterCategories;
  const prelude = perHostParams
    .map((params, index) =>
      resolveActivityProfileV2({
        ...params,
        filter_categories: null,
        return_variable_suffix: `mdev_${index}`,
      })
    )
    .join('\n');
  const browserPrelude = perHostParams
    .map((params, index) => {
      const focusAppKey = params.browser_focus_source_id
        ? namespacedKey(params.browser_focus_source_id, 'app')
        : undefined;
      const browserEventsVariable = `browser_events_mdev_${index}`;
      const coverageVariable = `browser_host_coverage_mdev_${index}`;
      if (!focusAppKey || !params.browser_source) {
        return `${browserEventsVariable} = [];
        ${coverageVariable} = period_union([], filter_period_intersect(query_bounds, events_mdev_${index}));
        browser_projection_mdev_${index} = ${coverageVariable};`;
      }
      const loadBrowserEvents = browserEventsV2(
        params.browser_source,
        focusAppKey,
        `events_mdev_${index}`,
        browserEventsVariable,
        `mdev_${index}`,
        params.hostname
      );
      const projectionFields = [
        '$category',
        ...params.browser_source.fields,
        ...(params.browser_source.fields.includes('url') ? ['$domain'] : []),
      ];
      return `${loadBrowserEvents}
        ${coverageVariable} = period_union([], filter_period_intersect(query_bounds, events_mdev_${index}));
        browser_presence_mdev_${index} = categorize_v2(${browserEventsVariable}, []);
        ${projectBrowserEvents(
          coverageVariable,
          `browser_presence_mdev_${index}`,
          `browser_projection_mdev_${index}`,
          projectionFields
        )}`;
    })
    .join('\n');
  const unions = perHostParams
    .map(
      (_params, index) =>
        `events = union_no_overlap(events, events_mdev_${index});
         not_afk = union_no_overlap(not_afk, not_afk_mdev_${index});
         browser_projection_events = union_no_overlap(browser_projection_events, browser_projection_mdev_${index});`
    )
    .join('\n');
  const postFilter =
    (effectiveFilter?.length ?? 0) > 0
      ? `events = filter_keyvals(events, "$category", ${serializeQueryJson(effectiveFilter)});
       browser_projection_events = filter_period_intersect(browser_projection_events, events);`
      : '';
  const projection = {
    app_title_source_id: perHostParams.find(params => params.app_title_source_id)
      ?.app_title_source_id,
    stopwatch_source_id: perHostParams.find(params => params.stopwatch_source_id)
      ?.stopwatch_source_id,
    browser_source: perHostParams.find(params => params.browser_source)?.browser_source,
  };
  return queryStringToArray(
    `
    ${prelude}
    ${browserPrelude}
    events = [];
    not_afk = [];
    browser_projection_events = [];
    ${unions}
    browser_projection_events = filter_keyvals(browser_projection_events, "$category", [["Uncategorized"]]);
    ${postFilter}
    ${activityReportTail(
      {
        hostname: '',
        filter_categories: null,
        app_title_source_id: projection.app_title_source_id,
        stopwatch_source_id: projection.stopwatch_source_id,
        browser_source: projection.browser_source,
      },
      projection.browser_source?.fields.includes('url')
        ? 'browser_events = filter_keyvals_regex(browser_projection_events, "url", ".");'
        : 'browser_events = browser_projection_events;'
    )}`
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

// v2 category-only queries: yield `{ cat_events }` from the source-only pipeline.
export function categoryActivityQueryV2(params: CanonicalQueryParamsV2): string[] {
  return queryStringToArray(
    `
  ${resolveActivityProfileV2(params)}
  cat_events   = sort_by_duration(merge_events_by_keys(events, ["$category"]));
  RETURN = { "cat_events": cat_events };
`
  );
}

export function categoryActivityMultiQueryV2(
  perHostParams: CanonicalQueryParamsV2[],
  filterCategories?: string[][] | null
): string[] {
  const effectiveFilter =
    filterCategories === undefined
      ? perHostParams.find(params => (params.filter_categories?.length ?? 0) > 0)
          ?.filter_categories ?? null
      : filterCategories;
  const prelude = perHostParams
    .map((params, index) =>
      resolveActivityProfileV2({
        ...params,
        filter_categories: null,
        return_variable_suffix: `mdev_${index}`,
      })
    )
    .join('\n');
  const unions = perHostParams
    .map((_params, index) => `events = union_no_overlap(events, events_mdev_${index});`)
    .join('\n');
  const postFilter =
    (effectiveFilter?.length ?? 0) > 0
      ? `events = filter_keyvals(events, "$category", ${serializeQueryJson(effectiveFilter)});`
      : '';
  return queryStringToArray(
    `
  ${prelude}
  events = [];
  ${unions}
  ${postFilter}
  cat_events   = sort_by_duration(merge_events_by_keys(events, ["$category"]));
  RETURN = { "cat_events": cat_events };
`
  );
}

export default {
  fullDesktopQuery,
  fullActivityQueryV2,
  fullActivityMultiQueryV2,
  multideviceQuery,
  categoryQuery,
  categoryActivityQueryV2,
  categoryActivityMultiQueryV2,
  editorActivityQuery,
};
