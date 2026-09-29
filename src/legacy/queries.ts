import {
  queryStringToArray,
  resolveActivityProfile,
  serializeQueryJson,
  type AndroidQueryParams,
  type CategorySpecV2,
  type ContextSource,
} from '~/queries';

interface LegacyRule {
  type: string | null;
  regex?: string;
  ignore_case?: boolean;
  select_keys?: string[];
}

export type LegacyCategory = [string[], LegacyRule];

/** Query builders for Android and servers that expose only the Query2 v1 grammar. */
export function androidAppQuery(
  appbucket: string,
  categories: LegacyCategory[],
  filterCategories: string[][],
  advanced: {
    hostname?: string;
    category_specs?: CategorySpecV2[];
    context_sources?: ContextSource[];
    capabilities?: string[];
  } = {}
): string[] {
  const params: AndroidQueryParams = {
    bid_android: appbucket,
    categories,
    filter_categories: filterCategories,
    ...advanced,
  };

  const code = `
    ${resolveActivityProfile(params)}

    title_events = sort_by_duration(merge_events_by_keys(events, ["app", "classname"]));
    app_events   = sort_by_duration(merge_events_by_keys(title_events, ["app"]));
    cat_events   = sort_by_duration(merge_events_by_keys(events, ["$category"]));

    events = sort_by_timestamp(events);
    app_events  = limit_events(app_events, 100);
    title_events  = limit_events(title_events, 100);
    duration = sum_durations(events);
    RETURN  = {"app_events": app_events, "title_events": title_events, "cat_events": cat_events, "duration": duration, "active_events": app_events};
  `;
  return queryStringToArray(code);
}

export function androidActiveDurationQuery(androidbucket: string): string[] {
  return [
    `events = query_bucket(${serializeQueryJson(androidbucket)});`,
    'RETURN = sum_durations(events);',
  ];
}
