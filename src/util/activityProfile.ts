import type { CompiledProfileQueryOptions } from '~/util/rulesV2';
import type { IBucket } from '~/util/interfaces';
import { resolveSourceBucketIds } from '~/queries';

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

function legacyBucketAvailable(buckets: IBucket[], host: string, type: string): boolean {
  return buckets.some(
    bucket =>
      bucket.type === type &&
      (type !== 'currentwindow' || !bucket.id.startsWith('aw-watcher-android')) &&
      (bucket.hostname === host || (!bucket.hostname && bucket.data?.hostname === host))
  );
}

export function hostHasResolvedActivity(
  host: string,
  buckets: IBucket[],
  compiled?: CompiledProfileQueryOptions
): boolean {
  if (
    (compiled?.legacy_window_mode ?? 'activity') === 'activity' &&
    legacyBucketAvailable(buckets, host, 'currentwindow')
  ) {
    return true;
  }
  const bucketIds = availableBucketIds(buckets);
  if (!compiled) return false;
  const activitySources: ResolvedSource[] = [
    ...(compiled.activity_coverage_sources ?? []),
    ...(compiled.activity_sources ?? []),
    ...(compiled.background_sources ?? []),
  ];
  return activitySources.some(source => sourceAvailableForHost(source, host, bucketIds));
}

export function hostHasResolvedActiveTime(
  host: string,
  buckets: IBucket[],
  compiled?: CompiledProfileQueryOptions
): boolean {
  if (!compiled?.active_time_rule) {
    return legacyBucketAvailable(buckets, host, 'afkstatus');
  }
  const bucketIds = availableBucketIds(buckets);
  return compiled.active_time_sources.some(source =>
    sourceAvailableForHost(source, host, bucketIds)
  );
}

export function queryNeedsResolvedActiveTime(
  filterAfk: boolean | undefined,
  hasBackgroundSources: boolean
): boolean {
  return (filterAfk ?? true) || hasBackgroundSources;
}

export function hostCanResolveProfile(input: {
  host: string;
  buckets: IBucket[];
  compiled?: CompiledProfileQueryOptions;
  filterAfk?: boolean;
}): boolean {
  const hasBackgroundSources = (input.compiled?.background_sources.length ?? 0) > 0;
  return (
    hostHasResolvedActivity(input.host, input.buckets, input.compiled) &&
    (!queryNeedsResolvedActiveTime(input.filterAfk, hasBackgroundSources) ||
      hostHasResolvedActiveTime(input.host, input.buckets, input.compiled))
  );
}
