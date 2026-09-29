// Central v2 activity-query helper.
//
// Capable servers expose a compiled v2 query (`settingsStore.compiledActivityQueryV2`).
// When present, every caller must go through this helper: it materializes the
// compiled query per host (filling the configured default window source's actual
// bucket IDs only when that source exists) and builds a source-only query that
// never injects bid_window / bid_afk / always_active_pattern / bid_stopwatch or
// any root app/title field. Unsupported servers fail visibly instead of
// substituting legacy dashboard results.

import type { IBucket, IEvent } from '~/util/interfaces';
import type { CompiledActivityQueryV2, RuleExpressionV2, SourceDefinitionV2 } from '~/util/rulesV2';
import {
  materializeActivityQueryV2,
  materializeConfiguredBrowserSource,
  materializeConfiguredContextSources,
} from '~/util/materializeV2';
import { useSettingsStore } from '~/stores/settings';
import { useBucketsStore } from '~/stores/buckets';
import {
  resolveActivityProfileV2,
  fullActivityQueryV2,
  fullActivityMultiQueryV2,
  queryStringToArray,
  type CanonicalQueryParamsV2,
  type ActivityReportParamsV2,
  type CategorySpecV2,
  type ActivityCoverageSource,
  type ContextSource,
} from '~/queries';

export const ACTIVITY_V2_UNSUPPORTED_ERROR =
  "This server doesn't support the flexible activity model this dashboard needs. Update your ActivityWatch server to see these reports.";

export interface HostActivityInput {
  host: string;
  buckets: IBucket[];
  compiledV2?: CompiledActivityQueryV2;
  filter_afk?: boolean;
  filter_categories?: string[][] | null;
  include_stopwatch?: boolean;
  include_audible?: boolean;
  explain_categories?: boolean;
  return_variable_suffix?: string;
  // Overrides the compiled category specs (e.g. a synthetic "searched" category).
  // `undefined` keeps the compiled specs; `null` clears categorization.
  category_specs?: CategorySpecV2[] | null;
  // Extra configured context sources merged in at query time (e.g. Report's
  // searchable sources). These are ordinary namespaced sources, never root fields.
  extra_context_sources?: ContextSource[];
}

export interface MaterializedHostActivity {
  params: CanonicalQueryParamsV2;
  appTitleSourceId?: string;
  browserFocusSourceId?: string;
  stopwatchSourceId?: string;
  browserSource?: ActivityCoverageSource;
}

// The app/title presentation projection is drawn only from the explicitly
// configured source when that materialized source exposes both fields. When it
// is unavailable, app/title summaries are empty for that host.
export function selectAppTitleSourceId(
  params: CanonicalQueryParamsV2,
  configuredSourceId?: string
): string | undefined {
  if (!configuredSourceId) return undefined;
  const sources = [...(params.activity_coverage_sources ?? []), ...(params.context_sources ?? [])];
  const hasAppTitle = (source: ActivityCoverageSource | ContextSource) =>
    source.fields?.includes('app') && source.fields?.includes('title');
  return sources.find(source => source.source_id === configuredSourceId && hasAppTitle(source))
    ?.source_id;
}

// Browser focus is derived only from the explicit configured source when its
// materialized fields include app. It never falls back to another source or to
// a canonical root app field.
export function selectBrowserFocusSourceId(
  params: CanonicalQueryParamsV2,
  configuredSourceId?: string
): string | undefined {
  if (!configuredSourceId) return undefined;
  const sources = [...(params.activity_coverage_sources ?? []), ...(params.context_sources ?? [])];
  const hasApp = (source: ActivityCoverageSource | ContextSource) => source.fields?.includes('app');
  return sources.find(source => source.source_id === configuredSourceId && hasApp(source))
    ?.source_id;
}

// Stopwatch, when requested, is materialized as an ordinary namespaced coverage
// source (source id `stopwatch`) rather than a privileged bid_stopwatch.
export function selectStopwatchSourceId(
  params: CanonicalQueryParamsV2,
  includeStopwatch?: boolean
): string | undefined {
  if (!includeStopwatch) return undefined;
  const source = (params.activity_coverage_sources ?? []).find(
    candidate => candidate.source_id === 'stopwatch'
  );
  return source?.source_id;
}

export function materializeHostActivityV2(
  input: HostActivityInput
): MaterializedHostActivity | null {
  if (!input.compiledV2) return null;
  const params = materializeActivityQueryV2({
    compiled: input.compiledV2,
    buckets: input.buckets,
    host: input.host,
    filterAfk: input.filter_afk,
    filterCategories: input.filter_categories ?? null,
    explainCategories: input.explain_categories,
    includeStopwatch: input.include_stopwatch,
    includeAudible: input.include_audible,
    returnVariableSuffix: input.return_variable_suffix,
  });
  if (input.category_specs !== undefined) {
    params.category_specs = input.category_specs ?? undefined;
  }
  if (input.extra_context_sources?.length) {
    params.context_sources = [...(params.context_sources ?? []), ...input.extra_context_sources];
  }
  return {
    params,
    appTitleSourceId: selectAppTitleSourceId(params, input.compiledV2.app_title_source_id),
    browserFocusSourceId: selectBrowserFocusSourceId(
      params,
      input.compiledV2.browser_focus_source_id
    ),
    stopwatchSourceId: selectStopwatchSourceId(params, input.include_stopwatch),
    browserSource: materializeConfiguredBrowserSource(input.compiledV2, input.buckets, input.host),
  };
}

// Store-aware convenience for Vue callers. On capable servers (compiled v2 query
// present) it materializes a source-only canonical-events query for the host and
// never injects bid_window / bid_afk / always_active_pattern / bid_stopwatch. On
// unsupported servers throw a visible compatibility error.
export function resolveActivityEventsQuery(opts: {
  host: string;
  filter_afk?: boolean;
  v2?: {
    filter_afk?: boolean;
    filter_categories?: string[][] | null;
    include_audible?: boolean;
    explain_categories?: boolean;
    return_variable_suffix?: string;
    category_specs?: CategorySpecV2[] | null;
    extra_context_sources?: ContextSource[];
  };
  returnStatement?: string;
}): { query: string[]; materialized: MaterializedHostActivity | null } {
  const settingsStore = useSettingsStore();
  const bucketsStore = useBucketsStore();
  const compiledV2 = settingsStore.compiledActivityQueryV2;
  if (!compiledV2) throw new Error(ACTIVITY_V2_UNSUPPORTED_ERROR);
  const v2Input: HostActivityInput = {
    host: opts.host,
    buckets: bucketsStore.buckets,
    compiledV2,
    filter_afk: opts.v2?.filter_afk ?? opts.filter_afk,
    filter_categories: opts.v2?.filter_categories ?? null,
    include_audible: opts.v2?.include_audible,
    explain_categories: opts.v2?.explain_categories,
    return_variable_suffix: opts.v2?.return_variable_suffix,
    category_specs: opts.v2?.category_specs,
    extra_context_sources: opts.v2?.extra_context_sources,
  };
  return buildActivityEventsQuery({
    v2: v2Input,
    returnStatement: opts.returnStatement,
  });
}

// Builds a canonical-events query returning `events` (or a custom return
// statement). New WebUI callers require the v2 source-only pipeline.
export function buildActivityEventsQuery(opts: {
  v2: HostActivityInput;
  returnStatement?: string;
}): { query: string[]; materialized: MaterializedHostActivity | null } {
  const returnStatement = opts.returnStatement ?? 'RETURN = events;';
  const materialized = materializeHostActivityV2(opts.v2);
  if (materialized) {
    const query = queryStringToArray(
      `${resolveActivityProfileV2(materialized.params)}\n${returnStatement}`
    );
    return { query, materialized };
  }
  throw new Error(ACTIVITY_V2_UNSUPPORTED_ERROR);
}

export function buildReportSearchActivityQueryV2(
  input: HostActivityInput & {
    configuredSources: SourceDefinitionV2[];
    regex: string;
    ignoreCase?: boolean;
  }
): { query: string[]; materialized: MaterializedHostActivity } {
  const materialized = materializeHostActivityV2(input);
  if (!materialized) throw new Error(ACTIVITY_V2_UNSUPPORTED_ERROR);

  const params = materialized.params;
  const existingIds = new Set(
    [...(params.activity_coverage_sources ?? []), ...(params.context_sources ?? [])].map(
      source => source.source_id
    )
  );
  const additionalContext = materializeConfiguredContextSources(
    input.configuredSources.filter(source => !existingIds.has(source.id)),
    input.buckets,
    input.host
  );
  for (const source of additionalContext) {
    if (existingIds.has(source.source_id)) continue;
    existingIds.add(source.source_id);
    (params.context_sources ??= []).push(source);
  }

  const searchableSources = [
    ...(params.activity_coverage_sources ?? []),
    ...(params.context_sources ?? []),
  ].filter((source, index, all) => {
    return all.findIndex(candidate => candidate.source_id === source.source_id) === index;
  });
  const configuredById = new Map(input.configuredSources.map(source => [source.id, source]));
  const rules: RuleExpressionV2[] = searchableSources.flatMap(source =>
    source.fields.map(field => ({
      type: 'regex' as const,
      source: source.source_id,
      field,
      regex: input.regex,
      ...(configuredById.get(source.source_id)?.field_types?.[field]
        ? { value_mode: configuredById.get(source.source_id)?.field_types?.[field] }
        : {}),
      ...(input.ignoreCase !== undefined ? { ignore_case: input.ignoreCase } : {}),
    }))
  );
  params.category_specs = [
    {
      id: 'report-search',
      name: ['searched'],
      rule: rules.length === 0 ? { type: 'none' } : { type: 'any', rules },
    },
  ];
  params.filter_categories = [['searched']];

  return {
    query: queryStringToArray(`${resolveActivityProfileV2(params)}\nRETURN = events;`),
    materialized,
  };
}

// Builds the full activity report query (generic `activity` section, browser and
// stopwatch sections). Returns the projection source IDs so the caller can remap
// the flat `$source.<id>.app/title` keys back onto plain `app`/`title` for
// presentation at the store boundary.
export function buildFullActivityQueryV2(
  input: HostActivityInput
): { query: string[]; materialized: MaterializedHostActivity } | null {
  const materialized = materializeHostActivityV2(input);
  if (!materialized) return null;
  const query = fullActivityQueryV2({
    ...materialized.params,
    app_title_source_id: materialized.appTitleSourceId,
    browser_focus_source_id: materialized.browserFocusSourceId,
    browser_source: materialized.browserSource,
    stopwatch_source_id: materialized.stopwatchSourceId,
  });
  return { query, materialized };
}

// Multi-device variant: materializes each host, resolves browser facts against
// that host's focus stream, then applies one shared host-precedence union. The
// returned projection selects the first host that actually materialized each
// configured presentation source, rather than assuming the first host did.
export function buildFullActivityMultiQueryV2(
  inputs: HostActivityInput[]
): { query: string[]; materialized: MaterializedHostActivity } | null {
  const materializedInputs = inputs
    .map(input => ({ input, materialized: materializeHostActivityV2(input) }))
    .filter(
      (entry): entry is { input: HostActivityInput; materialized: MaterializedHostActivity } =>
        entry.materialized !== null
    );
  if (materializedInputs.length === 0) return null;
  const materializedList = materializedInputs.map(entry => entry.materialized);
  const first = materializedList[0];
  const projection: MaterializedHostActivity = {
    params: first.params,
    appTitleSourceId: materializedList.find(m => m.appTitleSourceId)?.appTitleSourceId,
    browserFocusSourceId: materializedList.find(m => m.browserFocusSourceId)?.browserFocusSourceId,
    stopwatchSourceId: materializedList.find(m => m.stopwatchSourceId)?.stopwatchSourceId,
  };
  const reportParams: ActivityReportParamsV2[] = materializedInputs.map(({ materialized }) => ({
    ...materialized.params,
    app_title_source_id: materialized.appTitleSourceId,
    browser_focus_source_id: materialized.browserFocusSourceId,
    browser_source: materialized.browserSource,
    stopwatch_source_id: materialized.stopwatchSourceId,
  }));
  const query = fullActivityMultiQueryV2(reportParams);
  return { query, materialized: projection };
}

// Materializes several hosts for capable servers. Returns null when no compiled
// v2 query exists or no host materializes.
export function materializeHostsV2(
  hosts: string[],
  opts: {
    filter_afk?: boolean;
    filter_categories?: string[][] | null;
    include_audible?: boolean;
    include_stopwatch?: boolean;
  } = {}
): CanonicalQueryParamsV2[] | null {
  const settingsStore = useSettingsStore();
  const bucketsStore = useBucketsStore();
  const compiledV2 = settingsStore.compiledActivityQueryV2;
  if (!compiledV2) return null;
  const materialized = hosts
    .map(host =>
      materializeHostActivityV2({
        host,
        buckets: bucketsStore.buckets,
        compiledV2,
        filter_afk: opts.filter_afk,
        filter_categories: opts.filter_categories ?? null,
        include_audible: opts.include_audible,
        include_stopwatch: opts.include_stopwatch,
      })
    )
    .filter((m): m is MaterializedHostActivity => m !== null);
  if (materialized.length === 0) return null;
  return materialized.map(m => m.params);
}

// Remaps flat namespaced keys `$source.<id>.app`/`.title` back onto plain
// `app`/`title` on presentation events, so downstream summaries (aw-summary etc.)
// keep working without depending on the map_event_fields capability. When no
// projection source is configured the events are returned unchanged (already
// empty in that case).
export function projectMaterializedEventsForPresentation(
  events: IEvent[] | undefined,
  materialized: MaterializedHostActivity | null | undefined
): IEvent[] {
  return remapNamespacedAppTitle(events, materialized?.appTitleSourceId);
}

export function remapNamespacedAppTitle(
  events: IEvent[] | undefined,
  sourceId: string | undefined
): IEvent[] {
  if (!events) return [];
  if (!sourceId) return events;
  const appKey = `$source.${sourceId}.app`;
  const titleKey = `$source.${sourceId}.title`;
  return events.map(event => {
    const data = { ...event.data };
    if (appKey in data) data.app = data[appKey];
    if (titleKey in data) data.title = data[titleKey];
    return { ...event, data };
  });
}
