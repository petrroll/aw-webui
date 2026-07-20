import type { IBucket } from '~/util/interfaces';
import type { CanonicalQueryParamsV2 } from '~/queries';
import {
  BUILTIN_WINDOW_SOURCE_ID,
  type CompiledActivityQueryV2,
  type CompiledCoverageSourceV2,
  type CompiledContextSourceV2,
  type CompiledActiveSourceV2,
  type RuleExpressionV2,
} from '~/util/rulesV2';

const AFK_SOURCE_ID = 'afk';

function bucketHost(bucket: IBucket | undefined): string | undefined {
  return bucket?.hostname || bucket?.data?.hostname;
}

function bucketOwnedByHost(bucket: IBucket, host: string): boolean {
  return bucketHost(bucket) === host;
}

// A configured builtin window source is one the compiled profile actually kept,
// whether as an activity-coverage source or a context source. The legacy
// always-active pattern branch may only be materialized when such a source
// exists; if the profile removed the window source the branch must never be
// rediscovered from a stray currentwindow bucket. compileActivityQueryV2 already
// rejects a nonempty always_active_pattern without a configured window source, so
// this predicate keeps materialization symmetrical with that validation.
function windowSourceConfigured(compiled: CompiledActivityQueryV2): boolean {
  return (
    compiled.activity_coverage_sources.some(source => source.builtin === 'window') ||
    compiled.context_sources.some(source => source.builtin === 'window')
  );
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
    .map(bucket => bucket.id);
}

export function findAfkBucketIds(buckets: IBucket[], host: string): string[] {
  return buckets
    .filter(bucket => bucket.type === 'afkstatus' && bucketOwnedByHost(bucket, host))
    .map(bucket => bucket.id);
}

export function findBrowserBucketIds(buckets: IBucket[], host: string): string[] {
  const browserBuckets = buckets.filter(bucket => bucket.type === 'web.tab.current');
  const owned = browserBuckets.filter(bucket => bucketOwnedByHost(bucket, host));
  return (
    owned.length > 0 ? owned : browserBuckets.filter(bucket => bucketHost(bucket) === 'unknown')
  ).map(bucket => bucket.id);
}

export function findStopwatchBucketIds(buckets: IBucket[], host: string): string[] {
  const stopwatchBuckets = buckets.filter(bucket => bucket.type === 'general.stopwatch');
  const owned = stopwatchBuckets.filter(bucket => bucketOwnedByHost(bucket, host));
  return (
    owned.length > 0 ? owned : stopwatchBuckets.filter(bucket => bucketHost(bucket) === 'unknown')
  ).map(bucket => bucket.id);
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
  browserBucketIds?: string[];
  returnVariableSuffix?: string;
}

// Materializes a compiled v2 query for a specific host: fills the configured
// default window source's actual bucket IDs (only when that source exists),
// drops sources that resolve to no available bucket (so an unconfigured or
// missing window bucket is inert), synthesizes explicit AFK/window active-time
// sources from retained legacy settings, and adds a requested stopwatch as an
// ordinary namespaced coverage source. It never injects root app/title.
export function materializeActivityQueryV2(
  input: MaterializeActivityQueryV2Input
): CanonicalQueryParamsV2 {
  const { compiled, buckets, host } = input;
  const windowBucketIds = findWindowBucketIds(buckets, host);
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

  if (!activeTimeRule && compiled.legacy_active_time) {
    const branches: RuleExpressionV2[] = [];
    const synthSources: CompiledActiveSourceV2[] = [];
    if (compiled.legacy_active_time.use_afk && afkBucketIds.length > 0) {
      synthSources.push({
        source_id: AFK_SOURCE_ID,
        bucket_ids: afkBucketIds,
        scope: 'host',
        host,
      });
      branches.push({ type: 'regex', source: AFK_SOURCE_ID, field: 'status', regex: 'not-afk' });
    }
    if (
      compiled.legacy_active_time.always_active_pattern &&
      windowSourceConfigured(compiled) &&
      windowBucketIds.length > 0
    ) {
      synthSources.push({
        source_id: BUILTIN_WINDOW_SOURCE_ID,
        bucket_ids: windowBucketIds,
        scope: 'host',
        host,
      });
      const pattern = compiled.legacy_active_time.always_active_pattern;
      branches.push({
        type: 'any',
        rules: [
          { type: 'regex', source: BUILTIN_WINDOW_SOURCE_ID, field: 'app', regex: pattern },
          { type: 'regex', source: BUILTIN_WINDOW_SOURCE_ID, field: 'title', regex: pattern },
        ],
      });
    }
    // Audible-browser active-time: when legacy simple mode included audible
    // browser time, materialize it as explicit generated browser active-time
    // sources (bucket IDs supplied by the caller) with a rule matching the
    // `audible` field. This is best-effort: if the server cannot evaluate the
    // boolean field it is simply inert (never a false active period).
    if (
      compiled.legacy_active_time.include_audible &&
      input.includeAudible &&
      (input.browserBucketIds?.length ?? 0) > 0
    ) {
      const audibleBranches: RuleExpressionV2[] = [];
      (input.browserBucketIds ?? []).forEach((bucketId, index) => {
        const sourceId = `browser_audible_${index}`;
        const usesUnknownFallback =
          bucketHost(buckets.find(bucket => bucket.id === bucketId)) === 'unknown';
        synthSources.push({
          source_id: sourceId,
          bucket_ids: [bucketId],
          scope: usesUnknownFallback ? 'global' : 'host',
          ...(usesUnknownFallback ? {} : { host }),
        });
        audibleBranches.push({
          type: 'regex',
          source: sourceId,
          field: 'audible',
          regex: 'true',
        });
      });
      if (audibleBranches.length > 0) {
        branches.push(
          audibleBranches.length === 1
            ? audibleBranches[0]
            : { type: 'any', rules: audibleBranches }
        );
      }
    }
    if (branches.length > 0) {
      activeTimeRule = branches.length === 1 ? branches[0] : { type: 'any', rules: branches };
      const seen = new Set<string>();
      activeTimeSources = synthSources.filter(source => {
        if (seen.has(source.source_id)) return false;
        seen.add(source.source_id);
        return true;
      });
    }
  }
  if (activeTimeRule && activeTimeSources.length === 0) {
    activeTimeRule = undefined;
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
