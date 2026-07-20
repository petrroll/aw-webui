// Central v2 activity-query helper.
//
// Capable servers expose a compiled v2 query (`settingsStore.compiledActivityQueryV2`).
// When present, every caller must go through this helper: it materializes the
// compiled query per host (filling the configured default window source's actual
// bucket IDs only when that source exists) and builds a source-only query that
// never injects bid_window / bid_afk / always_active_pattern / bid_stopwatch or
// any root app/title field. Old-server / custom-UI compatibility alone falls back
// to the legacy resolveActivityProfile / fullDesktopQuery entry points.

import type { IBucket, IEvent } from '~/util/interfaces';
import type { CompiledActivityQueryV2 } from '~/util/rulesV2';
import { BUILTIN_WINDOW_SOURCE_ID } from '~/util/rulesV2';
import { materializeActivityQueryV2 } from '~/util/materializeV2';
import { useSettingsStore } from '~/stores/settings';
import { useBucketsStore } from '~/stores/buckets';
import {
  resolveActivityProfile,
  resolveActivityProfileV2,
  fullActivityQueryV2,
  fullActivityMultiQueryV2,
  queryStringToArray,
  type CanonicalQueryParamsV2,
  type CategorySpecV2,
  type ActivityCoverageSource,
  type ContextSource,
  type DesktopQueryParams,
} from '~/queries';

export interface HostActivityInput {
  host: string;
  buckets: IBucket[];
  compiledV2?: CompiledActivityQueryV2;
  filter_afk?: boolean;
  filter_categories?: string[][] | null;
  include_stopwatch?: boolean;
  include_audible?: boolean;
  browser_bucket_ids?: string[];
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
}

// The app/title presentation projection is drawn from a configured coverage
// source whose flat fields include both app and title. The default window source
// (builtin_window) is preferred when it is actually configured, but any other
// source qualifies. When none exists the app/title summaries are simply empty.
export function selectAppTitleSourceId(params: CanonicalQueryParamsV2): string | undefined {
  const sources = [...(params.activity_coverage_sources ?? []), ...(params.context_sources ?? [])];
  const hasAppTitle = (source: ActivityCoverageSource | ContextSource) =>
    source.fields?.includes('app') && source.fields?.includes('title');
  const windowSource = sources.find(
    source => source.source_id === BUILTIN_WINDOW_SOURCE_ID && hasAppTitle(source)
  );
  if (windowSource) return windowSource.source_id;
  return sources.find(hasAppTitle)?.source_id;
}

// Browser focus is derived from an explicit configured source whose flat fields
// include app. The default window source is preferred only if it is configured;
// otherwise the first source with an app field is used, and if none exists
// browser results are simply unavailable. Never a canonical root app field.
export function selectBrowserFocusSourceId(params: CanonicalQueryParamsV2): string | undefined {
  const sources = [...(params.activity_coverage_sources ?? []), ...(params.context_sources ?? [])];
  const hasApp = (source: ActivityCoverageSource | ContextSource) => source.fields?.includes('app');
  const windowSource = sources.find(
    source => source.source_id === BUILTIN_WINDOW_SOURCE_ID && hasApp(source)
  );
  if (windowSource) return windowSource.source_id;
  return sources.find(hasApp)?.source_id;
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
    browserBucketIds: input.browser_bucket_ids,
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
    appTitleSourceId: selectAppTitleSourceId(params),
    browserFocusSourceId: selectBrowserFocusSourceId(params),
    stopwatchSourceId: selectStopwatchSourceId(params, input.include_stopwatch),
  };
}

// Store-aware convenience for Vue callers. On capable servers (compiled v2 query
// present) it materializes a source-only canonical-events query for the host and
// never injects bid_window / bid_afk / always_active_pattern / bid_stopwatch. On
// old servers / custom setups it falls back to the caller-provided legacy params
// (which may still carry bid_window etc. for old-server compatibility).
export function resolveActivityEventsQuery(opts: {
  host: string;
  legacyParams: DesktopQueryParams;
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
  const v2Input: HostActivityInput | undefined = compiledV2
    ? {
        host: opts.host,
        buckets: bucketsStore.buckets,
        compiledV2,
        filter_afk: opts.v2?.filter_afk ?? opts.legacyParams.filter_afk,
        filter_categories: opts.v2?.filter_categories ?? null,
        include_audible: opts.v2?.include_audible,
        browser_bucket_ids: bucketsStore.bucketsBrowser(opts.host),
        explain_categories: opts.v2?.explain_categories,
        return_variable_suffix: opts.v2?.return_variable_suffix,
        category_specs: opts.v2?.category_specs,
        extra_context_sources: opts.v2?.extra_context_sources,
      }
    : undefined;
  return buildActivityEventsQuery({
    v2: v2Input ?? { host: opts.host, buckets: [] },
    legacyParams: opts.legacyParams,
    returnStatement: opts.returnStatement,
  });
}

// Builds a canonical-events query returning `events` (or a custom return
// statement). Uses the v2 source-only pipeline on capable servers, otherwise the
// legacy resolveActivityProfile entry point for old-server/custom-UI compat.
export function buildActivityEventsQuery(opts: {
  v2: HostActivityInput;
  legacyParams: DesktopQueryParams;
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
  const query = queryStringToArray(
    `${resolveActivityProfile(opts.legacyParams)}\n${returnStatement}`
  );
  return { query, materialized: null };
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
    browser_bucket_ids: input.browser_bucket_ids,
    stopwatch_source_id: materialized.stopwatchSourceId,
  });
  return { query, materialized };
}

// Multi-device variant: materializes each host and unions the results. Returns
// the shared projection source IDs (identical across hosts) so the caller can
// remap the flat namespaced keys at the store boundary.
export function buildFullActivityMultiQueryV2(
  inputs: HostActivityInput[]
): { query: string[]; materialized: MaterializedHostActivity } | null {
  const materializedList = inputs
    .map(input => materializeHostActivityV2(input))
    .filter((m): m is MaterializedHostActivity => m !== null);
  if (materializedList.length === 0) return null;
  const projection = materializedList[0];
  const browserBucketIds = inputs.flatMap(input => input.browser_bucket_ids ?? []);
  const query = fullActivityMultiQueryV2(
    materializedList.map(m => m.params),
    {
      app_title_source_id: projection.appTitleSourceId,
      browser_focus_source_id: projection.browserFocusSourceId,
      browser_bucket_ids: browserBucketIds,
      stopwatch_source_id: projection.stopwatchSourceId,
    }
  );
  return { query, materialized: projection };
}

// Materializes several hosts for capable servers. Returns null when no compiled
// v2 query exists (old-server/custom fallback) or no host materializes.
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
        browser_bucket_ids: bucketsStore.bucketsBrowser(host),
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
