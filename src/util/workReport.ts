import { IBucket } from '~/util/interfaces';
import {
  canonicalMultideviceEvents,
  canonicalMultideviceEventsV2,
  type CanonicalQueryParamsV2,
  type MultiQueryParams,
  queryStringToArray,
} from '~/queries';
import type { CompiledActivityQueryV2 } from '~/util/rulesV2';
import { hostHasResolvedActivityV2, hostHasResolvedActiveTimeV2 } from '~/util/activityProfile';

export interface WorkReportHostOption {
  value: string;
  text: string;
  disabled: boolean;
}

function getProfileHosts(buckets: IBucket[], compiledV2?: CompiledActivityQueryV2): string[] {
  const hosts = buckets
    .map(bucket => bucket.hostname || bucket.data?.hostname)
    .filter((host): host is string => !!host && host !== 'unknown');
  return [...new Set(hosts)].filter(host =>
    compiledV2 ? hostHasResolvedActivityV2(host, buckets, compiledV2) : false
  );
}

function hostCanResolveWorkReport(
  host: string,
  buckets: IBucket[],
  compiledV2?: CompiledActivityQueryV2,
  includeAudible?: boolean
): boolean {
  return compiledV2
    ? hostHasResolvedActivityV2(host, buckets, compiledV2) &&
        hostHasResolvedActiveTimeV2(host, buckets, compiledV2, { includeAudible })
    : false;
}

export function getWorkReportHostOptions(
  buckets: IBucket[],
  compiledV2?: CompiledActivityQueryV2,
  includeAudible?: boolean
): WorkReportHostOption[] {
  return getProfileHosts(buckets, compiledV2).map(host => {
    const supported = hostCanResolveWorkReport(host, buckets, compiledV2, includeAudible);
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
  compiledV2?: CompiledActivityQueryV2,
  includeAudible?: boolean
): string[] {
  return selectedHosts.filter(
    host => !hostCanResolveWorkReport(host, buckets, compiledV2, includeAudible)
  );
}

export function getSupportedWorkReportHosts(
  selectedHosts: string[],
  buckets: IBucket[],
  compiledV2?: CompiledActivityQueryV2,
  includeAudible?: boolean
): string[] {
  const unsupportedHosts = new Set(
    getUnsupportedWorkReportHosts(selectedHosts, buckets, compiledV2, includeAudible)
  );
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

// Capable-server (v2) work report: source-only multidevice canonical events,
// filtered by the selected categories. No bid_window / always_active_pattern.
export function buildWorkReportQueryV2(
  perHostParams: CanonicalQueryParamsV2[],
  categoriesFilter: string[][]
): string {
  const query = `
          ${canonicalMultideviceEventsV2(perHostParams, categoriesFilter)}
          duration = sum_durations(events);
          RETURN = {"events": events, "duration": duration};
        `;
  return queryStringToArray(query)
    .join('\n')
    .split('\n')
    .map(line => line.replace(/\s+$/, ''))
    .join('\n');
}
