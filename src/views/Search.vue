<template lang="pug">
div
  h3 Search

  b-alert(variant="warning" show)
    | This feature is still in early development.

  b-alert(v-if="error" show variant="danger")
    | {{error}}

  b-input-group(size="lg")
    b-input(v-model="pattern" v-on:keyup.enter="search()" placeholder="Regex pattern to search for")
    b-input-group-append
      b-button(type="button", @click="search()" variant="success")
        icon.mr-1(name="search")
        | Search

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

    aw-selectable-eventview(:events="events")

    div
      | Didn't find what you were looking for?
      br
      | Add a week to the search: #[b-button(size="sm" variant="outline-dark" @click="extendByWeek()") +1 week]
</template>

<script lang="ts">
import _ from 'lodash';
import moment from 'moment';
import {
  projectMaterializedEventsForPresentation,
  resolveActivityEventsQuery,
} from '~/util/activityQuery';
import { useBucketsStore } from '~/stores/buckets';
import { useSettingsStore } from '~/stores/settings';

import 'vue-awesome/icons/search';
import 'vue-awesome/icons/spinner';
import 'vue-awesome/icons/angle-double-down';
import 'vue-awesome/icons/angle-double-up';

export default {
  name: 'Search',
  data() {
    return {
      pattern: '',
      events: null,

      status: null,
      error: '',

      // Options
      show_options: false,
      queryOptions: {
        start: moment().subtract(1, 'day'),
        stop: moment().add(1, 'day'),
      },
    };
  },
  methods: {
    search: async function () {
      const bucketsStore = useBucketsStore();
      await bucketsStore.ensureLoaded();
      const appTitleSourceId = useSettingsStore().compiledActivityQueryV2?.app_title_source_id;
      if (!appTitleSourceId) {
        this.error = 'Search requires a configured app/title presentation source.';
        return;
      }
      let built;
      try {
        built = resolveActivityEventsQuery({
          host: this.queryOptions.hostname,
          filter_afk: this.queryOptions.filter_afk,
          v2: {
            filter_afk: this.queryOptions.filter_afk,
            filter_categories: [['searched']],
            category_specs: [
              {
                id: 'searched',
                name: ['searched'],
                rule: {
                  type: 'any',
                  rules: [
                    {
                      type: 'regex',
                      source: appTitleSourceId,
                      field: 'app',
                      regex: this.pattern,
                    },
                    {
                      type: 'regex',
                      source: appTitleSourceId,
                      field: 'title',
                      regex: this.pattern,
                    },
                  ],
                },
              },
            ],
          },
        });
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
        return;
      }
      const { query: query_array, materialized } = built;
      const timeperiods = [
        moment(this.queryOptions.start).format() + '/' + moment(this.queryOptions.stop).format(),
      ];
      try {
        this.status = 'searching';
        const data = await this.$aw.query(timeperiods, query_array);
        this.events = _.orderBy(
          projectMaterializedEventsForPresentation(data[0], materialized),
          ['timestamp'],
          ['desc']
        );
        this.error = '';
      } catch (e) {
        console.error(e);
        this.error = e?.response?.data?.message ?? (e instanceof Error ? e.message : String(e));
      } finally {
        this.status = null;
      }
    },
    extendByWeek() {
      this.queryOptions.start = moment(this.queryOptions.start).subtract(1, 'week');
      this.search();
    },
  },
};
</script>
