<template lang="pug">
div
  div.d-flex.align-items-center
    div.flex-grow-1
      aw-query-options(v-model="queryOptions")
    b-btn.ml-3(variant="primary" :disabled="loading || !available" @click="preview")
      b-spinner.mr-1(v-if="loading" small)
      | {{ $t('settings.categorization.previewAction') }}
  b-alert.mt-2(variant="warning" :show="!available")
    | {{ $t('settings.categorization.previewUnavailable') }}
  b-alert.mt-2(variant="danger" :show="!!error") {{ error }}
  b-alert.mt-3(
    variant="light"
    :show="hasPreviewed && !loading && !error && events.length === 0"
  ) {{ $t('settings.categorization.previewEmpty') }}
  table.table.table-sm.mt-3(v-if="events.length > 0")
    thead
      tr
        th {{ $t('settings.categorization.previewColEvent') }}
        th {{ $t('settings.categorization.previewColCategory') }}
        th {{ $t('settings.categorization.winningScore') }}
        th {{ $t('settings.categorization.previewColDetails') }}
    tbody
      tr(v-for="(event, index) in events" :key="index")
        td
          div {{ previewEventTitle(event) }}
          small.text-muted {{ previewEventSubtitle(event) }}
        td {{ (event.data.$category || [$t('settings.categorization.previewUncategorized')]).join(' > ') }}
        td {{ event.data.$category_score || 0 }}
        td
          details
            summary
              | {{ previewSummary(event) }}
            div.small.mt-1(
              v-for="candidate in matchedCandidates(event)"
              :key="candidate.id"
            )
              b {{ candidate.name.join(' > ') }}
              |  {{ $t('settings.categorization.previewCandidateScore', { score: candidate.score }) }}
              span.text-success(v-if="candidate.id === event.data.$category_explain.winner")
                |  ({{ $t('settings.categorization.previewWinner') }})
              span.text-muted(v-else-if="!candidate.eligible")
                |  ({{ $t('settings.categorization.previewPrerequisiteNotMet') }})
              span.text-muted(v-else)
                |  ({{ $t('settings.categorization.previewLostTiebreak') }})
              span(v-if="candidate.expression && candidate.expression.selected !== null && candidate.expression.selected !== undefined")
                | {{ $t('settings.categorization.previewOrBranch', { branch: candidate.expression.selected + 1 }) }}
</template>

<script lang="ts">
import moment from 'moment';
import { RULE_ENGINE_CAPABILITIES } from '~/queries';
import { resolveActivityEventsQuery, remapNamespacedAppTitle } from '~/util/activityQuery';
import { useBucketsStore } from '~/stores/buckets';
import { useCategoryStore } from '~/stores/categories';
import { useSettingsStore } from '~/stores/settings';
import { getClient } from '~/util/awclient';
import { get_inclusive_local_date_range } from '~/util/time';
import { hostHasResolvedActivityV2, hostHasResolvedActiveTimeV2 } from '~/util/activityProfile';

export default {
  name: 'RulesPreview',
  data() {
    return {
      bucketsStore: useBucketsStore(),
      categoryStore: useCategoryStore(),
      settingsStore: useSettingsStore(),
      queryOptions: {
        start: moment().subtract(1, 'hour'),
        stop: moment(),
        filter_afk: true,
        hostname: '',
      },
      loading: false,
      error: '',
      events: [] as any[],
      hasPreviewed: false,
    };
  },
  computed: {
    available: function () {
      return (
        !!this.settingsStore.compiledActivityQueryV2 &&
        this.settingsStore.compiledActivityQueryV2.capabilities.includes(
          RULE_ENGINE_CAPABILITIES.explainCategorize
        )
      );
    },
  },
  async mounted() {
    await this.settingsStore.ensureLoaded();
    await this.bucketsStore.ensureLoaded();
    const compiledV2 = this.settingsStore.compiledActivityQueryV2;
    const activeTime = this.settingsStore.rulesV2.activity_profiles_v2[0]?.active_time;
    this.queryOptions.hostname = compiledV2
      ? this.bucketsStore.hosts.find(
          host =>
            hostHasResolvedActivityV2(host, this.bucketsStore.buckets, compiledV2) &&
            (!this.queryOptions.filter_afk ||
              hostHasResolvedActiveTimeV2(host, this.bucketsStore.buckets, compiledV2, {
                includeAudible:
                  activeTime?.type === 'legacy' ? activeTime.include_audible : undefined,
                browserBucketIds: this.bucketsStore.bucketsBrowser(host),
              }))
        ) ?? ''
      : '';
  },
  methods: {
    async preview() {
      if (!this.settingsStore.compiledActivityQueryV2 || !this.queryOptions.hostname) return;
      this.loading = true;
      this.hasPreviewed = true;
      this.error = '';
      try {
        const activeTime = this.settingsStore.rulesV2.activity_profiles_v2[0]?.active_time;
        const { query, materialized } = resolveActivityEventsQuery({
          host: this.queryOptions.hostname,
          filter_afk: this.queryOptions.filter_afk,
          v2: {
            filter_afk: this.queryOptions.filter_afk,
            filter_categories: null,
            include_audible: activeTime?.type === 'legacy' ? activeTime.include_audible : false,
            explain_categories: true,
          },
          returnStatement: 'RETURN = limit_events(sort_by_duration(events), 100);',
        });
        const result = await getClient().query(
          [get_inclusive_local_date_range(this.queryOptions.start, this.queryOptions.stop)],
          query,
          { name: 'rulesPreview', verbose: true }
        );
        this.events = materialized
          ? remapNamespacedAppTitle(result[0] ?? [], materialized.appTitleSourceId)
          : result[0] ?? [];
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
      } finally {
        this.loading = false;
      }
    },
    candidates(event) {
      return event.data.$category_explain?.candidates ?? [];
    },
    matchedCandidates(event) {
      return this.candidates(event).filter(candidate => candidate.matched);
    },
    losingCandidates(event) {
      const winner = event.data.$category_explain?.winner;
      return this.matchedCandidates(event).filter(candidate => candidate.id !== winner);
    },
    previewEventFields(event) {
      return Object.entries(event.data ?? {}).filter(
        ([key, value]) =>
          !key.startsWith('$') &&
          (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
      );
    },
    previewEventTitle(event) {
      const fields = this.previewEventFields(event);
      const preferred =
        fields.find(([key]) => key === 'app') ??
        fields.find(([key]) => key === 'title') ??
        fields[0];
      return preferred ? String(preferred[1]) : this.$t('settings.categorization.previewNoFields');
    },
    previewEventSubtitle(event) {
      const fields = this.previewEventFields(event);
      const title = this.previewEventTitle(event);
      const secondary = fields.find(([, value]) => String(value) !== title);
      const duration = `${Math.round(event.duration)}s`;
      return secondary ? `${secondary[0]}: ${secondary[1]} · ${duration}` : duration;
    },
    previewSummary(event) {
      return this.$t('settings.categorization.previewSummary', {
        matched: this.matchedCandidates(event).length,
        lost: this.losingCandidates(event).length,
      });
    },
  },
};
</script>
