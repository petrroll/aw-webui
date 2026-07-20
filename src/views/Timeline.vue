<template lang="pug">
div
  h3 {{ $t('timeline.title') }}

  input-timeinterval(v-model="daterange", :defaultDuration="timeintervalDefaultDuration", :maxDuration="maxDuration").mb-3

  // Toolbar: filters (primary), display kebab (swimlanes etc.), event count,
  // and keyboard hint. Flex-wrap so it doesn't overlap at narrow widths.
  div.timeline-toolbar.d-flex.flex-wrap.align-items-center
    details.timeline-filters.mr-2(ref="filtersDetails")
      summary.timeline-chip.timeline-chip--clickable
        icon.mr-1(name="filter")
        b Filters: {{ filter_summary }}
      div.timeline-filters-panel.shadow-sm
        table
          tr
            th.pt-2.pr-3
              label(for="timeline-filter-host") Host:
            td
              timeline-filter-select#timeline-filter-host(
                v-model="filter_hostnames"
                :options="host_options"
                aria-label="Host"
              )
          tr
            th.pt-2.pr-3
              label(for="timeline-filter-client") Client:
            td
              timeline-filter-select#timeline-filter-client(
                v-model="filter_clients"
                :options="client_options"
                aria-label="Client"
              )
          tr
            th.pt-2.pr-3
              label(for="timeline-filter-duration") Duration:
            td
              select#timeline-filter-duration.form-control.form-control-sm(v-model="filter_duration")
                option(:value='null') All
                option(:value='2') 2+ secs
                option(:value='5') 5+ secs
                option(:value='10') 10+ secs
                option(:value='30') 30+ sec
                option(:value='1 * 60') 1+ mins
                option(:value='2 * 60') 2+ mins
                option(:value='3 * 60') 3+ mins
                option(:value='10 * 60') 10+ mins
                option(:value='30 * 60') 30+ mins
                option(:value='1 * 60 * 60') 1+ hrs
                option(:value='2 * 60 * 60') 2+ hrs
          tr
            th.pt-2.pr-3
              label AFK:
            td
              b-form-checkbox(v-model="filter_afk" size="sm" switch)
                | {{ $t('timeline.filterAfk') }}

    // Display options (swimlanes, future visual toggles) tucked behind a
    // ghost kebab so they don't compete visually with Filters.
    b-dropdown.kebab-dropdown.mr-2(
      size="sm"
      variant="outline-secondary"
      toggle-class="border-0"
      no-caret
      right
      title="Display options"
      aria-label="Display options"
    )
      template(v-slot:button-content)
        icon(name="ellipsis-v")
      b-dropdown-header Display
      b-dropdown-item-button(
        :active="filter_merge_similar"
        @click="filter_merge_similar = !filter_merge_similar"
      ) {{ $t('timeline.mergeByApp') }}
      b-dropdown-divider
      b-dropdown-header Swimlanes
      b-dropdown-item-button(
        v-for="opt in swimlaneOptions"
        :key="String(opt.value)"
        :active="swimlane === opt.value"
        @click="swimlane = opt.value"
      ) {{ opt.text }}

    div.timeline-chip.mr-2.text-muted
      | {{ num_events }} {{ $t('timeline.eventsShown') }}

    small.text-muted.mr-3(v-if="hasCategoryResult")
      | {{ $t('timeline.inactiveLegend') }}

    small.text-warning.mr-3(v-else-if="categoryResultMessage")
      | {{ categoryResultMessage }}

    small.text-muted.ml-auto
      | {{ $t('timeline.scrollHint') }}

  b-alert.mb-2(
    v-if="buckets !== null && num_events === 0 && !hasCategoryResult"
    variant="warning"
    show
  )
    | {{ $t('timeline.noEvents') }}

  div(v-if="buckets !== null")
    vis-timeline(
      :buckets="buckets"
      :showRowLabels="true"
      :queriedInterval="daterange"
      :swimlane="swimlane"
      :updateTimelineWindow="updateTimelineWindow"
    )

    aw-devonly(reason="Not ready for production, still experimenting")
      aw-calendar(:buckets="buckets")
  div(v-else)
    h1.aw-loading {{ $t('common.loading') }}
</template>

<script lang="ts">
import 'vue-awesome/icons/filter';
import 'vue-awesome/icons/ellipsis-v';
import _ from 'lodash';
import { mapState } from 'pinia';
import { useSettingsStore } from '~/stores/settings';
import { useBucketsStore } from '~/stores/buckets';
import { getClient } from '~/util/awclient';
import { hostHasResolvedActiveTime, hostHasResolvedActiveTimeV2 } from '~/util/activityProfile';
import { resolveActivityEventsQuery } from '~/util/activityQuery';
import { useCategoryStore } from '~/stores/categories';
import { seconds_to_duration } from '~/util/time';
import TimelineFilterSelect from '~/components/TimelineFilterSelect.vue';
import {
  buildTimelineCategoryColorResolver,
  filterTimelineBucketsByPeriods,
  hostCanResolveTimelineCategory,
  splitCategoryEventsByActivity,
} from '~/util/timelineCategories';

export default {
  name: 'Timeline',
  components: { TimelineFilterSelect },
  data() {
    return {
      all_buckets: null,
      hosts: [],
      buckets: null,
      clients: [],
      daterange: null,
      maxDuration: 31 * 24 * 60 * 60,
      filter_hostnames: [],
      filter_clients: [],
      filter_duration: null,
      filter_afk: false,
      filter_merge_similar: true,
      swimlane: null,
      swimlaneOptions: [
        { value: null, text: 'None' },
        { value: 'bucketType', text: 'Group by bucket type' },
      ],
      updateTimelineWindow: true,
      loadGeneration: 0,
      categoryResultMessage: '',
    };
  },
  computed: {
    hasCategoryResult() {
      return this.buckets?.some(bucket => bucket.type === 'category-result') ?? false;
    },
    ...mapState(useSettingsStore, ['always_active_pattern']),
    timeintervalDefaultDuration() {
      const settingsStore = useSettingsStore();
      return Number(settingsStore.durationDefault);
    },
    // This does not match the chartData which is rendered in the timeline, as chartData excludes short events.
    num_events() {
      return _.sumBy(
        _.filter(this.buckets, bucket => bucket.type !== 'category-result'),
        'events.length'
      );
    },
    host_options() {
      return (this.hosts ?? []).map(host => ({ value: host, text: host }));
    },
    client_options() {
      return (this.clients ?? []).map(client => ({ value: client, text: client }));
    },
    filter_summary() {
      const desc = [];
      if (this.filter_hostnames.length === 1) {
        desc.push(this.filter_hostnames[0]);
      } else if (this.filter_hostnames.length > 1) {
        desc.push(`${this.filter_hostnames.length} hosts`);
      }
      if (this.filter_clients.length === 1) {
        desc.push(this.filter_clients[0]);
      } else if (this.filter_clients.length > 1) {
        desc.push(`${this.filter_clients.length} clients`);
      }
      if (this.filter_duration > 0) {
        desc.push(seconds_to_duration(this.filter_duration));
      }
      if (this.filter_afk) {
        desc.push('AFK filtered');
      }
      if (desc.length > 0) {
        return desc.join(', ');
      }
      return 'none';
    },
  },
  watch: {
    daterange() {
      this.updateTimelineWindow = true;
      this.getBuckets();
    },
    filter_hostnames() {
      this.updateTimelineWindow = false;
      this.getBuckets();
    },
    filter_clients() {
      this.updateTimelineWindow = false;
      this.getBuckets();
    },
    filter_duration() {
      this.updateTimelineWindow = false;
      this.getBuckets();
    },
    filter_afk() {
      this.updateTimelineWindow = false;
      this.getBuckets();
    },
    filter_merge_similar() {
      this.updateTimelineWindow = false;
      this.getBuckets();
    },
    swimlane() {
      this.updateTimelineWindow = false;
    },
  },
  methods: {
    getBuckets: async function () {
      if (this.daterange == null) return;

      const generation = ++this.loadGeneration;
      const bucketsStore = useBucketsStore();
      await bucketsStore.ensureLoaded();
      if (generation !== this.loadGeneration) return;

      this.hosts = bucketsStore.buckets
        .map(bucket => bucket.hostname)
        .filter((value, index, array) => value && array.indexOf(value) === index);

      const categoryBucketsPromise = this._queryCategoryResultBuckets(generation);
      const allBuckets = await bucketsStore.getBucketsWithEvents({
        start: this.daterange[0].format(),
        end: this.daterange[1].format(),
      });
      if (generation !== this.loadGeneration) return;
      this.all_buckets = Object.freeze(allBuckets);
      this.clients = allBuckets
        .map(bucket => bucket.client)
        .filter((value, index, array) => value && array.indexOf(value) === index);

      let buckets = allBuckets;
      if (this.filter_hostnames.length > 0) {
        buckets = _.filter(buckets, b => this.filter_hostnames.includes(b.hostname));
      }
      if (this.filter_clients.length > 0) {
        buckets = _.filter(buckets, b => this.filter_clients.includes(b.client));
      }

      if (this.filter_duration > 0) {
        buckets = buckets.map(bucket => ({
          ...bucket,
          events: _.filter(bucket.events, event => event.duration >= this.filter_duration),
        }));
      }

      const categoryBuckets = await categoryBucketsPromise;
      if (generation !== this.loadGeneration) return;

      if (this.filter_afk) {
        buckets = this._filterBucketsByTimelinePeriods(buckets, categoryBuckets, {
          activeOnly: true,
          keepAfkBuckets: false,
        });
      }

      // Merge adjacent events by app name for window buckets.
      // Runs after AFK filtering so merges operate on already-filtered events.
      // Reduces visual clutter from apps that produce many small events (e.g.
      // Adobe Illustrator's TAB key toggling UI panels). See: activitywatch#1165
      if (this.filter_merge_similar) {
        buckets = this._applyMergeSimilar(buckets);
      }

      this.buckets = [...categoryBuckets, ...buckets];
    },

    _filterBucketsByTimelinePeriods: function (
      buckets,
      categoryBuckets,
      { activeOnly, keepAfkBuckets }
    ) {
      return filterTimelineBucketsByPeriods(buckets, categoryBuckets, {
        activeOnly,
        keepAfkBuckets,
      });
    },

    async _queryCategoryResultBuckets(generation) {
      const bucketsStore = useBucketsStore();
      const settingsStore = useSettingsStore();
      const categoryStore = useCategoryStore();
      if (generation === this.loadGeneration) this.categoryResultMessage = '';
      const visibleHosts = this.filter_hostnames.length > 0 ? this.filter_hostnames : this.hosts;
      const advanced = settingsStore.compiledRulesV2;
      const compiledV2 = settingsStore.compiledActivityQueryV2;
      const eligibleHosts = visibleHosts.filter(hostname =>
        hostCanResolveTimelineCategory({
          host: hostname,
          buckets: bucketsStore.buckets,
          compiledV2,
          compiledLegacy: advanced,
        })
      );
      if (eligibleHosts.length === 0) {
        if (generation === this.loadGeneration) {
          this.categoryResultMessage = String(this.$t('timeline.noCategoryActivitySource'));
        }
        return [];
      }
      const categorySet = settingsStore.rulesV2.category_sets_v2[0];
      if (!categorySet) {
        if (generation === this.loadGeneration) {
          this.categoryResultMessage = String(this.$t('timeline.categoryResultUnavailable'));
        }
        return [];
      }
      const categoryColor = buildTimelineCategoryColorResolver(categorySet);
      const results = await Promise.all(
        eligibleHosts.map(async hostname => {
          const windowBucketIds = bucketsStore.bucketsWindow(hostname);
          const afkBucketIds = bucketsStore.bucketsAFK(hostname);

          try {
            const profile = settingsStore.rulesV2.activity_profiles_v2[0];
            const activeTime = profile?.active_time;
            const timelineReturn = `
      category_events = events;
      RETURN = {"all": category_events, "active": not_afk};
    `;
            const { query: queryArray } = resolveActivityEventsQuery({
              host: hostname,
              v2: {
                filter_afk: false,
                filter_categories: null,
                include_audible:
                  activeTime?.type === 'legacy' ? activeTime.include_audible : undefined,
              },
              legacyParams: {
                hostname,
                bid_window: windowBucketIds[0],
                bid_afk: afkBucketIds[0],
                bid_browsers: bucketsStore.bucketsBrowser(hostname),
                bid_stopwatch: bucketsStore.bucketsStopwatch(hostname)[0],
                filter_afk: false,
                include_audible:
                  activeTime?.type === 'legacy' ? activeTime.include_audible : undefined,
                always_active_pattern: this.always_active_pattern || undefined,
                categories: categoryStore.classes_for_query,
                filter_categories: null,
                ...(advanced ?? {}),
              },
              returnStatement: timelineReturn,
            });
            const period = `${this.daterange[0].format()}/${this.daterange[1].format()}`;
            const data = await getClient().query([period], queryArray);
            const result = data[0] ?? {};
            const hasActiveTime = settingsStore.compiledActivityQueryV2
              ? hostHasResolvedActiveTimeV2(
                  hostname,
                  bucketsStore.buckets,
                  settingsStore.compiledActivityQueryV2,
                  {
                    includeAudible:
                      activeTime?.type === 'legacy' ? activeTime.include_audible : undefined,
                    browserBucketIds: bucketsStore.bucketsBrowser(hostname),
                  }
                )
              : hostHasResolvedActiveTime(hostname, bucketsStore.buckets, advanced);
            const categoryEvents = result.all ?? [];
            const activeEvents = hasActiveTime ? result.active ?? [] : categoryEvents;
            const events = splitCategoryEventsByActivity(categoryEvents, activeEvents).map(
              event => {
                const category = event.data?.['$category'] ?? ['Uncategorized'];
                return {
                  ...event,
                  data: {
                    ...event.data,
                    $category: category,
                    $color: categoryColor(category),
                  },
                };
              }
            );
            const label = String(this.$t('timeline.categoryResult'));
            return {
              id: `category-result:${hostname}`,
              hostname,
              type: 'category-result',
              data: {
                label,
              },
              events,
            };
          } catch (error) {
            console.warn(`Category result query failed for ${hostname}:`, error);
            return null;
          }
        })
      );

      const categoryBuckets = results.filter(Boolean);
      if (categoryBuckets.length === 0 && generation === this.loadGeneration) {
        this.categoryResultMessage = String(this.$t('timeline.categoryResultUnavailable'));
      }
      return categoryBuckets;
    },

    // Merges adjacent events with the same app name within window buckets.
    // This collapses rapid title changes (e.g. toggling UI panels) into single
    // blocks per app, fixing timeline flooding for apps like Adobe Illustrator.
    _applyMergeSimilar: function (buckets) {
      return buckets.map(bucket => {
        if (bucket.type !== 'currentwindow' || !bucket.events || bucket.events.length <= 1) {
          return bucket;
        }

        const sorted = [...bucket.events].sort(
          (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
        );

        const merged = [];
        let current = { ...sorted[0] };

        for (let i = 1; i < sorted.length; i++) {
          const next = sorted[i];
          const currentEnd = new Date(current.timestamp).getTime() + current.duration * 1000;
          const nextStart = new Date(next.timestamp).getTime();
          const gap = nextStart - currentEnd;

          // Merge if same app and gap is small (< 30 seconds)
          if (current.data?.app && current.data.app === next.data?.app && gap < 30000) {
            const nextEnd = nextStart + next.duration * 1000;
            current.duration =
              (Math.max(currentEnd, nextEnd) - new Date(current.timestamp).getTime()) / 1000;
          } else {
            merged.push(current);
            current = { ...next };
          }
        }
        merged.push(current);

        return { ...bucket, events: merged };
      });
    },
  },
};
</script>

<style scoped>
.timeline-toolbar {
  row-gap: 0.5rem;
  margin-bottom: 0.5rem;
}

.timeline-chip {
  display: inline-flex;
  align-items: center;
  border: 1px solid #dee2e6;
  border-radius: 0.25rem;
  background: #fff;
  padding: 0.375rem 0.625rem;
  font-size: 0.875rem;
  line-height: 1.25;
}

.timeline-chip--clickable {
  cursor: pointer;
  user-select: none;
}

.timeline-chip--clickable:hover {
  background: #f8f9fa;
}

.timeline-filters {
  position: relative;
}

.timeline-filters > summary {
  list-style: none;
}

.timeline-filters > summary::-webkit-details-marker {
  display: none;
}

.timeline-filters-panel {
  display: none;
  position: absolute;
  left: 0;
  top: calc(100% + 4px);
  background: #fff;
  border: 1px solid #dee2e6;
  border-radius: 0.375rem;
  padding: 0.75rem 1rem;
  z-index: 100;
  min-width: 320px;
}

.timeline-filters[open] .timeline-filters-panel {
  display: block;
}
</style>
