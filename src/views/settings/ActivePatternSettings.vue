<template lang="pug">
div
  div.d-sm-flex.justify-content-between(v-if="editorMode === 'simple'")
    div
      h5.mb-2.mb-sm-0 {{ $t('settings.activePattern.title') }}

      small.text-muted
        | {{ $t('settings.activePattern.help1') }}
        |
        | {{ $t('settings.activePattern.help2') }}
        |
        span.text-nowrap
          | {{ $t('settings.activePattern.example') }}&nbsp;
          code(style="background-color: rgba(200, 200, 200, 0.3); padding: 2px 4px; border-radius: 2px;")
            | Zoom Meeting|Google Meet|Microsoft Teams
    div
      b-form-input(
        size="sm"
        v-model="always_active_pattern_editing"
        :state="(enabled || null) && valid"
        :disabled="advancedActive"
      )
      b-btn.mt-1.float-right(
        v-if="!advancedActive"
        size="sm"
        variant="primary"
        :disabled="!simpleDraftDirty || !valid"
        @click="saveSimple"
      ) {{ $t('app.apply') }}
      small.text-right.clearfix(v-if="!advancedActive")
        div.text-success(v-if="enabled && valid") {{ $t('settings.activePattern.enabled') }}
        div.text-danger(v-else-if="enabled") {{ $t('settings.activePattern.invalid') }}
        div.text-muted(v-else) {{ $t('settings.activePattern.disabled') }}
        div.text-danger(v-if="enabled && valid && broad_pattern")
          | {{ $t('settings.activePattern.tooBroad') }}
      small.text-muted(v-if="editorMode === 'simple' && advancedActive")
        | {{ $t('settings.categorization.simpleActiveTimeLocked') }}

  div(v-else)
    h5.mb-1 {{ $t('settings.categorization.activeTimeTitle') }}
    p.small.text-muted {{ $t('settings.categorization.activeTimeHelp') }}
    b-form-radio-group.mb-3(
      v-model="activeModeDraft"
      :options="activeModeOptions"
      buttons
      button-variant="outline-primary"
      size="sm"
    )

    div.border.rounded.p-3(v-if="activeModeDraft === 'automatic'")
      h6 {{ $t('settings.categorization.activeTimeAutomatic') }}
      p.small.text-muted.mb-3
        | {{ $t('settings.categorization.activeTimeAutomaticHelp') }}
      b-form-group.mb-2(:label="$t('settings.activePattern.title')")
        b-form-input(
          size="sm"
          v-model="always_active_pattern_editing"
          :state="(enabled || null) && valid"
          :disabled="advancedActive"
        )
        b-form-invalid-feedback
          | {{ $t('settings.activePattern.invalid') }}
        small.text-muted {{ $t('settings.activePattern.help2') }}
      b-btn.mb-2(
        v-if="!advancedActive"
        size="sm"
        variant="primary"
        :disabled="!simpleDraftDirty || !valid"
        @click="saveSimple"
      ) {{ $t('app.apply') }}
      b-alert.mb-2(variant="warning" :show="advancedActive")
        | {{ $t('settings.categorization.activeTimeAutomaticPending') }}
      b-btn(
        v-if="advancedActive"
        size="sm"
        variant="primary"
        @click="useSimple"
      ) {{ $t('settings.categorization.useAutomaticActiveTime') }}

    div.border.rounded.p-3(v-else)
      h6 {{ $t('settings.categorization.activeTimeCustom') }}
      p.small.text-muted {{ $t('settings.categorization.activeTimeCustomHelp') }}
      b-alert(variant="warning" :show="!supportsActiveTimeSources")
        | {{ $t('settings.categorization.advancedBackendRequired') }}
      b-alert(variant="info" :show="!advancedActive")
        | {{ $t('settings.categorization.activeTimeCustomPending') }}
      b-alert(variant="warning" :show="advancedDraftDirty")
        | {{ $t('settings.categorization.unsavedChanges') }}
      RulesValidationAlert(
        v-if="advancedValidationAttempted"
        :errors="advancedErrors"
        :sources="advancedSources"
      )
      RuleExpressionEditor(
        v-model="advancedRule"
        :source-definitions="advancedSources"
        :allow-bucket-sources="supportsActiveTimeSources"
        :require-source="true"
        @sources-input="advancedSources = $event"
      )
      div.mt-2
        b-btn(
          size="sm"
          variant="primary"
          :disabled="!supportsActiveTimeSources"
          @click="saveAdvanced"
        )
          | {{ $t('settings.categorization.saveCustomActiveTime') }}

  b-alert.mt-2(variant="danger" :show="!!advancedSaveError") {{ advancedSaveError }}

</template>

<script lang="ts">
import { isRegexBroad, validateRegex } from '~/util/validate';
import { useSettingsStore } from '~/stores/settings';
import { useCategoryStore } from '~/stores/categories';
import { useServerStore } from '~/stores/server';
import { draftMatchesSubmission, shouldSyncCanonicalDraft } from '~/util/rulesEditor';
import RuleExpressionEditor from '~/components/RuleExpressionEditor.vue';
import RulesValidationAlert from '~/components/RulesValidationAlert.vue';
import {
  validateProfileRulesV2,
  type RuleExpressionV2,
  type SourceDefinitionV2,
} from '~/util/rulesV2';

export default {
  name: 'ActivePatternSettings',
  components: { RuleExpressionEditor, RulesValidationAlert },
  data() {
    return {
      settingsStore: useSettingsStore(),
      categoryStore: useCategoryStore(),
      serverStore: useServerStore(),
      always_active_pattern_editing: '',
      activeModeDraft: 'automatic' as 'automatic' | 'custom',
      advancedRule: { type: 'none' } as RuleExpressionV2,
      advancedSources: [] as SourceDefinitionV2[],
      advancedSaveError: '',
      loadedActiveTimeJson: '',
      loadedSimplePattern: '',
      loadedAdvancedRuleJson: '',
      loadedAdvancedSourcesJson: '',
      advancedValidationAttempted: false,
      activeSaveInFlight: 0,
    };
  },
  computed: {
    enabled: function () {
      return this.always_active_pattern_editing != '';
    },
    valid: function () {
      return validateRegex(this.always_active_pattern_editing);
    },
    broad_pattern: function () {
      // Check if the pattern matches random strings that we don't expect it to
      // like the alphabet
      const pattern = this.always_active_pattern_editing;
      if (pattern == '') {
        return false;
      }
      return isRegexBroad(pattern);
    },
    editorMode: function () {
      return this.settingsStore.rulesEditorMode;
    },
    activeModeOptions: function () {
      return [
        {
          value: 'automatic',
          text: this.$t('settings.categorization.activeTimeAutomaticRecommended'),
        },
        {
          value: 'custom',
          text: this.$t('settings.categorization.activeTimeCustom'),
          disabled: !this.supportsActiveTimeSources,
        },
      ];
    },
    advancedActive: function () {
      return this.settingsStore.rulesV2.activity_profiles_v2[0]?.active_time.type === 'expression';
    },
    supportsActiveTimeSources: function () {
      return this.serverStore.info?.capabilities?.includes('query.active_periods_v2.v1') ?? false;
    },
    canonicalActiveTimeJson: function () {
      return JSON.stringify(
        this.settingsStore.rulesV2.activity_profiles_v2[0]?.active_time ?? null
      );
    },
    canonicalSourcesJson: function () {
      return JSON.stringify(this.settingsStore.rulesV2.activity_profiles_v2[0]?.sources ?? []);
    },
    simpleDraftDirty: function () {
      return this.always_active_pattern_editing !== this.loadedSimplePattern;
    },
    advancedSourcesDirty: function () {
      return JSON.stringify(this.advancedSources) !== this.loadedAdvancedSourcesJson;
    },
    advancedDraftDirty: function () {
      return (
        JSON.stringify(this.advancedRule) !== this.loadedAdvancedRuleJson ||
        this.advancedSourcesDirty
      );
    },
    activeDraftDirty: function () {
      return this.simpleDraftDirty || this.advancedDraftDirty;
    },
    advancedErrors: function () {
      const profile = this.settingsStore.rulesV2.activity_profiles_v2[0];
      if (!profile) {
        return [String(this.$t('settings.categorization.profileUnavailable'))];
      }
      return validateProfileRulesV2(
        {
          ...profile,
          sources: this.advancedSources,
          active_time: { type: 'expression', rule: this.advancedRule },
        },
        this.settingsStore.rulesV2.category_sets_v2
      );
    },
    always_active_pattern: function () {
      return this.settingsStore.always_active_pattern;
    },
  },
  watch: {
    canonicalActiveTimeJson: function (value) {
      if (
        shouldSyncCanonicalDraft(
          this.activeSaveInFlight > 0,
          value !== this.loadedActiveTimeJson,
          this.activeDraftDirty
        )
      ) {
        this.syncActiveTimeDraft();
      }
    },
    canonicalSourcesJson: function (value) {
      if (
        shouldSyncCanonicalDraft(
          this.activeSaveInFlight > 0,
          value !== this.loadedAdvancedSourcesJson,
          this.advancedSourcesDirty
        )
      ) {
        this.syncSourcesDraft();
      }
    },
    activeDraftDirty: function (value) {
      this.categoryStore.setRulesV2DraftDirty('active-time', value);
    },
    activeModeDraft: function (value) {
      if (value === 'automatic' && !this.advancedActive && this.advancedDraftDirty) {
        if (
          !confirm(String(this.$t('settings.categorization.discardCustomActiveTimeDraftConfirm')))
        ) {
          this.activeModeDraft = 'custom';
          return;
        }
        this.advancedRule = JSON.parse(this.loadedAdvancedRuleJson);
        this.advancedSources = JSON.parse(this.loadedAdvancedSourcesJson);
        this.advancedValidationAttempted = false;
      }
    },
  },
  mounted() {
    this.syncActiveTimeDraft();
  },
  beforeDestroy() {
    this.categoryStore.setRulesV2DraftDirty('active-time', false);
  },
  methods: {
    syncSourcesDraft() {
      const sources = this.settingsStore.rulesV2.activity_profiles_v2[0]?.sources ?? [];
      this.advancedSources = JSON.parse(JSON.stringify(sources));
      this.loadedAdvancedSourcesJson = JSON.stringify(this.advancedSources);
    },
    syncActiveTimeDraft() {
      const profile = this.settingsStore.rulesV2.activity_profiles_v2[0];
      const activeTime = profile?.active_time;
      this.loadedActiveTimeJson = JSON.stringify(activeTime ?? null);
      this.advancedSources = JSON.parse(JSON.stringify(profile?.sources ?? []));
      this.always_active_pattern_editing =
        activeTime?.type === 'legacy'
          ? activeTime.always_active_pattern
          : this.settingsStore.always_active_pattern;
      this.loadedSimplePattern = this.always_active_pattern_editing;
      if (activeTime?.type === 'expression') {
        this.activeModeDraft = 'custom';
        this.advancedRule = JSON.parse(JSON.stringify(activeTime.rule));
      } else {
        this.activeModeDraft = 'automatic';
        this.advancedRule = { type: 'none' };
      }
      this.loadedAdvancedRuleJson = JSON.stringify(this.advancedRule);
      this.loadedAdvancedSourcesJson = JSON.stringify(this.advancedSources);
      this.advancedValidationAttempted = false;
    },
    async saveSimple() {
      if (!this.simpleDraftDirty || !this.valid) return;
      this.advancedSaveError = '';
      const draft = this.always_active_pattern_editing;
      this.activeSaveInFlight++;
      try {
        await this.settingsStore.saveLegacyActiveTimeV2(draft);
        this.loadedSimplePattern = draft;
        this.loadedActiveTimeJson = this.canonicalActiveTimeJson;
      } catch (error) {
        this.advancedSaveError = error instanceof Error ? error.message : String(error);
      } finally {
        this.activeSaveInFlight--;
      }
    },
    async saveAdvanced() {
      this.advancedSaveError = '';
      this.advancedValidationAttempted = true;
      if (this.advancedErrors.length > 0) return;
      const submittedRuleJson = JSON.stringify(this.advancedRule);
      const submittedSourcesJson = JSON.stringify(this.advancedSources);
      const baselineSources = JSON.parse(this.loadedAdvancedSourcesJson);
      this.activeSaveInFlight++;
      try {
        await this.settingsStore.saveActiveTimeRuleV2(
          JSON.parse(submittedRuleJson),
          JSON.parse(submittedSourcesJson),
          baselineSources
        );
        if (
          draftMatchesSubmission(this.advancedRule, submittedRuleJson) &&
          draftMatchesSubmission(this.advancedSources, submittedSourcesJson)
        ) {
          this.activeModeDraft = 'custom';
          this.syncActiveTimeDraft();
        } else {
          this.loadedActiveTimeJson = this.canonicalActiveTimeJson;
          this.loadedAdvancedRuleJson = submittedRuleJson;
          this.loadedAdvancedSourcesJson = submittedSourcesJson;
        }
      } catch (error) {
        this.advancedSaveError = error instanceof Error ? error.message : String(error);
      } finally {
        this.activeSaveInFlight--;
      }
    },
    async useSimple() {
      this.advancedSaveError = '';
      if (
        this.advancedActive &&
        !confirm(String(this.$t('settings.categorization.useAutomaticActiveTimeConfirm')))
      ) {
        this.activeModeDraft = 'custom';
        return;
      }
      const submittedRuleJson = JSON.stringify(this.advancedRule);
      const submittedSourcesJson = JSON.stringify(this.advancedSources);
      const submittedPattern = this.always_active_pattern_editing;
      this.activeSaveInFlight++;
      try {
        await this.settingsStore.useLegacyActiveTimeV2();
        if (
          draftMatchesSubmission(this.advancedRule, submittedRuleJson) &&
          draftMatchesSubmission(this.advancedSources, submittedSourcesJson) &&
          this.always_active_pattern_editing === submittedPattern
        ) {
          this.activeModeDraft = 'automatic';
          this.syncActiveTimeDraft();
        } else {
          this.loadedActiveTimeJson = this.canonicalActiveTimeJson;
          this.loadedAdvancedRuleJson = submittedRuleJson;
          this.loadedAdvancedSourcesJson = submittedSourcesJson;
        }
      } catch (error) {
        this.advancedSaveError = error instanceof Error ? error.message : String(error);
      } finally {
        this.activeSaveInFlight--;
      }
    },
  },
};
</script>
