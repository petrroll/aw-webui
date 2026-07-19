import { IBucket } from '~/util/interfaces';
import { canonicalMultideviceEvents, type MultiQueryParams, queryStringToArray } from '~/queries';
import type { CompiledProfileQueryOptions } from '~/util/rulesV2';
import { hostCanResolveProfile, hostHasResolvedActivity } from '~/util/activityProfile';

export interface WorkReportHostOption {
  value: string;
  text: string;
  disabled: boolean;
}

function getProfileHosts(buckets: IBucket[], compiled?: CompiledProfileQueryOptions): string[] {
  const hosts = buckets
    .map(bucket => bucket.hostname || bucket.data?.hostname)
    .filter((host): host is string => !!host && host !== 'unknown');
  return [...new Set(hosts)].filter(host => hostHasResolvedActivity(host, buckets, compiled));
}

export function getWorkReportHostOptions(
  buckets: IBucket[],
  compiled?: CompiledProfileQueryOptions
): WorkReportHostOption[] {
  return getProfileHosts(buckets, compiled).map(host => {
    const supported = hostCanResolveProfile({
      host,
      buckets,
      compiled,
      filterAfk: true,
    });
    return {
      value: host,
      text: supported ? host : `${host} (requires an active-time source)`,
      disabled: !supported,
    };
  });
}

export function getUnsupportedWorkReportHosts(
  selectedHosts: string[],
  buckets: IBucket[],
  compiled?: CompiledProfileQueryOptions
): string[] {
  return selectedHosts.filter(
    host => !hostCanResolveProfile({ host, buckets, compiled, filterAfk: true })
  );
}

export function getSupportedWorkReportHosts(
  selectedHosts: string[],
  buckets: IBucket[],
  compiled?: CompiledProfileQueryOptions
): string[] {
  const unsupportedHosts = new Set(getUnsupportedWorkReportHosts(selectedHosts, buckets, compiled));
  return selectedHosts.filter(host => !unsupportedHosts.has(host));
}

// Builds the aw-query string for the Work Time Report. Extracted from the
// component so the generated query can be snapshot-tested — that's how we
// catch arg-count regressions like flood(events, breakTime) which aw-query
// rejects with "Tried to call function flood with invalid amount of arguments".
export function buildWorkReportQuery(params: MultiQueryParams, categoriesFilter: any[]): string {
  const query = `
          ${canonicalMultideviceEvents({ ...params, filter_categories: categoriesFilter })}
          duration = sum_durations(events);
          RETURN = {"events": events, "duration": duration};
        `;
  // Strip per-line trailing whitespace so the snapshot test stays stable
  // under the trailing-whitespace pre-commit hook. aw-query is whitespace-
  // tolerant so this has no runtime effect.
  return queryStringToArray(query)
    .join('\n')
    .split('\n')
    .map(line => line.replace(/\s+$/, ''))
    .join('\n');
}
