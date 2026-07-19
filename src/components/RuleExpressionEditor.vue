<template lang="pug">
div.rule-expression-editor.border.rounded.p-3.mb-2(:class="{ 'rule-group': isGroup }")
  b-form-group.mb-2
    template(#label)
      | {{ $t('settings.categorization.ruleType') }}
    b-form-select(size="sm" :value="value.type" @input="changeType")
      option(v-if="allowNone" value="none") {{ $t('settings.categorization.ruleNone') }}
      option(value="regex") {{ $t('settings.categorization.ruleRegex') }}
      option(value="all") {{ $t('settings.categorization.ruleAll') }}
      option(value="any") {{ $t('settings.categorization.ruleAny') }}

  template(v-if="value.type === 'regex'")
    b-form-group.mb-2
      template(#label)
        | {{ $t('settings.categorization.source') }}
        span.ml-1.d-inline-block(
          tabindex="0"
          role="button"
          v-b-tooltip.hover.focus
          :title="$t('settings.categorization.sourceHelp')"
        )
          icon(name="info-circle")
      b-form-select(
        size="sm"
        :value="selectedSourceOption"
        :options="sourceOptions"
        :disabled="sourceLoading"
        @input="changeSource"
      )
      small.text-muted(v-if="!showAdvancedOptions")
        | {{ $t('settings.categorization.automaticSourceHelp') }}
      small.text-muted(v-else-if="isBaseAdvanced")
        | {{ $t('settings.categorization.mainActivityAdvancedHelp') }}
      small.text-muted(v-else-if="selectedSource")
        | {{ selectedSourceDetails }}
      div(v-if="allowActivityCreation && selectedSource")
        b-form-checkbox(
          switch
          :checked="!!selectedSource.creates_activity"
          :disabled="!activityCreationSupported"
          :title="activityCreationSupported ? '' : $t('settings.categorization.activityCoverageUnavailable')"
          @input="setSelectedSourceCreatesActivity"
        )
          | {{ $t('settings.categorization.sourceCreatesActivityEnabled') }}
        small.text-muted.d-block {{ $t('settings.categorization.sourceCreatesActivityHelp') }}
        small.text-warning.d-block(v-if="!activityCreationSupported")
          | {{ $t('settings.categorization.activityCoverageUnavailable') }}
      small.text-danger(v-if="sourceError") {{ sourceError }}
      small.text-warning(v-if="sourceWarning") {{ sourceWarning }}

    b-form-group.mb-3(:label="$t('settings.categorization.pattern')")
      b-form-input(
        size="sm"
        :value="value.regex || ''"
        :placeholder="$t('settings.categorization.patternPlaceholder')"
        :state="patternState"
        @input="update('regex', $event)"
      )
      b-form-invalid-feedback
        | {{ value.regex ? $t('settings.categorization.validationPatternInvalid') : $t('settings.categorization.validationPatternRequired') }}

    b-form-row(v-if="showAdvancedOptions")
      b-col(md="8")
        b-form-group.mb-2
          template(#label)
            | {{ $t('settings.categorization.fields') }}
            span.ml-1.d-inline-block(
              tabindex="0"
              role="button"
              v-b-tooltip.hover.focus
              :title="$t('settings.categorization.fieldsHelp')"
            )
              icon(name="info-circle")
          b-form-radio-group.field-mode-toggle.mb-2(
            size="sm"
            :checked="fieldSelectionMode"
            :options="fieldModeOptions"
            buttons
            button-variant="outline-secondary"
            @input="changeFieldMode"
          )
          template(v-if="fieldSelectionMode === 'specific'")
            div.field-checkboxes.border.rounded.p-2
              b-form-checkbox-group(
                :checked="selectedFields"
                :options="fieldOptions"
                @input="updateFields"
              )
            b-input-group.mt-2(size="sm")
              b-form-input(
                v-model.trim="customFieldDraft"
                :placeholder="$t('settings.categorization.customFieldPlaceholder')"
                @keyup.enter="addCustomField"
              )
              b-input-group-append
                b-btn(
                  variant="outline-secondary"
                  :disabled="!customFieldDraft"
                  @click="addCustomField"
                ) {{ $t('settings.categorization.addField') }}
            small.text-muted
              | {{ $t('settings.categorization.specificFieldsHelp') }}
      b-col(md="4")
        b-form-group.mb-2
          template(#label)
            | {{ $t('settings.categorization.host') }}
            span.ml-1.d-inline-block(
              tabindex="0"
              role="button"
              v-b-tooltip.hover.focus
              :title="$t('settings.categorization.hostHelp')"
            )
              icon(name="info-circle")
          b-form-input(
            size="sm"
            :value="value.host || ''"
            :placeholder="$t('settings.categorization.anyHost')"
            :list="hostListId"
            @input="updateOptional('host', $event)"
          )
          datalist(:id="hostListId")
            option(v-for="host in hostSuggestions" :key="host" :value="host")

    div.d-flex.flex-wrap.align-items-end.rule-options
      b-form-checkbox.mr-4.mb-2(
        :checked="!!value.ignore_case"
        @input="update('ignore_case', $event)"
        switch
      )
        | {{ $t('settings.categorization.caseInsensitive') }}
      b-form-checkbox.mr-4.mb-2(
        v-if="showAdvancedOptions"
        :checked="!!value.negate"
        @input="update('negate', $event)"
        switch
      )
        | {{ $t('settings.categorization.excludeMatches') }}
      b-form-group.match-weight.mb-2(v-if="showAdvancedOptions")
        template(#label)
          | {{ $t('settings.categorization.priorityWeight') }}
          span.ml-1.d-inline-block(
            tabindex="0"
            role="button"
            v-b-tooltip.hover.focus
            :title="$t('settings.categorization.priorityWeightHelp')"
          )
            icon(name="info-circle")
        b-form-input(
          size="sm"
          type="number"
          step="1"
          :value="value.weight || 0"
          :state="weightState"
          @input="updateWeight"
        )
        b-form-invalid-feedback
          | {{ $t('settings.categorization.validationWholeNumber') }}

  b-alert.py-2.mb-0(v-else-if="value.type === 'none'" variant="warning" show)
    | {{ $t('settings.categorization.emptyConditionWarning') }}

  template(v-else-if="isGroup")
    p.small.text-muted.mb-2
      | {{ value.type === 'all' ? $t('settings.categorization.allGroupHelp') : $t('settings.categorization.anyGroupHelp') }}
    p.small.text-muted.mb-2(
      tabindex="0"
      v-b-tooltip.hover.focus
      :title="$t('settings.categorization.groupScoreHelp')"
    )
      | {{ $t('settings.categorization.maximumScore') }}: {{ maximumScore }}
    div.child-rule(v-for="(child, index) in value.rules" :key="index")
      RuleExpressionEditor(
        :value="child"
        :allow-none="allowNone"
        :source-definitions="allSources"
        :allow-bucket-sources="allowBucketSources"
        :require-source="requireSource"
        :allow-activity-creation="allowActivityCreation"
        :activity-creation-supported="activityCreationSupported"
        @input="updateChild(index, $event)"
        @sources-input="$emit('sources-input', $event)"
      )
      b-btn.remove-child(
        size="sm"
        variant="link"
        :disabled="value.rules.length <= 1"
        v-b-tooltip.hover
        :title="$t('settings.categorization.removeRule')"
        @click="removeChild(index)"
      )
        icon(name="times")
    b-btn(size="sm" variant="outline-primary" @click="addChild")
      icon.mr-1(name="plus")
      | {{ $t('settings.categorization.addRule') }}
</template>

<script lang="ts">
import _ from 'lodash';
import { useBucketsStore } from '~/stores/buckets';
import { useSettingsStore } from '~/stores/settings';
import type { IBucket, IEvent } from '~/util/interfaces';
import type { RuleExpressionV2, SourceDefinitionV2 } from '~/util/rulesV2';
import { validateRegex } from '~/util/validate';
import {
  convertRuleExpressionType,
  resetRegexToAutomatic,
  resolveBucketOwnership,
} from '~/util/rulesEditor';

import 'vue-awesome/icons/info-circle';
import 'vue-awesome/icons/plus';
import 'vue-awesome/icons/times';

const DEFAULT_FIELDS = ['app', 'title'];
const BASE_ADVANCED_VALUE = 'base-advanced';
const BUCKET_VALUE_PREFIX = 'bucket:';
const BUCKET_GROUP_VALUE_PREFIX = 'bucket-group:';

interface BucketGroup {
  key: string;
  label: string;
  buckets: IBucket[];
}

interface SourceSelectOption {
  value: string;
  text: string;
}

interface SourceSelectGroup {
  label: string;
  options: SourceSelectOption[];
}

function bucketLabel(bucket: IBucket, translate: (key: string) => string): string {
  const labels: Record<string, string> = {
    currentwindow: 'settings.categorization.bucketLabelWindow',
    afkstatus: 'settings.categorization.bucketLabelAfk',
    'web.tab.current': 'settings.categorization.bucketLabelBrowser',
    'general.stopwatch': 'settings.categorization.bucketLabelStopwatch',
    'vdesktop-name': 'settings.categorization.bucketLabelVirtualDesktop',
  };
  return labels[bucket.type] ? translate(labels[bucket.type]) : bucket.type ?? bucket.id;
}

function fallbackFields(bucket: IBucket): string[] {
  const fields: Record<string, string[]> = {
    currentwindow: ['app', 'title'],
    afkstatus: ['status'],
    'web.tab.current': ['title', 'url', 'audible', 'incognito', 'tabCount'],
    'general.stopwatch': ['label'],
    'vdesktop-name': ['title', 'vdesktop'],
  };
  return fields[bucket.type] ?? DEFAULT_FIELDS;
}

function stableSourceId(bucketIds: string[]): string {
  const input = [...bucketIds].sort().join('|');
  let hash = 5381;
  for (const char of input) hash = (hash * 33) ^ char.charCodeAt(0);
  return `bucket_${(hash >>> 0).toString(36)}`;
}

function maximumScore(expression: RuleExpressionV2): number {
  if (expression.type === 'regex') return expression.weight ?? 0;
  if (expression.type === 'all') {
    return expression.rules.reduce((total, child) => total + maximumScore(child), 0);
  }
  if (expression.type === 'any') {
    const scores = expression.rules.map(maximumScore);
    return scores.length ? Math.max(...scores) : 0;
  }
  return 0;
}

export default {
  name: 'RuleExpressionEditor',
  props: {
    value: { type: Object, required: true },
    allowNone: { type: Boolean, default: true },
    sourceDefinitions: { type: Array, default: null },
    allowBucketSources: { type: Boolean, default: false },
    requireSource: { type: Boolean, default: false },
    allowActivityCreation: { type: Boolean, default: false },
    activityCreationSupported: { type: Boolean, default: true },
  },
  data() {
    return {
      settingsStore: useSettingsStore(),
      bucketsStore: useBucketsStore(),
      sourceLoading: false,
      sourceError: '',
      sourceWarning: '',
      forceBaseAdvanced: false,
      customFieldDraft: '',
    };
  },
  computed: {
    patternState(): boolean | null {
      if (this.value.type !== 'regex') return null;
      return validateRegex(this.value.regex || '') ? null : false;
    },
    weightState(): boolean | null {
      if (this.value.type !== 'regex' || this.value.weight === undefined) return null;
      return Number.isInteger(this.value.weight) ? null : false;
    },
    isGroup(): boolean {
      return this.value.type === 'all' || this.value.type === 'any';
    },
    allSources(): SourceDefinitionV2[] {
      return (
        this.sourceDefinitions ?? this.settingsStore.rulesV2.activity_profiles_v2[0]?.sources ?? []
      );
    },
    effectiveSources(): SourceDefinitionV2[] {
      return this.allSources;
    },
    bucketGroups(): BucketGroup[] {
      const groups = _.groupBy(
        this.bucketsStore.buckets.filter(bucket => bucket.type !== 'currentwindow'),
        bucket => `${bucket.client || 'unknown'}|${bucket.type || 'unknown'}`
      );
      return Object.entries(groups)
        .map(([key, buckets]) => ({
          key,
          label: bucketLabel(buckets[0], key => String(this.$t(key))),
          buckets: _.sortBy(buckets, bucket => bucket.hostname || ''),
        }))
        .sort((left, right) => left.label.localeCompare(right.label));
    },
    watcherSourceOptions(): SourceSelectOption[] {
      return this.bucketGroups.map(group => {
        const hosts = _.uniq(
          group.buckets
            .map(bucket => bucket.hostname)
            .filter((host): host is string => !!host && host !== 'unknown')
        );
        const availability = hosts.length
          ? this.$t('settings.categorization.sourceAvailableOn', { hosts: hosts.join(', ') })
          : this.$t('settings.categorization.sourceDeviceUnknown');
        return {
          value: `${BUCKET_GROUP_VALUE_PREFIX}${group.key}`,
          text: `${group.label} — ${availability}`,
        };
      });
    },
    autoSourceOptionValues(): Record<string, string> {
      const values: Record<string, string> = {};
      if (!this.allowBucketSources) return values;
      for (const source of this.effectiveSources.filter(candidate => candidate.auto_generated)) {
        const sourceBucketIds = [...source.bucket_ids].sort();
        const group = this.bucketGroups.find(candidate =>
          _.isEqual(candidate.buckets.map(bucket => bucket.id).sort(), sourceBucketIds)
        );
        if (group) values[source.id] = `${BUCKET_GROUP_VALUE_PREFIX}${group.key}`;
      }
      return values;
    },
    sourceOptions(): Array<SourceSelectOption | SourceSelectGroup> {
      const options: Array<SourceSelectOption | SourceSelectGroup> = this.requireSource
        ? []
        : [
            {
              value: '',
              text: String(this.$t('settings.categorization.currentActivitySource')),
            },
            {
              value: BASE_ADVANCED_VALUE,
              text: String(this.$t('settings.categorization.mainActivityAdvanced')),
            },
          ];
      const customSources = this.effectiveSources.filter(
        source => !source.auto_generated && !source.builtin
      );
      if (customSources.length) {
        options.push({
          label: String(this.$t('settings.categorization.savedSources')),
          options: customSources.map(source => ({
            value: source.id,
            text: source.label,
          })),
        });
      }
      const savedWatcherSources = this.effectiveSources.filter(
        source => source.auto_generated && !this.autoSourceOptionValues[source.id]
      );
      if (savedWatcherSources.length) {
        options.push({
          label: String(this.$t('settings.categorization.savedWatcherSelections')),
          options: savedWatcherSources.map(source => ({
            value: source.id,
            text: source.label,
          })),
        });
      }
      if (this.allowBucketSources && this.watcherSourceOptions.length) {
        options.push({
          label: String(this.$t('settings.categorization.availableWatcherData')),
          options: this.watcherSourceOptions,
        });
      }
      return options;
    },
    selectedSourceOption(): string {
      if (this.value.source) {
        return this.autoSourceOptionValues[this.value.source] ?? this.value.source;
      }
      return this.showAdvancedOptions ? BASE_ADVANCED_VALUE : '';
    },
    isBaseAdvanced(): boolean {
      return this.selectedSourceOption === BASE_ADVANCED_VALUE;
    },
    isAutomatic(): boolean {
      return (
        !this.value.source &&
        !this.value.field &&
        (!this.value.fields || this.value.fields.length === 0) &&
        !this.value.host &&
        !this.value.negate &&
        (this.value.weight === undefined || this.value.weight === 0) &&
        (this.value.value_mode === undefined || this.value.value_mode === 'string')
      );
    },
    showAdvancedOptions(): boolean {
      return this.forceBaseAdvanced || !this.isAutomatic;
    },
    selectedSource(): SourceDefinitionV2 | undefined {
      return this.effectiveSources.find(source => source.id === this.value.source);
    },
    selectedSourceDetails(): string {
      if (!this.selectedSource) return '';
      const configuredHosts = _.uniq(
        Object.values(this.selectedSource.bucket_hosts ?? {}).filter(
          host => !!host && host !== 'unknown'
        )
      );
      const availability = configuredHosts.length
        ? this.$t('settings.categorization.sourceAvailableOn', {
            hosts: configuredHosts.join(', '),
          })
        : this.$t('settings.categorization.sourceDeviceUnknown');
      const ruleHost = this.value.host || this.$t('settings.categorization.anyHost');
      return String(
        this.$t('settings.categorization.sourceWatcherDetails', {
          availability,
          host: ruleHost,
        })
      );
    },
    selectedFields(): string[] {
      if (Array.isArray(this.value.fields)) return [...this.value.fields];
      return this.value.field ? [this.value.field] : [];
    },
    fieldSelectionMode(): 'all' | 'specific' {
      return this.selectedFields.length ? 'specific' : 'all';
    },
    fieldModeOptions(): Array<{ value: string; text: string }> {
      return [
        {
          value: 'all',
          text: String(this.$t('settings.categorization.allFields')),
        },
        {
          value: 'specific',
          text: String(this.$t('settings.categorization.specificFields')),
        },
      ];
    },
    fieldSuggestions(): string[] {
      return _.uniq([
        ...(this.selectedSource?.fields ?? DEFAULT_FIELDS),
        ...this.selectedFields,
      ]).sort();
    },
    fieldOptions(): Array<{ value: string; text: string; disabled?: boolean }> {
      return this.fieldSuggestions.map(field => ({
        value: field,
        text:
          this.selectedSource?.field_types?.[field] === 'scalar'
            ? `${field} (${this.$t('settings.categorization.scalarField')})`
            : field,
        disabled: this.selectedFields.length === 1 && this.selectedFields[0] === field,
      }));
    },
    hostSuggestions(): string[] {
      const selectedBucketHosts =
        this.selectedSource?.bucket_ids
          .map(
            bucketId => this.bucketsStore.buckets.find(bucket => bucket.id === bucketId)?.hostname
          )
          .filter(Boolean) ?? [];
      const hosts = [...this.bucketsStore.hosts, ...selectedBucketHosts];
      return _.uniq(hosts.filter((host): host is string => !!host)).sort();
    },
    hostListId(): string {
      return `rule-hosts-${this._uid}`;
    },
    maximumScore(): number {
      return maximumScore(this.value);
    },
  },
  methods: {
    emitValue(value: RuleExpressionV2) {
      this.$emit('input', value);
    },
    changeType(type: RuleExpressionV2['type']) {
      if (type === this.value.type) return;
      if (type === 'regex') {
        if (
          (this.value.type === 'all' || this.value.type === 'any') &&
          this.value.rules.length > 1 &&
          !confirm(String(this.$t('settings.categorization.replaceGroupConfirm')))
        ) {
          return;
        }
      } else if (type === 'none') {
        if (
          (this.value.type === 'all' || this.value.type === 'any') &&
          this.value.rules.length > 1 &&
          !confirm(String(this.$t('settings.categorization.replaceGroupConfirm')))
        ) {
          return;
        }
      }
      this.emitValue(convertRuleExpressionType(this.value, type));
    },
    update(field: string, value: unknown) {
      this.emitValue({ ...this.value, [field]: value } as RuleExpressionV2);
    },
    updateOptional(field: string, value: string) {
      const expression = { ...this.value };
      if (value) expression[field] = value;
      else delete expression[field];
      this.emitValue(expression as RuleExpressionV2);
    },
    async changeSource(source: string) {
      this.sourceError = '';
      this.sourceWarning = '';
      if (!source) {
        if (
          !this.isAutomatic &&
          !confirm(String(this.$t('settings.categorization.resetConditionConfirm')))
        ) {
          return;
        }
        this.forceBaseAdvanced = false;
        this.emitValue(resetRegexToAutomatic(this.value));
        return;
      }
      const expression = { ...this.value };
      if (source === BASE_ADVANCED_VALUE) {
        this.forceBaseAdvanced = true;
        delete expression.source;
        const fields = Array.isArray(expression.fields)
          ? expression.fields
          : expression.field
          ? [expression.field]
          : [];
        const compatibleFields = fields.filter(field => DEFAULT_FIELDS.includes(field));
        delete expression.field;
        if (fields.length) {
          expression.fields = compatibleFields.length ? compatibleFields : [...DEFAULT_FIELDS];
        }
        delete expression.value_mode;
        this.emitValue(expression as RuleExpressionV2);
        return;
      }
      this.forceBaseAdvanced = false;

      let selectedSource = this.effectiveSources.find(candidate => candidate.id === source);
      if (
        !selectedSource &&
        (source.startsWith(BUCKET_VALUE_PREFIX) || source.startsWith(BUCKET_GROUP_VALUE_PREFIX))
      ) {
        this.sourceLoading = true;
        try {
          const buckets = source.startsWith(BUCKET_VALUE_PREFIX)
            ? [
                this.bucketsStore.buckets.find(
                  bucket => bucket.id === source.slice(BUCKET_VALUE_PREFIX.length)
                ),
              ].filter((bucket): bucket is IBucket => !!bucket)
            : this.bucketGroups.find(
                group => group.key === source.slice(BUCKET_GROUP_VALUE_PREFIX.length)
              )?.buckets ?? [];
          if (!buckets.length) {
            throw new Error(String(this.$t('settings.categorization.sourceBucketUnavailable')));
          }
          selectedSource = await this.createBucketSource(buckets);
        } catch (error) {
          this.sourceError = error instanceof Error ? error.message : String(error);
          return;
        } finally {
          this.sourceLoading = false;
        }
      }
      if (!selectedSource) return;

      expression.source = selectedSource.id;
      const fields = Array.isArray(expression.fields)
        ? expression.fields
        : expression.field
        ? [expression.field]
        : [];
      const compatibleFields = selectedSource
        ? fields.filter(field => selectedSource.fields.includes(field))
        : fields;
      const selectedFields =
        fields.length && compatibleFields.length === 0
          ? selectedSource.fields.filter(field => selectedSource.field_types?.[field] !== 'scalar')
          : compatibleFields;
      if (fields.length && selectedFields.length === 0) {
        selectedFields.push(...selectedSource.fields.slice(0, 1));
      }
      delete expression.field;
      if (selectedFields.length) expression.fields = selectedFields;
      else delete expression.fields;
      if (selectedFields.some(field => selectedSource.field_types?.[field] === 'scalar')) {
        expression.value_mode = 'scalar';
      } else {
        delete expression.value_mode;
      }
      this.emitValue(expression as RuleExpressionV2);
    },
    updateFields(fields: string[]) {
      const expression = { ...this.value };
      delete expression.field;
      if (fields.length) expression.fields = fields;
      else delete expression.fields;
      if (fields.some(field => this.selectedSource?.field_types?.[field] === 'scalar')) {
        expression.value_mode = 'scalar';
      } else {
        delete expression.value_mode;
      }
      this.emitValue(expression as RuleExpressionV2);
    },
    changeFieldMode(mode: 'all' | 'specific') {
      if (mode === 'all') {
        this.updateFields([]);
        return;
      }
      const textFields = this.fieldSuggestions.filter(
        field => this.selectedSource?.field_types?.[field] !== 'scalar'
      );
      this.updateFields(textFields.length ? textFields : this.fieldSuggestions.slice(0, 1));
    },
    addCustomField() {
      const field = this.customFieldDraft.trim();
      if (!field) return;
      this.updateFields(_.uniq([...this.selectedFields, field]));
      this.customFieldDraft = '';
    },
    async createBucketSource(buckets: IBucket[]): Promise<SourceDefinitionV2> {
      const bucketIds = buckets.map(bucket => bucket.id);
      const matchingSources = this.effectiveSources.filter(source =>
        _.isEqual([...source.bucket_ids].sort(), [...bucketIds].sort())
      );
      const existing = matchingSources.find(source => source.auto_generated) ?? matchingSources[0];
      if (existing) return existing;

      const failedBuckets: string[] = [];
      const eventsByBucket = await Promise.all(
        buckets.map(async bucket => {
          try {
            const bucketWithEvents = await this.bucketsStore.getBucketWithEvents({
              id: bucket.id,
              limit: 50,
            });
            return (bucketWithEvents.events ?? []) as IEvent[];
          } catch {
            failedBuckets.push(bucket.hostname || bucket.id);
            return [];
          }
        })
      );
      if (failedBuckets.length) {
        this.sourceWarning = String(
          this.$t('settings.categorization.sourceInferenceWarning', {
            buckets: failedBuckets.join(', '),
          })
        );
      }
      const fieldTypes: Record<string, 'string' | 'scalar'> = {};
      for (const events of eventsByBucket) {
        for (const event of events) {
          for (const [field, value] of Object.entries(event.data ?? {})) {
            if (field.startsWith('$') || value === null || value === undefined) continue;
            const type = typeof value;
            if (type === 'string') fieldTypes[field] ??= 'string';
            else if (type === 'number' || type === 'boolean') fieldTypes[field] = 'scalar';
          }
        }
      }
      const fields = Object.keys(fieldTypes).length
        ? Object.keys(fieldTypes).sort()
        : _.uniq(buckets.flatMap(fallbackFields)).sort();
      const ownership = resolveBucketOwnership(bucketIds, buckets);
      if (ownership.unresolved.length > 0) {
        this.sourceWarning = String(this.$t('settings.categorization.sourceBucketsNeedHosts'));
        throw new Error(this.sourceWarning);
      }
      const label = bucketLabel(buckets[0], key => String(this.$t(key)));
      const baseId = stableSourceId(bucketIds);
      let sourceId = baseId;
      let suffix = 2;
      while (this.allSources.some(source => source.id === sourceId)) {
        sourceId = `${baseId}-${suffix++}`;
      }
      const created: SourceDefinitionV2 = {
        id: sourceId,
        label,
        bucket_ids: bucketIds,
        scope: 'host',
        bucket_hosts: ownership.bucketHosts,
        fields,
        ...(Object.keys(fieldTypes).length ? { field_types: fieldTypes } : {}),
        auto_generated: true,
      };
      this.$emit('sources-input', [...this.allSources, created]);
      return created;
    },
    setSelectedSourceCreatesActivity(createsActivity: boolean) {
      if (!this.selectedSource) return;
      const updated = this.allSources.map(source =>
        source.id === this.selectedSource?.id
          ? {
              ...source,
              ...(createsActivity ? { creates_activity: true } : {}),
              auto_generated: false,
            }
          : source
      );
      if (!createsActivity) {
        const selected = updated.find(source => source.id === this.selectedSource?.id);
        if (selected) delete selected.creates_activity;
      }
      this.$emit('sources-input', updated);
    },
    updateWeight(value: string | number) {
      const parsed = Number(value);
      this.update('weight', Number.isFinite(parsed) ? Math.trunc(parsed) : 0);
    },
    updateChild(index: number, child: RuleExpressionV2) {
      const rules = [...this.value.rules];
      rules.splice(index, 1, child);
      this.emitValue({ ...this.value, rules });
    },
    addChild() {
      this.emitValue({
        ...this.value,
        rules: [...this.value.rules, { type: 'none' }],
      });
    },
    removeChild(index: number) {
      if (this.value.rules.length <= 1) return;
      const rules = this.value.rules.filter((child, childIndex) => child && childIndex !== index);
      this.emitValue({ ...this.value, rules });
    },
  },
};
</script>

<style scoped>
.rule-expression-editor.rule-group {
  border-left: 3px solid var(--primary) !important;
  background: rgba(0, 123, 255, 0.025);
}

.rule-options {
  gap: 0.25rem;
}

.field-mode-toggle {
  display: flex;
}

.field-mode-toggle ::v-deep .btn {
  flex: 1 1 0;
}

.field-checkboxes ::v-deep .custom-control-inline {
  margin-bottom: 0.25rem;
}

.match-weight {
  width: 11rem;
  margin-left: auto;
}

.child-rule {
  position: relative;
  padding-right: 1.75rem;
}

.remove-child {
  position: absolute;
  top: 0.1rem;
  right: 0;
  color: var(--danger);
  padding: 0.2rem;
}
</style>
