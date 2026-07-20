<template lang="pug">
div
  h3 Report

  | Generate a report of time spent on a certain category of device activity.

  b-alert.mt-2(variant="warning" show)
    | This feature is still in early development.

  b-alert(v-if="error" show variant="danger")
    | {{error}}

  aw-select-categories-or-pattern(v-model="filterCategories")
    template(v-slot:input-group-append)
      b-button(type="button", @click="generate()" variant="success" :disabled="!has_pattern")
        icon(name="search")
        | Generate

  div.d-flex.mt-1
    span.mr-auto.small.text-muted Hostname: {{queryOptions.hostname}}
    b-button.border-0(size="sm", variant="outline-dark" @click="show_options = !show_options")
      span(v-if="!show_options")
        | #[icon(name="angle-double-down")] Show options
      span(v-else)
        | #[icon(name="angle-double-up")] Hide options

  div(v-show="show_options")
    h4 Options
    aw-query-options(v-model="queryOptions")

  div(v-if="status == 'searching'")
    div #[icon(name="spinner" pulse)] Searching...


  div(v-if="events != null")
    hr

    div.d-flex
      div.flex-fill
        | Found {{ events.length }} events in {{ (queryTime / 1000).toFixed(2) }} seconds
      div
        b-input-group(size="sm")
          b-input-group-prepend
            b-input-group-text
              icon(name="save")
              .mx-1 Export as:
          b-input-group-append
            b-button(type="button", @click="export_csv()" variant="outline-dark")
              | CSV
            b-button(type="button", @click="export_json()" variant="outline-dark")
              | JSON

    hr

    vis-timeline(:events="events.slice(0, 500)" filterShortEvents=true)
    div.small.text-muted(v-if="events.length > 500")
      | Showing the {{ 500 }} most recent events of {{ events.length }} total.

    hr

    aw-timeline-barchart(:datasets="datasets" :height="100")

    hr

    aw-selectable-eventview(:events="events")

    hr

    div
      | Didn't find what you were looking for?
      br
      | Add a week to the search: #[b-button(size="sm" variant="outline-dark" @click="extendByWeek()") +1 week]

</template>

<style scoped lang="scss"></style>

<script lang="ts">
import _ from 'lodash';
import moment from 'moment';
import Papa from 'papaparse';

import 'vue-awesome/icons/search';
import 'vue-awesome/icons/spinner';
import 'vue-awesome/icons/angle-double-down';
import 'vue-awesome/icons/angle-double-up';

import { resolveActivityEventsQuery } from '~/util/activityQuery';
import { BUILTIN_WINDOW_SOURCE_ID } from '~/util/rulesV2';
import { buildBarchartDataset } from '~/util/datasets';

import { useActivityStore } from '~/stores/activity';
import { useCategoryStore } from '~/stores/categories';
import { useBucketsStore } from '~/stores/buckets';
import { useSettingsStore } from '~/stores/settings';

import { getClient } from '~/util/awclient';
import { downloadFile } from '~/util/export';

export default {
  name: 'Report',
  data() {
    return {
      activityStore: useActivityStore(),
      categoryStore: useCategoryStore(),
      bucketsStore: useBucketsStore(),

      events: null,

      status: null,
      queryTime: null,
      error: '',

      // Options
      show_options: false,
      queryOptions: {},
      filterCategories: [],
    };
  },
  computed: {
    has_pattern: function () {
      return this.filterCategories.length > 0;
    },
    datasets: function () {
      return buildBarchartDataset(
        this.activityStore.category.by_period,
        this.categoryStore.classes
      );
    },
  },
  mounted: async function () {
    await this.bucketsStore.ensureLoaded();
  },
  methods: {
    generate: async function () {
      // TODO: use full query (one per day/timeperiod) instead of resolving each period separately
      const settingsStore = useSettingsStore();
      const compiled = settingsStore.compiledRulesV2;
      const customRule = this.filterCategories.find(category => category[0][0] === 'searched');
      const customRegex = customRule
        ? {
            type: 'regex' as const,
            regex: customRule[1].regex,
            ignore_case: customRule[1].ignore_case,
          }
        : undefined;
      const profileSources = settingsStore.rulesV2.activity_profiles_v2[0]?.sources ?? [];
      const searchableSources = profileSources.filter(source => source.builtin !== 'window');
      const coverageSourceIds = new Set(
        compiled?.activity_coverage_sources.map(source => source.source_id) ?? []
      );
      const reportContextSources = searchableSources
        .filter(source => !coverageSourceIds.has(source.id))
        .map(source => ({
          source_id: source.id,
          bucket_ids: source.bucket_ids,
          scope: source.scope,
          bucket_hosts: source.bucket_hosts,
          fields: source.fields,
          conflict: 'base_wins' as const,
          host: source.host,
        }));
      const searchableSourceIds = searchableSources.map(source => source.id);
      const v2SearchRule = customRule
        ? {
            type: 'any' as const,
            rules: [
              {
                type: 'regex' as const,
                source: BUILTIN_WINDOW_SOURCE_ID,
                regex: customRule[1].regex,
                ignore_case: customRule[1].ignore_case,
              },
              ...searchableSourceIds.map(source => ({
                type: 'regex' as const,
                source,
                regex: customRule[1].regex,
                ignore_case: customRule[1].ignore_case,
              })),
            ],
          }
        : undefined;
      const { query: query_array } = resolveActivityEventsQuery({
        host: this.queryOptions.hostname,
        v2: {
          filter_afk: this.queryOptions.filter_afk,
          filter_categories: this.filterCategories.map(c => c[0]),
          category_specs: v2SearchRule
            ? [{ id: 'report-search', name: ['searched'], rule: v2SearchRule }]
            : undefined,
          extra_context_sources: customRule ? reportContextSources : undefined,
        },
        legacyParams: {
          hostname: this.queryOptions.hostname,
          bid_window: this.bucketsStore.bucketsWindow(this.queryOptions.hostname)[0],
          bid_afk: this.bucketsStore.bucketsAFK(this.queryOptions.hostname)[0],
          filter_afk: this.queryOptions.filter_afk,
          categories: this.filterCategories,
          filter_categories: this.filterCategories.map(c => c[0]),
          ...(compiled ?? {}),
          ...(customRule && compiled
            ? {
                context_sources: reportContextSources,
                category_specs: [
                  {
                    id: 'report-search',
                    name: ['searched'],
                    rule:
                      searchableSourceIds.length > 0
                        ? {
                            type: 'any',
                            rules: [
                              customRegex,
                              ...searchableSourceIds.map(source => ({
                                ...customRegex,
                                source,
                              })),
                            ],
                          }
                        : customRegex,
                  },
                ],
              }
            : {}),
        },
      });
      const start = moment(this.queryOptions.start).format();
      const end = moment(this.queryOptions.stop).format();
      const timeperiods = [start + '/' + end];
      try {
        this.status = 'searching';
        const time = moment();
        const data = await getClient().query(timeperiods, query_array);
        this.events = _.orderBy(data[0], ['timestamp'], ['desc']);
        this.error = '';
        this.queryTime = moment().diff(time);
      } catch (e) {
        console.error(e);
        this.error = e.response.data.message;
      } finally {
        this.status = null;
      }
    },

    async export_json() {
      const data = JSON.stringify(this.events, null, 2);
      await downloadFile('events.json', data, 'application/json');
    },

    async export_csv() {
      const data = this.events.map(e => {
        return [e.timestamp, e.duration, e.data['$category'], e.data['app'], e.data['title']];
      });
      const csv = Papa.unparse(data, {
        columns: ['timestamp', 'duration', 'category', 'app', 'title'],
      });
      await downloadFile('events.csv', csv, 'text/csv');
    },

    extendByWeek() {
      this.queryOptions.start = moment(this.queryOptions.start).subtract(1, 'week');
      this.generate();
    },
  },
};
</script>
