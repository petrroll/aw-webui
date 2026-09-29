import type { IBucket } from '~/util/interfaces';
import type { CanonicalQueryParamsV2 } from '~/queries';
import { browserAppNameRegex, browserAppNames, browserFamiliesWithBuckets } from '~/util/browser';
import {
  allocateGeneratedSourceId,
  type CompiledActivityQueryV2,
  type CompiledCoverageSourceV2,
  type CompiledContextSourceV2,
  type CompiledActiveSourceV2,
  type RuleExpressionV2,
  type SourceDefinitionV2,
  sourceIntervalPolicy,
} from '~/util/rulesV2';

function bucketHost(bucket: IBucket | undefined): string | undefined {
  return bucket?.hostname || bucket?.data?.hostname;
}

function bucketOwnedByHost(bucket: IBucket, host: string): boolean {
  return bucketHost(bucket) === host;
}

// Bucket discovery is host-scoped and inert on its own: it only produces bucket
// IDs that materialization fills into an *already configured* source. Discovering
// a currentwindow bucket does nothing unless the profile configures a window source.
export function findWindowBucketIds(buckets: IBucket[], host: string): string[] {
  return buckets
    .filter(
      bucket =>
        bucket.type === 'currentwindow' &&
        !bucket.id.startsWith('aw-watcher-android') &&
        bucketOwnedByHost(bucket, host)
    )
    .map(bucket => bucket.id)
    .sort();
}

export function findAfkBucketIds(buckets: IBucket[], host: string): string[] {
  return buckets
    .filter(bucket => bucket.type === 'afkstatus' && bucketOwnedByHost(bucket, host))
    .map(bucket => bucket.id)
    .sort();
}

export function findBrowserBucketIds(buckets: IBucket[], host: string): string[] {
  const browserBuckets = buckets.filter(bucket => bucket.type === 'web.tab.current');
  const owned = browserBuckets.filter(bucket => bucketOwnedByHost(bucket, host));
  return (
    owned.length > 0 ? owned : browserBuckets.filter(bucket => bucketHost(bucket) === 'unknown')
  )
    .map(bucket => bucket.id)
    .sort();
}

export function findStopwatchBucketIds(buckets: IBucket[], host: string): string[] {
  const stopwatchBuckets = buckets.filter(bucket => bucket.type === 'general.stopwatch');
  const owned = stopwatchBuckets.filter(bucket => bucketOwnedByHost(bucket, host));
  return (
    owned.length > 0 ? owned : stopwatchBuckets.filter(bucket => bucketHost(bucket) === 'unknown')
  )
    .map(bucket => bucket.id)
    .sort();
}

function materializeCoverageSource(
  source: CompiledCoverageSourceV2,
  buckets: IBucket[],
  host: string
): CompiledCoverageSourceV2 {
  if (source.builtin && source.bucket_ids.length === 0) {
    const bucketIds =
      source.builtin === 'window'
        ? findWindowBucketIds(buckets, host)
        : source.builtin === 'browser'
        ? findBrowserBucketIds(buckets, host)
        : findStopwatchBucketIds(buckets, host);
    const usesUnknownFallback = bucketIds.some(
      bucketId => bucketHost(buckets.find(bucket => bucket.id === bucketId)) === 'unknown'
    );
    const materialized: CompiledCoverageSourceV2 = {
      ...source,
      bucket_ids: bucketIds,
      scope: usesUnknownFallback ? 'global' : 'host',
      ...(usesUnknownFallback ? {} : { host }),
    };
    if (usesUnknownFallback) delete materialized.host;
    return materialized;
  }
  return { ...source, bucket_ids: [...source.bucket_ids] };
}

function materializeContextSource(
  source: CompiledContextSourceV2,
  buckets: IBucket[],
  host: string
): CompiledContextSourceV2 {
  return {
    ...materializeCoverageSource(source, buckets, host),
    conflict: 'base_wins',
  };
}

export function materializeConfiguredContextSources(
  sources: SourceDefinitionV2[],
  buckets: IBucket[],
  host: string
): CompiledContextSourceV2[] {
  return sources
    .map(source =>
      materializeContextSource(
        {
          source_id: source.id,
          ...(source.builtin ? { builtin: source.builtin } : {}),
          bucket_ids: [...source.bucket_ids],
          scope: source.bucket_ids.length === 0 && source.builtin ? 'host' : source.scope,
          ...(source.bucket_hosts ? { bucket_hosts: { ...source.bucket_hosts } } : {}),
          fields: [...source.fields],
          interval_policy: sourceIntervalPolicy(source),
          conflict: 'base_wins',
          host: source.host,
        },
        buckets,
        host
      )
    )
    .filter(source => source.bucket_ids.length > 0);
}

function activeSourceFromMaterializedCoverage(
  source: CompiledCoverageSourceV2
): CompiledActiveSourceV2 {
  return {
    source_id: source.source_id,
    ...(source.builtin ? { builtin: source.builtin } : {}),
    bucket_ids: [...source.bucket_ids],
    interval_policy: sourceIntervalPolicy(source),
    scope: source.scope,
    ...(source.bucket_hosts ? { bucket_hosts: { ...source.bucket_hosts } } : {}),
    host: source.host,
  };
}

function materializeActiveSource(
  source: CompiledActiveSourceV2,
  buckets: IBucket[],
  host: string
): CompiledActiveSourceV2 {
  if (source.builtin && source.builtin !== 'afk' && source.bucket_ids.length === 0) {
    const bucketIds =
      source.builtin === 'window'
        ? findWindowBucketIds(buckets, host)
        : source.builtin === 'browser'
        ? findBrowserBucketIds(buckets, host)
        : findStopwatchBucketIds(buckets, host);
    const usesUnknownFallback = bucketIds.some(
      bucketId => bucketHost(buckets.find(bucket => bucket.id === bucketId)) === 'unknown'
    );
    const materialized: CompiledActiveSourceV2 = {
      ...source,
      bucket_ids: bucketIds,
      scope: usesUnknownFallback ? 'global' : 'host',
      ...(usesUnknownFallback ? {} : { host }),
    };
    if (usesUnknownFallback) delete materialized.host;
    return materialized;
  }
  return { ...source, bucket_ids: [...source.bucket_ids] };
}

export interface MaterializeActivityQueryV2Input {
  compiled: CompiledActivityQueryV2;
  buckets: IBucket[];
  host: string;
  filterAfk?: boolean;
  filterCategories?: string[][] | null;
  explainCategories?: boolean;
  includeStopwatch?: boolean;
  includeAudible?: boolean;
  returnVariableSuffix?: string;
}

// Materializes a compiled v2 query for a specific host: fills the configured
// default window source's actual bucket IDs (only when that source exists),
// drops sources that resolve to no available bucket (so an unconfigured or
// missing window bucket is inert), synthesizes explicit AFK/window active-time
// sources from retained legacy settings. Stopwatch coverage is controlled by
// the configured source model; report options only control its presentation.
// It never injects root app/title.
export function materializeConfiguredBrowserSource(
  compiled: CompiledActivityQueryV2,
  buckets: IBucket[],
  host: string
): CompiledCoverageSourceV2 | undefined {
  if (!compiled.browser_source) return undefined;
  const source = materializeCoverageSource(compiled.browser_source, buckets, host);
  return source.bucket_ids.length > 0 ? source : undefined;
}

function sourceForBuckets(
  source: CompiledCoverageSourceV2,
  sourceId: string,
  bucketIds: string[]
): CompiledActiveSourceV2 {
  const bucketHosts = source.bucket_hosts
    ? Object.fromEntries(
        Object.entries(source.bucket_hosts).filter(([bucketId]) => bucketIds.includes(bucketId))
      )
    : undefined;
  return {
    source_id: sourceId,
    builtin: 'browser',
    bucket_ids: bucketIds,
    interval_policy: source.interval_policy,
    scope: source.scope,
    ...(bucketHosts && Object.keys(bucketHosts).length > 0 ? { bucket_hosts: bucketHosts } : {}),
    ...(source.host ? { host: source.host } : {}),
  };
}

export function materializeActivityQueryV2(
  input: MaterializeActivityQueryV2Input
): CanonicalQueryParamsV2 {
  const { compiled, buckets, host } = input;
  const afkBucketIds = findAfkBucketIds(buckets, host);

  const activityCoverage = compiled.activity_coverage_sources
    .map(source => materializeCoverageSource(source, buckets, host))
    .filter(source => source.bucket_ids.length > 0);

  const contextSources = compiled.context_sources
    .map(source => materializeContextSource(source, buckets, host))
    .filter(source => source.bucket_ids.length > 0);

  let activeTimeRule: RuleExpressionV2 | undefined = compiled.active_time_rule
    ? (JSON.parse(JSON.stringify(compiled.active_time_rule)) as RuleExpressionV2)
    : undefined;
  let activeTimeSources: CompiledActiveSourceV2[] = compiled.active_time_sources.map(source =>
    materializeActiveSource(source, buckets, host)
  );
  const hasKeepsActiveCoverage = activityCoverage.some(source => source.keeps_active);
  const unavailableActiveSource = activeTimeSources.find(
    source => source.builtin && source.bucket_ids.length === 0
  );
  if (
    activeTimeRule &&
    input.filterAfk !== false &&
    !hasKeepsActiveCoverage &&
    unavailableActiveSource
  ) {
    throw new Error(
      `Active-time rule references unavailable source '${unavailableActiveSource.source_id}'`
    );
  }

  if (!activeTimeRule && compiled.legacy_active_time) {
    const branches: RuleExpressionV2[] = [];
    const synthSources: CompiledActiveSourceV2[] = [];
    const occupiedSourceIds = new Set(
      compiled.declared_source_ids ?? [
        ...compiled.activity_coverage_sources.map(source => source.source_id),
        ...compiled.context_sources.map(source => source.source_id),
        ...compiled.active_time_sources.map(source => source.source_id),
        ...(compiled.browser_source ? [compiled.browser_source.source_id] : []),
      ]
    );
    const afkSourceId = compiled.legacy_active_time.use_afk
      ? allocateGeneratedSourceId(occupiedSourceIds, 'afk')
      : undefined;
    if (afkSourceId && afkBucketIds.length > 0) {
      synthSources.push({
        source_id: afkSourceId,
        bucket_ids: afkBucketIds,
        interval_policy: 'heartbeat',
        scope: 'host',
        host,
      });
      branches.push({ type: 'regex', source: afkSourceId, field: 'status', regex: '^not-afk$' });
    }
    const windowSource = [...activityCoverage, ...contextSources].find(
      source => source.builtin === 'window'
    );
    if (compiled.legacy_active_time.always_active_pattern && windowSource) {
      const pattern = compiled.legacy_active_time.always_active_pattern;
      const windowRules: RuleExpressionV2[] = windowSource.fields
        .filter(field => field === 'app' || field === 'title')
        .map(field => ({
          type: 'regex',
          source: windowSource.source_id,
          field,
          regex: pattern,
        }));
      if (windowRules.length > 0) {
        // Reuse the materialized canonical source exactly. In particular, a pinned
        // bucket or host scope must not be replaced by auto-discovered window
        // buckets merely because this is a legacy compatibility rule.
        synthSources.push(activeSourceFromMaterializedCoverage(windowSource));
        branches.push(
          windowRules.length === 1 ? windowRules[0] : { type: 'any', rules: windowRules }
        );
      }
    }
    // Legacy audible time counted only while the corresponding browser was the
    // focused app. Express that contract explicitly as (audible AND focused)
    // using the configured browser-focus source; without such a source this
    // compatibility branch remains unavailable rather than broadening behavior.
    const browserFocusSource = [...activityCoverage, ...contextSources].find(
      source =>
        (compiled.browser_focus_source_id
          ? source.source_id === compiled.browser_focus_source_id
          : source.builtin === 'window') && source.fields.includes('app')
    );
    const browserSource = materializeConfiguredBrowserSource(compiled, buckets, host);
    if (
      compiled.legacy_active_time.include_audible &&
      input.includeAudible !== false &&
      browserFocusSource &&
      browserSource?.fields.includes('audible')
    ) {
      const audibleBranches: RuleExpressionV2[] = [];
      browserFamiliesWithBuckets(browserSource.bucket_ids).forEach(
        ([browserName, bucketIds], index) => {
          const sourceId = allocateGeneratedSourceId(occupiedSourceIds, `browser_audible_${index}`);
          synthSources.push(sourceForBuckets(browserSource, sourceId, bucketIds));
          const focusRules: RuleExpressionV2[] = [];
          if (browserAppNames[browserName].length > 0) {
            const exactNames = browserAppNames[browserName]
              .map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
              .join('|');
            focusRules.push({
              type: 'regex',
              source: browserFocusSource.source_id,
              field: 'app',
              regex: `^(?:${exactNames})$`,
            });
          }
          const appPattern = browserAppNameRegex[browserName];
          if (appPattern) {
            focusRules.push({
              type: 'regex',
              source: browserFocusSource.source_id,
              field: 'app',
              regex: appPattern,
            });
          }
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
              focusRules.length === 1 ? focusRules[0] : { type: 'any', rules: focusRules },
            ],
          });
        }
      );
      if (audibleBranches.length > 0) {
        if (!synthSources.some(source => source.source_id === browserFocusSource.source_id)) {
          synthSources.push(activeSourceFromMaterializedCoverage(browserFocusSource));
        }
        branches.push(
          audibleBranches.length === 1
            ? audibleBranches[0]
            : { type: 'any', rules: audibleBranches }
        );
      }
    }
    if (branches.length > 0) {
      activeTimeRule = branches.length === 1 ? branches[0] : { type: 'any', rules: branches };
      activeTimeSources = synthSources;
    }
  }
  return {
    hostname: host,
    category_specs: compiled.category_specs,
    context_sources: contextSources,
    activity_coverage_sources: activityCoverage,
    active_time_rule: activeTimeRule,
    active_time_sources: activeTimeRule ? activeTimeSources : [],
    capabilities: compiled.capabilities,
    filter_categories: input.filterCategories ?? null,
    filter_afk: input.filterAfk,
    explain_categories: input.explainCategories,
    return_variable_suffix: input.returnVariableSuffix,
  };
}
