import { defineStore } from 'pinia';
import moment from 'moment';
import * as _ from 'lodash';
import { map, filter, values, groupBy, sortBy, flow, reverse } from 'lodash/fp';
import { IEvent } from '~/util/interfaces';

import { window_events } from '~/util/fakedata';
import queries, {
  queryStringToArray,
  resolveActivityProfile,
  resolveActivityProfileV2,
} from '~/queries';
import { get_day_start_with_offset } from '~/util/time';
import {
  TimePeriod,
  dateToTimeperiod,
  timeperiodToStr,
  timeperiodsHoursOfPeriod,
  timeperiodsDaysOfPeriod,
  timeperiodsMonthsOfPeriod,
  timeperiodsAroundTimeperiod,
} from '~/util/timeperiod';

import { useSettingsStore } from '~/stores/settings';
import { useBucketsStore } from '~/stores/buckets';
import { useCategoryStore } from '~/stores/categories';
import {
  hostHasResolvedActivity,
  hostHasResolvedActiveTime,
  hostHasResolvedActivityV2,
  hostHasResolvedActiveTimeV2,
  queryNeedsResolvedActiveTime,
} from '~/util/activityProfile';
export { queryNeedsResolvedActiveTime } from '~/util/activityProfile';

import {
  buildFullActivityQueryV2,
  buildFullActivityMultiQueryV2,
  materializeHostActivityV2,
  remapNamespacedAppTitle,
  type HostActivityInput,
} from '~/util/activityQuery';

import { getClient } from '~/util/awclient';

function timeperiodsStrsHoursOfPeriod(timeperiod: TimePeriod): string[] {
  return timeperiodsHoursOfPeriod(timeperiod).map(timeperiodToStr);
}

function timeperiodsStrsDaysOfPeriod(timeperiod: TimePeriod): string[] {
  return timeperiodsDaysOfPeriod(timeperiod).map(timeperiodToStr);
}

function timeperiodsStrsMonthsOfPeriod(timeperiod: TimePeriod): string[] {
  return timeperiodsMonthsOfPeriod(timeperiod).map(timeperiodToStr);
}

function timeperiodStrsAroundTimeperiod(timeperiod: TimePeriod): string[] {
  return timeperiodsAroundTimeperiod(timeperiod).map(timeperiodToStr);
}

function colorCategories(events: IEvent[]): IEvent[] {
  // Set $color for categories
  const categoryStore = useCategoryStore();
  return events.map((e: IEvent) => {
    e.data['$color'] = categoryStore.get_category_color(e.data['$category']);
    return e;
  });
}

function scoreCategories(events: IEvent[]): IEvent[] {
  // Set $score for categories
  const categoryStore = useCategoryStore();
  return events.map((e: IEvent) => {
    e.data['$score'] = categoryStore.get_category_score(e.data['$category']);
    return e;
  });
}

// Builds the central v2 host input on capable servers (where a compiled v2 query
// exists). Callers use this to materialize a source-only query per host without
// ever hand-injecting bid_window / bid_afk / always_active_pattern / bid_stopwatch.
// Returns undefined on old servers / custom setups without a compiled v2 query,
// in which case callers fall back to the legacy resolveActivityProfile path.
function hostActivityInputV2(
  host: string,
  opts: {
    filter_afk?: boolean;
    filter_categories?: string[][] | null;
    include_stopwatch?: boolean;
    include_audible?: boolean;
    explain_categories?: boolean;
    return_variable_suffix?: string;
    category_specs?: HostActivityInput['category_specs'];
  } = {}
): HostActivityInput | undefined {
  const settingsStore = useSettingsStore();
  const bucketsStore = useBucketsStore();
  const compiledV2 = settingsStore.compiledActivityQueryV2;
  if (!compiledV2) return undefined;
  return {
    host,
    buckets: bucketsStore.buckets,
    compiledV2,
    filter_afk: opts.filter_afk,
    filter_categories: opts.filter_categories ?? null,
    include_stopwatch: opts.include_stopwatch,
    include_audible: opts.include_audible,
    browser_bucket_ids: bucketsStore.bucketsBrowser(host),
    explain_categories: opts.explain_categories,
    return_variable_suffix: opts.return_variable_suffix,
    category_specs: opts.category_specs,
  };
}

export interface QueryOptions {
  host: string;
  date?: string;
  timeperiod?: TimePeriod;
  filter_afk?: boolean;
  include_audible?: boolean;
  include_stopwatch?: boolean;
  filter_categories?: string[][];
  dont_query_inactive?: boolean;
  force?: boolean;
  always_active_pattern?: string;
}

interface State {
  loaded: boolean;

  activity: {
    available: boolean;
    top_apps: IEvent[];
    top_titles: IEvent[];
  };

  browser: {
    available: boolean;
    duration: number;
    top_urls: IEvent[];
    top_domains: IEvent[];
    top_titles: IEvent[];
  };

  editor: {
    available: boolean;
    duration: number;
    top_files: IEvent[];
    top_projects: IEvent[];
    top_languages: IEvent[];
  };

  category: {
    available: boolean;
    by_period: IEvent[];
    top: IEvent[];
  };

  active: {
    available: boolean;
    duration: number;
    // non-afk events (no detail data) for the current period
    events: IEvent[];
    // Aggregated events for current and past periods
    history: Record<any, IEvent[]>;
  };

  android: {
    available: boolean;
  };

  stopwatch: {
    available: boolean;
    top_stopwatches: IEvent[];
  };

  query_options?: QueryOptions;

  // Can't this be handled in bucketStore?
  buckets: {
    loaded: boolean;
    afk: string[];
    window: string[];
    editor: string[];
    browser: string[];
    android: string[];
    stopwatch: string[];
  };
}

export const useActivityStore = defineStore('activity', {
  // initial state
  state: (): State => ({
    // set to true once loading has started
    loaded: false,

    activity: {
      available: false,
      top_apps: [],
      top_titles: [],
    },

    browser: {
      available: false,
      duration: 0,
      top_domains: [],
      top_urls: [],
      top_titles: [],
    },

    editor: {
      available: false,
      duration: 0,
      top_files: [],
      top_languages: [],
      top_projects: [],
    },

    category: {
      available: false,
      by_period: [],
      top: [],
    },

    active: {
      available: false,
      duration: 0,
      // non-afk events (no detail data) for the current period
      events: [],
      // Aggregated events for current and past periods
      history: {},
    },

    android: {
      available: false,
    },

    stopwatch: {
      available: false,
      top_stopwatches: [],
    },

    query_options: null,

    buckets: {
      loaded: false,
      afk: [],
      window: [],
      editor: [],
      browser: [],
      android: [],
      stopwatch: [],
    },
  }),

  getters: {
    getActiveHistoryAroundTimeperiod(this: State) {
      return (timeperiod: TimePeriod): IEvent[][] => {
        const periods = timeperiodStrsAroundTimeperiod(timeperiod);
        const _history = periods.map(tp => {
          if (_.has(this.active.history, tp)) {
            return this.active.history[tp];
          } else {
            // A zero-duration placeholder until new data has been fetched
            return [{ timestamp: moment(tp.split('/')[0]).format(), duration: 0, data: {} }];
          }
        });
        return _history;
      };
    },
    uncategorizedDuration(this: State): [number, number] | null {
      // Returns the uncategorized duration and the total duration
      if (!this.category.top) {
        return null;
      }
      const uncategorized = this.category.top.filter(e => {
        return _.isEqual(e.data['$category'], ['Uncategorized']);
      });
      const uncategorized_duration = uncategorized.length > 0 ? uncategorized[0].duration : 0;
      const total_duration = this.category.top.reduce((acc, e) => {
        return acc + e.duration;
      }, 0);
      return [uncategorized_duration, total_duration];
    },
  },

  actions: {
    async ensure_loaded(query_options: QueryOptions) {
      const settingsStore = useSettingsStore();
      await settingsStore.ensureLoaded();

      const bucketsStore = useBucketsStore();

      console.info('Query options: ', query_options);
      if (this.loaded) {
        getClient().abort();
      }
      if (!this.loaded || this.query_options !== query_options || query_options.force) {
        this.start_loading(query_options);
        if (!query_options.timeperiod) {
          query_options.timeperiod = dateToTimeperiod(query_options.date, settingsStore.startOfDay);
        }

        await bucketsStore.ensureLoaded();
        await this.get_buckets(query_options);

        // TODO: These queries can actually run in parallel, but since server won't process them in parallel anyway we won't.
        this.set_available();

        if (this.activity.available) {
          console.info(
            settingsStore.useMultidevice ? 'Querying multiple devices' : 'Querying a single device'
          );
          if (settingsStore.useMultidevice) {
            const hostnames = this.eligibleMultideviceHosts(query_options);
            console.info('Including hosts in multiquery: ', hostnames);
            await this.query_multidevice_full(query_options, hostnames);
          } else {
            await this.query_desktop_full(query_options);
          }
        } else if (this.android.available) {
          await this.query_android(query_options);
        } else {
          console.log(
            'Cannot query activity because no eligible activity source and active-time source were resolved'
          );
          this.query_activity_completed();
          this.query_category_time_by_period_completed();
        }

        if (this.active.available) {
          await this.query_active_history(query_options);
        } else if (this.android.available) {
          await this.query_active_history_android(query_options);
        } else {
          console.log(
            'Cannot call query_active_history because no active-time source is available'
          );
          await this.query_active_history_completed();
        }

        if (this.editor.available) {
          await this.query_editor(query_options);
        } else {
          console.log('Cannot call query_editor as we do not have any editor buckets');
          await this.query_editor_completed();
        }

        // Perform this last, as it takes the longest
        if (this.activity.available || this.android.available) {
          await this.query_category_time_by_period(query_options);
        }
      } else {
        console.warn(
          'ensure_loaded called twice with same query_options but without query_options.force = true, skipping...'
        );
      }
    },

    async query_android({ timeperiod, filter_categories, host }: QueryOptions) {
      const periods = [timeperiodToStr(timeperiod)];
      const categoryStore = useCategoryStore();
      const advanced = useSettingsStore().compiledRulesV2;
      const q = queries.appQuery(
        this.buckets.android[0],
        categoryStore.classes_for_query,
        filter_categories,
        advanced
          ? {
              hostname: host,
              category_specs: advanced.category_specs,
              context_sources: advanced.context_sources,
              capabilities: advanced.capabilities,
            }
          : undefined
      );
      const data = await getClient().query(periods, q).catch(this.errorHandler);
      this.query_activity_completed(data[0]);
    },

    async reset() {
      getClient().abort();
      this.query_activity_completed({});
      this.query_browser_completed({});
      this.query_editor_completed({});
      this.query_category_time_by_period_completed({});
    },

    async query_multidevice_full(
      {
        timeperiod,
        filter_categories,
        filter_afk,
        include_audible,
        include_stopwatch,
        always_active_pattern,
      }: QueryOptions,
      hosts: string[]
    ) {
      const periods = [timeperiodToStr(timeperiod)];
      const categories = useCategoryStore().classes_for_query;

      // Capable servers: union per-host source-only v2 queries (no bid_window).
      const v2Inputs = hosts
        .map(host =>
          hostActivityInputV2(host, {
            filter_afk,
            filter_categories,
            include_stopwatch,
            include_audible,
          })
        )
        .filter((input): input is HostActivityInput => input !== undefined);
      const built =
        v2Inputs.length === hosts.length && v2Inputs.length > 0
          ? buildFullActivityMultiQueryV2(v2Inputs)
          : null;
      if (built) {
        const data = await getClient().query(periods, built.query, {
          name: 'multidevice',
          verbose: true,
        });
        const activity = { ...(data[0].activity ?? {}) };
        activity.app_events = remapNamespacedAppTitle(
          activity.app_events,
          built.materialized.appTitleSourceId
        );
        activity.title_events = remapNamespacedAppTitle(
          activity.title_events,
          built.materialized.appTitleSourceId
        );
        this.query_activity_completed(activity);
        this.query_browser_completed(data[0].browser);
        if (include_stopwatch) {
          this.query_stopwatch_completed(data[0].stopwatch);
        }
        return;
      }

      // Old-server / custom-UI compatibility: legacy multidevice query.
      const host_params = this.multideviceHostParams(hosts, true);
      const q = queries.multideviceQuery({
        hosts,
        filter_afk,
        categories,
        filter_categories,
        host_params,
        include_audible,
        always_active_pattern,
        ...useSettingsStore().compiledRulesV2,
      });
      const data = await getClient().query(periods, q, { name: 'multidevice', verbose: true });
      this.query_activity_completed(data[0].window);
    },

    eligibleMultideviceHosts(queryOptions: QueryOptions): string[] {
      const bucketsStore = useBucketsStore();
      const settingsStore = useSettingsStore();
      const compiledV2 = settingsStore.compiledActivityQueryV2;
      if (compiledV2) {
        // v2 availability inspects only materialized coverage/active-time sources.
        const needsActiveTime = queryNeedsResolvedActiveTime(queryOptions.filter_afk, false);
        return bucketsStore.hosts.filter(
          host =>
            host &&
            hostHasResolvedActivityV2(host, bucketsStore.buckets, compiledV2, {
              includeStopwatch: queryOptions.include_stopwatch,
            }) &&
            (!needsActiveTime ||
              hostHasResolvedActiveTimeV2(host, bucketsStore.buckets, compiledV2, {
                includeAudible: queryOptions.include_audible,
                browserBucketIds: bucketsStore.bucketsBrowser(host),
              })) &&
            (!host.startsWith('fakedata') || queryOptions.host.startsWith('fakedata'))
        );
      }
      const needsActiveTime = queryNeedsResolvedActiveTime(
        queryOptions.filter_afk,
        (settingsStore.compiledRulesV2?.background_sources.length ?? 0) > 0
      );
      return bucketsStore.hosts.filter(
        host =>
          host &&
          hostHasResolvedActivity(host, bucketsStore.buckets, settingsStore.compiledRulesV2) &&
          (!needsActiveTime ||
            hostHasResolvedActiveTime(host, bucketsStore.buckets, settingsStore.compiledRulesV2)) &&
          (!host.startsWith('fakedata') || queryOptions.host.startsWith('fakedata'))
      );
    },

    multideviceHostParams(hosts: string[], includeStopwatch: boolean) {
      const bucketsStore = useBucketsStore();
      return Object.fromEntries(
        hosts.map(host => [
          host,
          {
            bid_window: bucketsStore.bucketsWindow(host)[0],
            bid_afk: bucketsStore.bucketsAFK(host)[0],
            bid_browsers: bucketsStore.bucketsByType(host, 'web.tab.current'),
            bid_stopwatch: includeStopwatch
              ? bucketsStore.bucketsByType(host, 'general.stopwatch')[0]
              : undefined,
          },
        ])
      );
    },

    async query_desktop_full({
      timeperiod,
      filter_categories,
      filter_afk,
      include_audible,
      include_stopwatch,
      always_active_pattern,
      host,
    }: QueryOptions) {
      const periods = [timeperiodToStr(timeperiod)];
      const categories = useCategoryStore().classes_for_query;

      // Capable servers: build a source-only v2 query (no bid_window/bid_afk/
      // always_active_pattern/bid_stopwatch). App/title summaries are a
      // presentation projection from the configured source, remapped from the
      // flat `$source.<id>.app/title` keys at this store boundary.
      const v2Input = hostActivityInputV2(host, {
        filter_afk,
        filter_categories,
        include_stopwatch,
        include_audible,
      });
      const built = v2Input ? buildFullActivityQueryV2(v2Input) : null;
      if (built) {
        const data = await getClient().query(periods, built.query, {
          name: 'fullActivityQueryV2',
          verbose: true,
        });
        const activity = { ...(data[0].activity ?? {}) };
        activity.app_events = remapNamespacedAppTitle(
          activity.app_events,
          built.materialized.appTitleSourceId
        );
        activity.title_events = remapNamespacedAppTitle(
          activity.title_events,
          built.materialized.appTitleSourceId
        );
        this.query_activity_completed(activity);
        this.query_browser_completed(data[0].browser);
        if (include_stopwatch) {
          this.query_stopwatch_completed(data[0].stopwatch);
        }
        return;
      }

      // Old-server / custom-UI compatibility: legacy full desktop query.
      const q = queries.fullDesktopQuery({
        hostname: host,
        bid_window: this.buckets.window[0],
        bid_afk: this.buckets.afk[0],
        bid_browsers: this.buckets.browser,
        bid_stopwatch:
          include_stopwatch && this.buckets.stopwatch.length > 0
            ? this.buckets.stopwatch[0]
            : undefined,
        filter_afk,
        categories,
        filter_categories,
        include_audible,
        always_active_pattern,
        ...useSettingsStore().compiledRulesV2,
      });
      const data = await getClient().query(periods, q, {
        name: 'fullDesktopQuery',
        verbose: true,
      });
      this.query_activity_completed(data[0].window);
      this.query_browser_completed(data[0].browser);
      if (include_stopwatch) {
        this.query_stopwatch_completed(data[0].stopwatch);
      }
    },

    async query_editor({ timeperiod }) {
      const periods = [timeperiodToStr(timeperiod)];
      const q = queries.editorActivityQuery(this.buckets.editor);
      const data = await getClient().query(periods, q, {
        name: 'editorActivityQuery',
        verbose: true,
      });
      this.query_editor_completed(data[0]);
    },

    async query_active_history({ timeperiod, host, include_audible }: QueryOptions) {
      const settingsStore = useSettingsStore();
      const bucketsStore = useBucketsStore();
      // Filter out periods that are already in the history, and that are in the future
      const periods = timeperiodStrsAroundTimeperiod(timeperiod).filter(tp_str => {
        return (
          !_.includes(this.active.history, tp_str) && new Date(tp_str.split('/')[0]) < new Date()
        );
      });
      const compiledV2 = settingsStore.compiledActivityQueryV2;

      // Capable servers: build per-host source-only v2 queries (no bid_window/
      // bid_afk/always_active_pattern) and union the resulting active periods.
      if (compiledV2) {
        let activeHosts: string[];
        if (settingsStore.useMultidevice) {
          activeHosts = bucketsStore.hosts.filter(
            candidateHost =>
              candidateHost &&
              candidateHost !== 'unknown' &&
              hostHasResolvedActiveTimeV2(candidateHost, bucketsStore.buckets, compiledV2, {
                includeAudible: include_audible,
                browserBucketIds: bucketsStore.bucketsBrowser(candidateHost),
              }) &&
              hostHasResolvedActivityV2(candidateHost, bucketsStore.buckets, compiledV2) &&
              (!candidateHost.startsWith('fakedata') || host.startsWith('fakedata'))
          );
        } else {
          activeHosts =
            hostHasResolvedActiveTimeV2(host, bucketsStore.buckets, compiledV2, {
              includeAudible: include_audible,
              browserBucketIds: bucketsStore.bucketsBrowser(host),
            }) && hostHasResolvedActivityV2(host, bucketsStore.buckets, compiledV2)
              ? [host]
              : [];
        }
        const hostQueries = activeHosts.map((activeHost, index) => {
          const suffix = `active_host_${index}`;
          const input = hostActivityInputV2(activeHost, {
            filter_afk: false,
            filter_categories: null,
            include_audible,
            category_specs: null,
            return_variable_suffix: suffix,
          });
          const materialized = input ? materializeHostActivityV2(input) : null;
          return (
            resolveActivityProfileV2(materialized.params) +
            `\nactive_${suffix} = filter_period_intersect(events_${suffix}, not_afk_${suffix});`
          );
        });
        const union = activeHosts
          .map(
            (_activeHost, index) =>
              `active_events = union_no_overlap(active_events, active_active_host_${index});`
          )
          .join('\n');
        const query = queryStringToArray(
          `${hostQueries.join('\n')}\nactive_events = [];\n${union}\nRETURN = active_events;`
        );
        const data = await getClient().query(periods, query, {
          name: 'activityQuery',
          verbose: true,
        });
        const active_history = _.zipObject(periods, data);
        this.query_active_history_completed({ active_history });
        return;
      }

      // Old-server / custom-UI compatibility: legacy resolveActivityProfile path.
      let activeHosts: string[] = [];
      const advanced = settingsStore.compiledRulesV2;
      if (settingsStore.useMultidevice) {
        activeHosts = bucketsStore.hosts.filter(
          candidateHost =>
            candidateHost &&
            candidateHost !== 'unknown' &&
            hostHasResolvedActiveTime(
              candidateHost,
              bucketsStore.buckets,
              settingsStore.compiledRulesV2
            ) &&
            hostHasResolvedActivity(
              candidateHost,
              bucketsStore.buckets,
              settingsStore.compiledRulesV2
            ) &&
            (!candidateHost.startsWith('fakedata') || host.startsWith('fakedata'))
        );
      } else {
        activeHosts =
          hostHasResolvedActiveTime(host, bucketsStore.buckets, advanced) &&
          hostHasResolvedActivity(host, bucketsStore.buckets, advanced)
            ? [host]
            : [];
      }
      const profile = settingsStore.rulesV2.activity_profiles_v2[0];
      const {
        category_specs: _categorySpecs,
        context_sources: _contextSources,
        ...activityOptions
      } = advanced ?? {};
      const hostQueries = activeHosts.map((activeHost, index) => {
        const suffix = `active_host_${index}`;
        return (
          resolveActivityProfile({
            hostname: activeHost,
            bid_window: bucketsStore.bucketsWindow(activeHost)[0],
            bid_afk: bucketsStore.bucketsAFK(activeHost)[0],
            bid_browsers: bucketsStore.bucketsBrowser(activeHost),
            filter_afk: false,
            include_audible:
              profile?.active_time.type === 'legacy'
                ? profile.active_time.include_audible
                : undefined,
            always_active_pattern: settingsStore.always_active_pattern || undefined,
            categories: [],
            filter_categories: null,
            return_variable_suffix: suffix,
            ...activityOptions,
          }) + `\nactive_${suffix} = filter_period_intersect(events_${suffix}, not_afk_${suffix});`
        );
      });
      const union = activeHosts
        .map(
          (_activeHost, index) =>
            `active_events = union_no_overlap(active_events, active_active_host_${index});`
        )
        .join('\n');
      const query = queryStringToArray(
        `${hostQueries.join('\n')}\nactive_events = [];\n${union}\nRETURN = active_events;`
      );
      const data = await getClient().query(periods, query, {
        name: 'activityQuery',
        verbose: true,
      });
      const active_history = _.zipObject(periods, data);
      this.query_active_history_completed({ active_history });
    },

    async query_category_time_by_period({
      timeperiod,
      filter_categories,
      filter_afk,
      include_audible,
      include_stopwatch,
      dontQueryInactive,
      always_active_pattern,
      host,
    }: QueryOptions & { dontQueryInactive: boolean }) {
      // TODO: Needs to be adapted for Android
      let periods: string[];
      const count = timeperiod.length[0];
      const res = timeperiod.length[1];
      if (res.startsWith('day') && count == 1) {
        // If timeperiod is a single day, we query the individual hours
        periods = timeperiodsStrsHoursOfPeriod(timeperiod);
      } else if (
        res.startsWith('day') ||
        (res.startsWith('week') && count == 1) ||
        (res.startsWith('month') && count == 1)
      ) {
        // If timeperiod is several days, or a single week/month, we query the individual days
        periods = timeperiodsStrsDaysOfPeriod(timeperiod);
      } else if (timeperiod.length[1].startsWith('year') && timeperiod.length[0] == 1) {
        // If timeperiod a single year, we query the individual months
        periods = timeperiodsStrsMonthsOfPeriod(timeperiod);
      } else {
        console.error(`Unknown timeperiod length: ${timeperiod.length}`);
      }

      // Filter out periods that start in the future
      periods = periods.filter(period => new Date(period.split('/')[0]) < new Date());

      const signal = getClient().controller.signal;
      let cancelled = false;
      signal.onabort = () => {
        cancelled = true;
        console.debug('Request aborted');
      };

      // Query one period at a time, to avoid timeout on slow queries
      let data = [];
      for (const period of periods) {
        // Not stable
        //signal.throwIfAborted();
        if (cancelled) {
          throw signal['reason'] || 'unknown reason';
        }

        // Only query periods with known data from AFK bucket
        if (dontQueryInactive && this.active.events.length > 0) {
          const start = new Date(period.split('/')[0]);
          const end = new Date(period.split('/')[1]);

          // Retrieve active time in period
          const period_activity = this.active.events.find((e: IEvent) => {
            return start < new Date(e.timestamp) && new Date(e.timestamp) < end;
          });

          // Check if there was active time
          if (!(period_activity && period_activity.duration > 0)) {
            data = data.concat([{ cat_events: [] }]);
            continue;
          }
        }

        const isAndroid = this.buckets.android[0] !== undefined;
        const categories = useCategoryStore().classes_for_query;
        const settingsStore = useSettingsStore();
        const advanced = settingsStore.compiledRulesV2;
        const compiledV2 = settingsStore.compiledActivityQueryV2;
        const multideviceHosts =
          settingsStore.useMultidevice && !isAndroid
            ? this.eligibleMultideviceHosts({
                timeperiod,
                filter_afk,
                host,
              })
            : [];

        // Capable servers (non-Android): source-only v2 category query, never
        // injecting bid_window / bid_afk / bid_stopwatch / always_active_pattern.
        let query: string[] | undefined;
        if (compiledV2 && !isAndroid) {
          if (multideviceHosts.length > 0) {
            const perHostParams = multideviceHosts
              .map(mdHost =>
                hostActivityInputV2(mdHost, {
                  filter_afk,
                  filter_categories,
                  include_stopwatch,
                  include_audible,
                })
              )
              .filter((input): input is HostActivityInput => input !== undefined)
              .map(input => materializeHostActivityV2(input))
              .filter(m => m !== null)
              .map(m => m.params);
            query = queries.categoryActivityMultiQueryV2(perHostParams);
          } else {
            const input = hostActivityInputV2(host, {
              filter_afk,
              filter_categories,
              include_stopwatch,
              include_audible,
            });
            const materialized = input ? materializeHostActivityV2(input) : null;
            if (materialized) {
              query = queries.categoryActivityQueryV2(materialized.params);
            }
          }
        }

        // Old-server / custom-UI compatibility (or Android): legacy categoryQuery.
        if (!query) {
          // TODO: Clean up call, pass QueryParams in fullDesktopQuery as well
          // TODO: Unify QueryOptions and QueryParams
          query = queries.categoryQuery({
            bid_browsers: this.buckets.browser,
            bid_stopwatch:
              include_stopwatch && this.buckets.stopwatch.length > 0
                ? this.buckets.stopwatch[0]
                : undefined,
            categories,
            filter_categories,
            filter_afk,
            include_audible,
            always_active_pattern,
            ...(multideviceHosts.length > 0
              ? {
                  hosts: multideviceHosts,
                  host_params: this.multideviceHostParams(
                    multideviceHosts,
                    include_stopwatch ?? false
                  ),
                  ...advanced,
                }
              : isAndroid
              ? {
                  hostname: host,
                  bid_android: this.buckets.android[0],
                  ...(advanced
                    ? {
                        category_specs: advanced.category_specs,
                        context_sources: advanced.context_sources,
                        capabilities: advanced.capabilities,
                      }
                    : {}),
                }
              : {
                  hostname: host,
                  bid_afk: this.buckets.afk[0],
                  bid_window: this.buckets.window[0],
                  ...advanced,
                }),
          });
        }
        const result = await getClient().query([period], query, {
          verbose: true,
          name: 'categoryQuery',
        });
        data = data.concat(result);
      }

      // Zip periods
      let by_period = _.zipObject(periods, data);
      // Filter out values that are undefined (no longer needed, only used when visualization was progressive (looks buggy))
      by_period = _.fromPairs(_.toPairs(by_period).filter(o => o[1]));

      this.query_category_time_by_period_completed({ by_period });
    },

    async query_active_history_android({ timeperiod }: QueryOptions) {
      const periods = timeperiodStrsAroundTimeperiod(timeperiod).filter(tp_str => {
        return !_.includes(this.active.history, tp_str);
      });
      const data = await getClient().query(
        periods,
        queries.activityQueryAndroid(this.buckets.android[0])
      );
      const active_history = _.zipObject(periods, data);
      const active_history_events = _.mapValues(
        active_history,
        (duration: number, key): [IEvent] => {
          return [{ timestamp: key.split('/')[0], duration, data: { status: 'not-afk' } }];
        }
      );
      this.query_active_history_completed({ active_history: active_history_events });
    },

    set_available(this: State) {
      const currentHost = this.query_options?.host ?? '';
      const bucketsStore = useBucketsStore();
      const settingsStore = useSettingsStore();
      const compiledV2 = settingsStore.compiledActivityQueryV2;

      let activityAvailable: boolean;
      let activeTimeAvailable: boolean;
      let needsActiveTime: boolean;
      if (compiledV2) {
        // Capable servers: availability inspects only the materialized coverage
        // and active-time sources, never the currentwindow bucket type directly.
        activityAvailable = hostHasResolvedActivityV2(
          currentHost,
          bucketsStore.buckets,
          compiledV2,
          { includeStopwatch: this.query_options?.include_stopwatch }
        );
        activeTimeAvailable = hostHasResolvedActiveTimeV2(
          currentHost,
          bucketsStore.buckets,
          compiledV2,
          {
            includeAudible: this.query_options?.include_audible,
            browserBucketIds: bucketsStore.bucketsBrowser(currentHost),
          }
        );
        needsActiveTime = queryNeedsResolvedActiveTime(this.query_options?.filter_afk, false);
      } else {
        const compiled = settingsStore.compiledRulesV2;
        activityAvailable = hostHasResolvedActivity(currentHost, bucketsStore.buckets, compiled);
        activeTimeAvailable = hostHasResolvedActiveTime(
          currentHost,
          bucketsStore.buckets,
          compiled
        );
        needsActiveTime = queryNeedsResolvedActiveTime(
          this.query_options?.filter_afk,
          (compiled?.background_sources.length ?? 0) > 0
        );
      }

      this.activity.available = activityAvailable && (!needsActiveTime || activeTimeAvailable);
      // Browser availability is independent of window/activity availability: it
      // depends only on the presence of browser buckets.
      const v2Materialized = compiledV2
        ? materializeHostActivityV2({
            host: currentHost,
            buckets: bucketsStore.buckets,
            compiledV2,
            browser_bucket_ids: this.buckets.browser,
          })
        : null;
      this.browser.available =
        this.buckets.browser.length > 0 &&
        (!compiledV2 || v2Materialized?.browserFocusSourceId !== undefined);
      this.active.available = activeTimeAvailable;
      this.editor.available = this.buckets.editor.length > 0;
      this.android.available = this.buckets.android.length > 0;
      this.category.available = activityAvailable || this.android.available;
      this.stopwatch.available = this.buckets.stopwatch.length > 0;
    },

    async get_buckets(this: State, { host }) {
      // TODO: Move to bucketStore on a per-host basis?
      const bucketsStore = useBucketsStore();
      this.buckets.afk = bucketsStore.bucketsAFK(host);
      this.buckets.window = bucketsStore.bucketsWindow(host);
      this.buckets.android = bucketsStore.bucketsAndroid(host);
      this.buckets.browser = bucketsStore.bucketsBrowser(host);
      this.buckets.editor = bucketsStore.bucketsEditor(host);
      this.buckets.stopwatch = bucketsStore.bucketsStopwatch(host);

      console.log('Available buckets: ', this.buckets);
      this.buckets.loaded = true;
    },

    async load_demo() {
      // A function to load some demo data (for screenshots and stuff)

      this.start_loading({});

      function groupSumEventsBy(events, key, f) {
        return flow(
          filter(f),
          groupBy(f),
          values,
          map((es: any) => {
            return { duration: _.sumBy(es, 'duration'), data: { [key]: f(es[0]) } };
          }),
          sortBy('duration'),
          reverse
        )(events);
      }

      const app_events = groupSumEventsBy(window_events, 'app', (e: any) => e.data.app);
      const title_events = groupSumEventsBy(window_events, 'title', (e: any) => e.data.title);
      const cat_events = groupSumEventsBy(window_events, '$category', (e: any) => e.data.$category);
      const url_events = groupSumEventsBy(window_events, 'url', (e: any) => e.data.url);
      const domain_events = groupSumEventsBy(window_events, '$domain', (e: any) =>
        e.data.url === undefined ? '' : new URL(e.data.url).host
      );
      const browser_title_events = groupSumEventsBy(
        window_events.filter((e: any) => e.data.url),
        'title',
        (e: any) => e.data.title
      );

      this.query_activity_completed({
        duration: _.sumBy(window_events, 'duration'),
        app_events,
        title_events,
        cat_events,
        active_events: [
          {
            timestamp: new Date().toISOString(),
            duration: 1.5 * 60 * 60,
            data: { afk: 'not-afk' },
          },
        ],
      });

      this.buckets.browser = ['aw-watcher-firefox'];
      this.query_browser_completed({
        duration: _.sumBy(url_events, 'duration'),
        domains: domain_events,
        urls: url_events,
        titles: browser_title_events,
      });

      this.buckets.editor = ['aw-watcher-vim'];
      this.query_editor_completed({
        duration: 30,
        files: [{ duration: 10, data: { file: 'test.py' } }],
        languages: [{ duration: 10, data: { language: 'python' } }],
        projects: [{ duration: 10, data: { project: 'aw-core' } }],
      });

      this.buckets.loaded = true;

      // fetch startOfDay from settings store
      const settingsStore = useSettingsStore();
      const startOfDay = settingsStore.startOfDay;

      function build_active_history() {
        const active_history = {};
        let current_day = moment(get_day_start_with_offset(null, startOfDay));
        _.map(_.range(0, 30), () => {
          const current_day_end = moment(current_day).add(1, 'day');
          active_history[`${current_day.format()}/${current_day_end.format()}`] = [
            {
              timestamp: current_day.format(),
              duration: 100 + 900 * Math.random(),
              data: { status: 'not-afk' },
            },
          ];
          current_day = current_day.add(-1, 'day');
        });
        return active_history;
      }
      this.query_active_history_completed({ active_history: build_active_history() });
    },

    // mutations
    start_loading(this: State, query_options: QueryOptions) {
      this.loaded = true;
      this.query_options = query_options;

      // Resets the store state while waiting for new query to finish
      this.activity.top_apps = null;
      this.activity.top_titles = null;

      this.browser.duration = 0;
      this.browser.top_domains = null;
      this.browser.top_urls = null;
      this.browser.top_titles = null;

      this.editor.duration = 0;
      this.editor.top_files = null;
      this.editor.top_languages = null;
      this.editor.top_projects = null;

      this.category.top = null;
      this.category.by_period = null;

      this.active.duration = null;

      // Ensures that active history isn't being fully reloaded on every date change
      // (see caching done in query_active_history and query_active_history_android)
      // FIXME: Better detection of when to actually clear (such as on force reload, hostname change)
      if (Object.keys(this.active.history).length === 0) {
        this.active.history = {};
      }
    },

    query_activity_completed(
      this: State,
      data = { app_events: [], title_events: [], cat_events: [], active_events: [], duration: 0 }
    ) {
      // Set $color and $score for categories
      if (data.cat_events) {
        data.cat_events = colorCategories(data.cat_events);
        data.cat_events = scoreCategories(data.cat_events);
      }

      this.activity.top_apps = data.app_events;
      this.activity.top_titles = data.title_events;
      this.category.top = data.cat_events;
      this.active.duration = data.duration;
      this.active.events = data.active_events;
    },

    query_browser_completed(
      this: State,
      data = { domains: [], urls: [], titles: [], duration: 0 }
    ) {
      this.browser.top_domains = data.domains;
      this.browser.top_urls = data.urls;
      this.browser.top_titles = data.titles;
      this.browser.duration = data.duration;
    },

    query_stopwatch_completed(this: State, data = { stopwatch_events: [] }) {
      this.stopwatch.top_stopwatches = data.stopwatch_events;
    },

    query_editor_completed(
      this: State,
      data = { duration: 0, files: [], languages: [], projects: [] }
    ) {
      this.editor.duration = data.duration;
      this.editor.top_files = data.files;
      this.editor.top_languages = data.languages;
      this.editor.top_projects = data.projects;
    },

    query_active_history_completed(this: State, { active_history } = { active_history: {} }) {
      this.active.history = {
        ...this.active.history,
        ...active_history,
      };
    },

    query_category_time_by_period_completed(this: State, { by_period } = { by_period: [] }) {
      this.category.by_period = by_period;
    },
  },
});
