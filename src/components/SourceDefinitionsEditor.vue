<template lang="pug">
div
  b-alert(variant="warning" :show="!hasActivityCreator")
    | {{ $t('settings.categorization.noActivityCreatingSourceWarning') }}
  div.border.rounded.p-2.mb-2(v-for="(source, index) in value" :key="index")
    b-form-row
      b-col
        b-form-group(:label="$t('settings.categorization.sourceLabel')")
          b-form-input(
            size="sm"
            :value="source.label"
            @input="update(index, 'label', $event)"
          )
          small.text-muted(v-if="source.builtin === 'window'")
            | {{ $t('settings.categorization.builtinWindowSourceHelp') }}
      b-col
        b-form-group
          b-form-checkbox(
            switch
            :checked="!!source.creates_activity"
            :disabled="!supportsActivityCoverage"
            :title="supportsActivityCoverage ? '' : $t('settings.categorization.activityCoverageUnavailable')"
            @input="updateBoolean(index, 'creates_activity', $event)"
          )
            | {{ $t('settings.categorization.sourceCreatesActivityEnabled') }}
          small.text-muted.d-block {{ $t('settings.categorization.sourceCreatesActivityHelp') }}
          small.text-warning.d-block(v-if="!supportsActivityCoverage")
            | {{ $t('settings.categorization.activityCoverageUnavailable') }}
    small.text-muted.d-block.mb-2
      | {{ $t('settings.categorization.sourceInternalId') }}:
      code.ml-1 {{ source.id }}
    b-form-group(:label="$t('settings.categorization.sourceBucketIds')")
      b-form-input(
        size="sm"
        :value="source.bucket_ids.join(', ')"
        :state="sourceFieldState(index, 'bucket_ids')"
        @input="updateList(index, 'bucket_ids', $event)"
      )
      small.text-muted(v-if="source.builtin === 'window'")
        | {{ $t('settings.categorization.builtinWindowBucketsHelp') }}
      small.text-muted(v-else) {{ $t('settings.categorization.sourceBucketIdsHelp') }}
      b-form-invalid-feedback
        | {{ $t('settings.categorization.sourceBucketRequired') }}
      small.text-muted.d-block(
        v-for="bucket in availableSourceBuckets(source)"
        :key="bucket.id"
      )
        | {{ $t('settings.categorization.sourceBucketOwner', { bucket: bucket.id, host: bucket.hostname || $t('settings.categorization.sourceDeviceUnknown') }) }}
      small.text-muted.d-block(
        v-if="source.builtin === 'window' && source.bucket_ids.length === 0"
        v-for="bucket in discoveredWindowBuckets"
        :key="'discovered-' + bucket.id"
      )
        | {{ $t('settings.categorization.builtinWindowDiscoveredBucket', { bucket: bucket.id, host: bucket.hostname || $t('settings.categorization.sourceDeviceUnknown') }) }}
      small.text-warning.d-block(v-if="unavailableBucketIds(source).length")
        | {{ $t('settings.categorization.sourceBucketsUnavailable', { buckets: unavailableBucketIds(source).join(', ') }) }}
    b-form-group(:label="$t('settings.categorization.sourceScope')")
      b-form-select(
        size="sm"
        :value="source.scope || 'host'"
        :state="sourceFieldState(index, 'scope')"
        @input="updateScope(index, $event)"
      )
        option(value="host") {{ $t('settings.categorization.sourceScopeHost') }}
        option(value="global") {{ $t('settings.categorization.sourceScopeGlobal') }}
      small.text-muted(v-if="source.scope === 'global'")
        | {{ $t('settings.categorization.sourceScopeGlobalHelp') }}
      small.text-muted(v-else)
        | {{ $t('settings.categorization.sourceScopeHostHelp') }}
    b-form-group(:label="$t('settings.categorization.fields')")
      b-form-input(
        size="sm"
        :value="source.fields.join(', ')"
        :state="sourceFieldState(index, 'fields')"
        @input="updateList(index, 'fields', $event)"
      )
      small.text-muted(v-if="source.builtin === 'window'")
        | {{ $t('settings.categorization.builtinWindowFieldsHelp') }}
      small.text-muted(v-else)
        | {{ $t('settings.categorization.sourceFieldsHelp', { source: source.id }) }}
      b-form-invalid-feedback
        | {{ $t('settings.categorization.validationSourceFieldsRequired', { source: source.label || source.id }) }}
    b-btn(size="sm" variant="outline-danger" @click="remove(index)")
      | {{ $t('settings.categorization.removeSource') }}
  b-btn(size="sm" variant="outline-primary" @click="add")
    | {{ $t('settings.categorization.addSource') }}
</template>

<script lang="ts">
import type { SourceDefinitionV2 } from '~/util/rulesV2';
import { createDefaultRuleSource, resolveBucketOwnership } from '~/util/rulesEditor';
import { useBucketsStore } from '~/stores/buckets';
import { useServerStore } from '~/stores/server';

export default {
  name: 'SourceDefinitionsEditor',
  props: {
    value: { type: Array, required: true },
    errors: { type: Array, default: () => [] },
  },
  data() {
    return {
      bucketsStore: useBucketsStore(),
      serverStore: useServerStore(),
    };
  },
  computed: {
    supportsActivityCoverage() {
      return (
        this.serverStore.info?.capabilities?.includes(
          'query.merge_subwatcher_fields.source_namespace.v1'
        ) ?? false
      );
    },
    hasActivityCreator() {
      return (this.value as SourceDefinitionV2[]).some(source => source.creates_activity);
    },
    discoveredWindowBuckets() {
      return this.bucketsStore.buckets.filter(
        bucket => bucket.type === 'currentwindow' && !bucket.id.startsWith('aw-watcher-android')
      );
    },
  },
  methods: {
    emitValue(value: SourceDefinitionV2[]) {
      this.$emit('input', value);
    },
    update(index: number, field: string, fieldValue: unknown) {
      const sources = this.value.map((source, sourceIndex) =>
        sourceIndex === index ? this.updatedSource(source, field, fieldValue) : source
      );
      this.emitValue(sources);
    },
    updatedSource(source: SourceDefinitionV2, field: string, fieldValue: unknown) {
      const updated = { ...source, [field]: fieldValue };
      if (source.auto_generated) delete updated.auto_generated;
      if (field === 'bucket_ids') {
        const bucketIds = fieldValue as string[];
        if (updated.scope !== 'global') {
          updated.scope = 'host';
          updated.bucket_hosts = this.bucketHosts(bucketIds);
          delete updated.host;
        }
      }
      return updated;
    },
    updateBoolean(index: number, field: 'creates_activity', value: boolean) {
      const sources = this.value.map((source, sourceIndex) => {
        if (sourceIndex !== index) return source;
        const updated = { ...source };
        if (value) updated[field] = true;
        else delete updated[field];
        if (source.auto_generated) delete updated.auto_generated;
        return updated;
      });
      this.emitValue(sources);
    },
    bucketHosts(bucketIds: string[]) {
      return resolveBucketOwnership(bucketIds, this.bucketsStore.buckets).bucketHosts;
    },
    sourceFieldState(index: number, field: 'bucket_ids' | 'fields' | 'scope') {
      const prefix = `sources[${index}]`;
      const hasError = (this.errors as string[]).some(error => {
        if (!error.startsWith(prefix)) return false;
        if (field === 'bucket_ids') return error.includes('bucket_ids');
        if (field === 'fields') return error.includes('.fields');
        return (
          error.includes('scope') || error.includes('ownership') || error.includes('bucket_hosts')
        );
      });
      return hasError ? false : null;
    },
    availableSourceBuckets(source: SourceDefinitionV2) {
      const selected = new Set(source.bucket_ids);
      return this.bucketsStore.buckets.filter(bucket => selected.has(bucket.id));
    },
    unavailableBucketIds(source: SourceDefinitionV2) {
      if (this.bucketsStore.buckets.length === 0) return [];
      const available = new Set(this.bucketsStore.buckets.map(bucket => bucket.id));
      return source.bucket_ids.filter(bucketId => !available.has(bucketId));
    },
    updateScope(index: number, scope: 'host' | 'global') {
      const source = this.value[index] as SourceDefinitionV2;
      const updated: SourceDefinitionV2 = { ...source, scope };
      delete updated.auto_generated;
      delete updated.host;
      if (scope === 'global') {
        delete updated.bucket_hosts;
      } else {
        updated.bucket_hosts = this.bucketHosts(source.bucket_ids);
      }
      const sources = this.value.map((candidate, sourceIndex) =>
        sourceIndex === index ? updated : candidate
      );
      this.emitValue(sources);
    },
    updateList(index: number, field: 'bucket_ids' | 'fields', value: string) {
      this.update(
        index,
        field,
        value
          .split(',')
          .map(item => item.trim())
          .filter(Boolean)
      );
    },
    add() {
      this.emitValue([...this.value, createDefaultRuleSource(this.value.map(source => source.id))]);
    },
    remove(index: number) {
      this.emitValue(this.value.filter((_, sourceIndex) => sourceIndex !== index));
    },
  },
};
</script>
