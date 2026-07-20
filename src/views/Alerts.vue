<template lang="pug">
div
  h3 Alerts

  // TODO: Call this "goals" instead? (alerts is more general, but goals might fit the most common use better
  // TODO: Support 'less than' goals
  // TODO: Send notifications when goals met
  // TODO: Query from day start, not 24h ago

  b-alert(variant="warning" show)
    | This feature is still in early development.

  b-alert(v-if="error" show variant="danger")
    | {{error}}

  b-alert(v-if="hostnames.length === 0" show variant="info")
    | {{ $t('settings.categorization.noResolvedActivityHost') }}
    span.ml-1 {{ $t('settings.categorization.activitySetupHelp') }}

  b-card(v-for="alert in alerts", :key="alert.name")
    b-button.float-right(@click="deleteAlert(alert.name)" size="sm" variant="outline-danger")
      icon(name="trash")

    div Goal name: {{ alert.name }}
    div Category: {{ alert.category.join(" > ") }}
    div Current: {{ alertTime(alert.category) | friendlyduration }} / {{alert.goal}} minutes
      span(v-if="alertTime(alert.category) >= alert.goal")
        icon.text-success(name="check")
      span(v-else)
        icon.text-muted(name="times")

  div.d-flex.align-items-center.mt-3
    b-btn(@click="check" variant="success" :disabled="!hostname") Check
    b-form-checkbox.ml-3.mb-0(v-model="autorefresh", @change="toggleAutoRefresh", switch) Auto-refresh every 10s

  small.text-muted(v-if="last_updated")
    | Last updated #[time(:datetime="last_updated && last_updated.toISOString && last_updated.toISOString()") {{ last_updated | friendlytime }}]

  hr

  div
    h4 New alert
    b-form-group(label="Name" label-cols-md=2)
      b-input(v-model="editing_alert.name")
    b-form-group(label="Category" label-cols-md=2)
      b-select(v-model="editing_alert.category")
        option(v-for="category in categories" :value="category.value") {{ category.text }}
    b-form-group(label="Goal" label-cols-md=2)
      b-input-group(append="minutes")
        b-input(v-model="editing_alert.goal" type="number")

    div
      b-btn(@click="addAlert" variant="success")
        icon(name="plus")
        | Add alert
</template>

<style scoped lang="scss"></style>

<script lang="ts">
import _ from 'lodash';
import moment from 'moment';
import { resolveActivityEventsQuery } from '~/util/activityQuery';
import { hostHasResolvedActivityV2, hostHasResolvedActiveTimeV2 } from '~/util/activityProfile';

import 'vue-awesome/icons/plus';
import 'vue-awesome/icons/check';
import 'vue-awesome/icons/times';
import 'vue-awesome/icons/trash';

import { useBucketsStore } from '~/stores/buckets';
import { useCategoryStore } from '~/stores/categories';
import { useSettingsStore } from '~/stores/settings';

export default {
  name: 'Alerts',
  data() {
    return {
      bucketsStore: useBucketsStore(),
      categoryStore: useCategoryStore(),

      // TODO: Support negative goals (avoid distractions)
      alerts: [
        { name: 'Work', category: ['Work'], goal: 100 },
        { name: 'Media', category: ['Media'], goal: 10 },
      ],
      editing_alert: {},

      alert_times: {},

      error: '',

      hostnames: [],
      hostname: '',

      last_updated: null,

      autorefresh: false,
      running_interval: null,

      // Options
      show_options: false,
      use_regex: true,
      filter_afk: true,
    };
  },
  computed: {
    categories: function () {
      return this.categoryStore.category_select(true);
    },
    alertTime: function () {
      return cat => {
        let time = 0;
        _.map(Object.entries(this.alert_times), ([c, t]) => {
          if (c.startsWith(cat.join(','))) {
            if (typeof t === 'number') time += t;
          }
        });
        return time;
      };
    },
  },
  mounted: async function () {
    await this.bucketsStore.ensureLoaded();
    await this.categoryStore.load();
    const settingsStore = useSettingsStore();
    const compiledV2 = settingsStore.compiledActivityQueryV2;
    const activeTime = settingsStore.rulesV2.activity_profiles_v2[0]?.active_time;
    this.hostnames = compiledV2
      ? this.bucketsStore.hosts.filter(
          host =>
            hostHasResolvedActivityV2(host, this.bucketsStore.buckets, compiledV2) &&
            (!this.filter_afk ||
              hostHasResolvedActiveTimeV2(host, this.bucketsStore.buckets, compiledV2, {
                includeAudible:
                  activeTime?.type === 'legacy' ? activeTime.include_audible : undefined,
                browserBucketIds: this.bucketsStore.bucketsBrowser(host),
              }))
        )
      : [];
    this.hostname = this.hostnames[0];
  },
  methods: {
    addAlert: function () {
      // TODO: Persist to settings/localstorage
      this.alerts = this.alerts.concat({ ...this.editing_alert });
    },
    deleteAlert: function (name) {
      this.alerts = this.alerts.filter(a => a.name !== name);
    },

    toggleAutoRefresh: function () {
      if (!this.autorefresh || this.running_interval) {
        console.log('Stopping autorefresh');
        clearInterval(this.running_interval);
        this.autorefresh = false;
        this.running_interval = null;
      } else {
        console.log('Starting autorefresh');
        this.autorefresh = true;
        this.running_interval = setInterval(this.check, 10000);
      }
    },

    // Check current time of alert goals
    check: async function () {
      const { query: query_array } = resolveActivityEventsQuery({
        host: this.hostname,
        filter_afk: this.filter_afk,
        v2: {
          filter_afk: this.filter_afk,
          filter_categories: null,
        },
      });

      // Get start of today
      const start = moment().subtract(1, 'days').startOf('day');
      const end = moment(start).add(1, 'days');
      const timeperiods = [start.format() + '/' + end.format()];

      try {
        this.status = 'searching';
        const data = await this.$aw.query(timeperiods, query_array);
        this.events = data[0];
        this.error = '';
      } catch (e) {
        console.error(e);
        this.error = e.response.data.message;
        return;
      } finally {
        this.status = null;
      }

      const grouped = _.groupBy(this.events, e => e.data.$category);
      const sumCats = Object.fromEntries(
        _.map(Object.entries(grouped), entry => {
          const [group, events] = entry;
          return [group.split(','), _.sumBy(events, 'duration')];
        })
      );
      this.alert_times = sumCats;

      this.last_updated = new Date();
    },
  },
};
</script>
