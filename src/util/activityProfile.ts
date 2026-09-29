import type { CompiledActivityQueryV2 } from '~/util/rulesV2';
import type { IBucket } from '~/util/interfaces';
import { resolveSourceBucketIds } from '~/queries';
import { materializeActivityQueryV2 } from '~/util/materializeV2';

interface ResolvedSource {
  bucket_ids: string[];
  scope?: 'host' | 'global';
  bucket_hosts?: Record<string, string>;
  host?: string;
}

function availableBucketIds(buckets: IBucket[]): Set<string> {
  return new Set(buckets.map(bucket => bucket.id));
}

function sourceAvailableForHost(
  source: ResolvedSource,
  host: string,
  bucketIds: Set<string>
): boolean {
  return resolveSourceBucketIds(source, host).some(bucketId => bucketIds.has(bucketId));
}

export function queryNeedsResolvedActiveTime(
  filterAfk: boolean | undefined,
  hasBackgroundSources: boolean
): boolean {
  return (filterAfk ?? true) || hasBackgroundSources;
}

// ---------------------------------------------------------------------------
// v2 availability — inspects only the materialized coverage/active-time sources.
// It never special-cases the currentwindow bucket type or a legacy window mode:
// the configured default window source is materialized like any other source,
// and a missing/unconfigured window bucket is simply inert.
// ---------------------------------------------------------------------------

export function hostHasResolvedActivityV2(
  host: string,
  buckets: IBucket[],
  compiled?: CompiledActivityQueryV2,
  options: {
    includeStopwatch?: boolean;
  } = {}
): boolean {
  if (!compiled) return false;
  const materialized = materializeActivityQueryV2({
    compiled,
    buckets,
    host,
    includeStopwatch: options.includeStopwatch,
  });
  const bucketIds = availableBucketIds(buckets);
  return (materialized.activity_coverage_sources ?? []).some(source =>
    sourceAvailableForHost(source, host, bucketIds)
  );
}

export function hostHasResolvedActiveTimeV2(
  host: string,
  buckets: IBucket[],
  compiled?: CompiledActivityQueryV2,
  options: {
    includeAudible?: boolean;
  } = {}
): boolean {
  if (!compiled) return false;
  const materialized = materializeActivityQueryV2({
    compiled,
    buckets,
    host,
    includeAudible: options.includeAudible,
  });
  const bucketIds = availableBucketIds(buckets);
  const keepsActiveCoverage = (materialized.activity_coverage_sources ?? []).some(
    source => source.keeps_active && sourceAvailableForHost(source, host, bucketIds)
  );
  if (keepsActiveCoverage) return true;
  if (!materialized.active_time_rule) return false;
  const activeSources = materialized.active_time_sources ?? [];
  // Source-free expressions (notably explicit `none` and nested none groups)
  // are valid, resolvable masks even though they intentionally yield no time.
  return (
    activeSources.length === 0 ||
    activeSources.some(source => sourceAvailableForHost(source, host, bucketIds))
  );
}
