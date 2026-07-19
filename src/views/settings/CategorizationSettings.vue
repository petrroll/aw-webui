<template lang="pug">
div
  p.mb-2
    | {{ $t('settings.categorization.rulesHelp') }}
  p
    | {{ $t('settings.categorization.forumIntro') }}
    |  #[a(href="https://forum.activitywatch.net/c/projects/category-rules") {{ $t('settings.categorization.forum') }}].
    | {{ $t('settings.categorization.docsIntro') }}
    |  #[a(href="https://docs.activitywatch.net/en/latest/features/categorization.html") {{ $t('settings.categorization.documentation') }}].

  div.my-3.p-3.bg-light.rounded
    div.d-flex.align-items-center(style="gap: 1rem")
      div.flex-grow-1
        h5.mb-1 {{ $t('settings.categorization.editorModeTitle') }}
        small.text-muted {{ $t('settings.categorization.editorModeHelp') }}
      b-button-group.flex-shrink-0
        b-btn(
          size="sm"
          :variant="editorMode === 'simple' ? 'primary' : 'outline-primary'"
          :disabled="editorModeBusy || hasUnsavedRules"
          @click="requestEditorMode('simple')"
        ) {{ $t('settings.categorization.editorModeSimple') }}
        b-btn(
          size="sm"
          :variant="editorMode === 'advanced' ? 'primary' : 'outline-primary'"
          :disabled="editorModeBusy || hasUnsavedRules || !advancedAvailable"
          @click="requestEditorMode('advanced')"
        ) {{ $t('settings.categorization.editorModeAdvanced') }}
    b-alert.mt-2.mb-0(
      variant="warning"
      :show="editorMode === 'advanced' && !advancedAvailable"
    ) {{ $t('settings.categorization.advancedBackendRequired') }}
    b-alert.mt-2.mb-0(
      variant="info"
      :show="!editorHintDismissed"
      dismissible
      @dismissed="dismissEditorHint"
    )
      strong {{ $t('settings.categorization.editorModeHintTitle') }}
      ul.mb-1.mt-1.pl-3
        li {{ $t('settings.categorization.editorModeHintSimple') }}
        li {{ $t('settings.categorization.editorModeHintAdvanced') }}
      p.small.mb-1 {{ $t('settings.categorization.editorModeHintSwitch') }}
      p.small.mb-0.text-success(
        v-if="editorMode === 'advanced' && canReturnToSimpleWithoutChanges"
      )
        | {{ $t('settings.categorization.editorModeHintLossless') }}
      div.small(v-else-if="editorMode === 'advanced'")
        p.mb-1.font-weight-bold {{ $t('settings.categorization.editorModeHintHasChanges') }}
        ul.mb-1.pl-3
          li(v-for="line in simplificationHintLines" :key="line") {{ line }}
        p.mb-0 {{ $t('settings.categorization.editorModeHintReview') }}
    small.text-muted(v-if="hasUnsavedRules")
      | {{ $t('settings.categorization.editorModeHintUnsaved') }}

  div.d-flex.align-items-center.flex-wrap.mt-4
    h5.mb-0 {{ $t('settings.categorization.categories') }}
    div.ml-auto
      b-btn.ml-1(@click="restoreDefaultClasses", variant="outline-warning" size="sm")
        icon(name="undo")
        | {{ $t('settings.categorization.restoreDefaults') }}
      label.btn.btn-sm.ml-1.btn-outline-primary(style="margin: 0")
        | {{ $t('common.import') }}
        input(type="file" @change="importCategories" hidden)
      b-btn.ml-1(
        @click="exportClasses"
        variant="outline-primary"
        size="sm"
        :disabled="hasUnsavedRules"
      )
        | {{ $t('common.export') }}

  div.my-3
    b-alert(variant="warning" :show="classes_unsaved_changes || advancedSourcesDirty")
      | {{ $t('settings.categorization.unsavedChanges') }}
      div.float-right(style="margin-top: -0.15em; margin-right: -0.6em")
        b-btn.ml-2(
          @click="saveChanges"
          variant="success"
          size="sm"
        )
          | {{ $t('common.save') }}
        b-btn.ml-2(@click="resetChanges", variant="warning" size="sm")
          | {{ $t('settings.categorization.discard') }}
    b-alert(variant="danger" :show="!!categorySaveError") {{ categorySaveError }}
    div(v-for="_class in classes_hierarchy")
      CategoryEditTree(:_class="_class")
    div(v-if="editingId !== null")
      CategoryEditModal(:categoryId='editingId', @hidden="hideEditModal()")

  div.row
    div.col-sm-12
      b-btn(@click="addClass")
        icon.mr-2(name="plus")
        | {{ $t('settings.categorization.addCategory') }}

  div.mt-4(v-if="editorMode === 'advanced'")
    div.d-flex.align-items-center
      h5.mb-0 {{ $t('settings.categorization.sourcesTitle') }}
      b-btn.ml-auto(
        size="sm"
        variant="outline-primary"
        @click="sourcesOpen = !sourcesOpen"
      ) {{ sourcesOpen ? $t('settings.categorization.hideSources') : $t('settings.categorization.manageSources') }}
    small.text-muted
      | {{ $t('settings.categorization.sourcesHelp') }}
    b-collapse.mt-2(v-model="sourcesOpen")
      b-alert(variant="warning" :show="!sourceDefinitionsAvailable")
        | {{ $t('settings.categorization.sourceNamespaceRequired') }}
      RulesValidationAlert(
        v-if="sourceDefinitionsAvailable && sourceValidationAttempted"
        :errors="sourceErrors"
        :sources="advancedSources"
      )
      b-alert(variant="danger" :show="!!sourceSaveError") {{ sourceSaveError }}
      SourceDefinitionsEditor(
        v-if="sourceDefinitionsAvailable"
        v-model="advancedSources"
        :errors="sourceValidationAttempted ? sourceErrors : []"
      )

  div.mt-4(v-if="editorMode === 'advanced' && explainAvailable")
    div.d-flex.align-items-center
      h5.mb-0 {{ $t('settings.categorization.previewTitle') }}
      b-btn.ml-auto(
        size="sm"
        variant="outline-primary"
        @click="previewOpen = !previewOpen"
      ) {{ previewOpen ? $t('settings.categorization.hidePreview') : $t('settings.categorization.openPreview') }}
    small.text-muted
      | {{ $t('settings.categorization.previewHelp') }}
    b-collapse.mt-2(v-model="previewOpen")
      RulesPreview(v-if="previewOpen")

  div.mt-4(ref="builderSection")
    div.d-flex.align-items-center.flex-wrap
      h5.mb-0 {{ $t('settings.categorization.builderTitle') }}
      small.text-muted.ml-2 {{ $t('settings.categorization.builderSubtitle') }}
      b-btn.ml-auto(
        variant="outline-primary"
        size="sm"
        @click="builderOpen = !builderOpen"
        :aria-expanded="builderOpen ? 'true' : 'false'"
        aria-controls="category-builder-collapse"
      )
        icon.mr-1(:name="builderOpen ? 'angle-double-up' : 'angle-double-down'")
        | {{ builderOpen ? $t('settings.categorization.hideBuilder') : $t('settings.categorization.openBuilder') }}
    b-collapse#category-builder-collapse(v-model="builderOpen")
      div.mt-3(v-if="builderMounted")
        CategoryBuilder(embedded)

  b-modal(
    ref="simplifyModal"
    :title="$t('settings.categorization.downgradeTitle')"
    hide-footer
    no-close-on-backdrop
  )
    p {{ $t('settings.categorization.downgradeHelp') }}
    div(v-if="simplificationLosses.categories.length")
      h6 {{ $t('settings.categorization.downgradeCategories') }}
      ul
        li(v-for="category in simplificationLosses.categories" :key="category.id")
          strong {{ category.path }}
          ul
            li(v-for="reason in category.reasons" :key="reason")
              | {{ $t(`settings.categorization.downgradeReason${reason[0].toUpperCase()}${reason.slice(1)}`) }}
    div(v-if="simplificationLosses.active_time")
      h6 {{ $t('settings.categorization.downgradeActiveTime') }}
      p {{ $t('settings.categorization.downgradeActiveTimeReason') }}
    div(v-if="simplificationLosses.sources.length")
      h6 {{ $t('settings.categorization.downgradeSources') }}
      p.small.text-muted {{ $t('settings.categorization.downgradeSourcesHelp') }}
      ul
        li(v-for="source in simplificationLosses.sources" :key="source.id")
          | {{ downgradeSourceLabel(source) }}
    div.d-flex.justify-content-end.mt-3
      b-btn.mr-2(variant="secondary" @click="$refs.simplifyModal.hide()")
        | {{ $t('common.cancel') }}
      b-btn(variant="danger" :disabled="editorModeBusy" @click="confirmSimpleMode")
        | {{ $t('settings.categorization.downgradeConfirm') }}
</template>
<script lang="ts">
import { mapState, mapGetters } from 'pinia';
import CategoryEditTree from '~/components/CategoryEditTree.vue';
import CategoryEditModal from '~/components/CategoryEditModal.vue';
import 'vue-awesome/icons/undo';
import 'vue-awesome/icons/angle-double-down';
import 'vue-awesome/icons/angle-double-up';

import { useCategoryStore } from '~/stores/categories';
import { useServerStore } from '~/stores/server';
import { useSettingsStore } from '~/stores/settings';
import SourceDefinitionsEditor from '~/components/SourceDefinitionsEditor.vue';
import RulesValidationAlert from '~/components/RulesValidationAlert.vue';
import {
  computeRulesSimplificationLosses,
  hasRulesSimplificationLosses,
  inferRulesEditorMode,
  resolveRulesV2Settings,
  type RulesEditorMode,
  type RulesSimplificationLossSet,
  type SourceDefinitionV2,
  validateProfileRulesV2,
} from '~/util/rulesV2';

import { downloadFile } from '~/util/export';

const EDITOR_HINT_DISMISSED_KEY = 'aw.categorization.editorModeHintDismissed';

function editorHintWasDismissed(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(EDITOR_HINT_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

export default {
  name: 'CategorizationSettings',
  components: {
    CategoryEditTree,
    CategoryEditModal,
    SourceDefinitionsEditor,
    RulesValidationAlert,
    RulesPreview: () => import('~/views/settings/RulesPreview.vue'),
    CategoryBuilder: () => import('~/views/settings/CategoryBuilder.vue'),
  },
  data: () => ({
    categoryStore: useCategoryStore(),
    settingsStore: useSettingsStore(),
    serverStore: useServerStore(),
    editingId: null,
    builderOpen: false,
    builderMounted: false,
    sourcesOpen: false,
    advancedSources: [] as SourceDefinitionV2[],
    loadedSourcesJson: '',
    sourceSaveError: '',
    sourceValidationAttempted: false,
    categorySaveError: '',
    previewOpen: false,
    editorModeBusy: false,
    editorHintDismissed: editorHintWasDismissed(),
    simplificationLosses: {
      categories: [],
      active_time: null,
      sources: [],
    } as RulesSimplificationLossSet,
  }),
  computed: {
    ...mapState(useCategoryStore, ['classes_unsaved_changes']),
    ...mapGetters(useCategoryStore, ['classes_hierarchy', 'rules_v2_unsaved_changes']),
    hasUnsavedRules: function () {
      return this.classes_unsaved_changes || this.rules_v2_unsaved_changes;
    },
    advancedAvailable: function () {
      return this.serverStore.info?.capabilities?.includes('query.categorize_v2.v1') ?? false;
    },
    sourceDefinitionsAvailable: function () {
      return (
        this.serverStore.info?.capabilities?.includes(
          'query.merge_subwatcher_fields.source_namespace.v1'
        ) ?? false
      );
    },
    editorMode: function () {
      return this.settingsStore.rulesEditorMode;
    },
    explainAvailable: function () {
      return (
        this.advancedAvailable &&
        (this.serverStore.info?.capabilities?.includes('query.categorize_v2_explain.v1') ?? false)
      );
    },
    sourceErrors: function () {
      const rules = this.settingsStore.rulesV2;
      const profile = rules.activity_profiles_v2[0];
      if (!profile) {
        return [String(this.$t('settings.categorization.profileUnavailable'))];
      }
      return validateProfileRulesV2(
        { ...profile, sources: this.advancedSources },
        rules.category_sets_v2
      );
    },
    advancedSourcesDirty: function () {
      const persisted = this.settingsStore.rulesV2.activity_profiles_v2[0]?.sources ?? [];
      return JSON.stringify(this.advancedSources) !== JSON.stringify(persisted);
    },
    canonicalSourcesJson: function () {
      return JSON.stringify(this.settingsStore.rulesV2.activity_profiles_v2[0]?.sources ?? []);
    },
    currentSimplificationLosses: function (): RulesSimplificationLossSet {
      const rules = this.settingsStore.rulesV2;
      return computeRulesSimplificationLosses(
        rules.activity_profiles_v2[0],
        rules.category_sets_v2[0]
      );
    },
    canReturnToSimpleWithoutChanges: function () {
      return !hasRulesSimplificationLosses(this.currentSimplificationLosses);
    },
    simplificationHintLines: function (): string[] {
      const losses = this.currentSimplificationLosses;
      const lines = losses.categories.slice(0, 3).map(category => {
        const reasons = category.reasons.map(reason =>
          this.$t(
            `settings.categorization.editorModeHintReason${reason[0].toUpperCase()}${reason.slice(
              1
            )}`
          )
        );
        return String(
          this.$t('settings.categorization.editorModeHintCategory', {
            category: category.path,
            reasons: reasons.join(', '),
          })
        );
      });
      if (losses.categories.length > 3) {
        lines.push(
          String(
            this.$t('settings.categorization.editorModeHintMoreCategories', {
              count: losses.categories.length - 3,
            })
          )
        );
      }
      if (losses.active_time) {
        lines.push(String(this.$t('settings.categorization.editorModeHintActiveTime')));
      }
      if (losses.sources.length) {
        const shownSources = losses.sources.slice(0, 2).map(source => source.label);
        const remaining = losses.sources.length - shownSources.length;
        const sourceNames = remaining
          ? `${shownSources.join(', ')} +${remaining}`
          : shownSources.join(', ');
        lines.push(
          String(
            this.$t('settings.categorization.editorModeHintSources', {
              sources: sourceNames,
            })
          )
        );
      }
      return lines;
    },
  },
  watch: {
    builderOpen(v: boolean) {
      if (v) this.builderMounted = true;
    },
    advancedSourcesDirty(value: boolean) {
      this.categoryStore.setRulesV2DraftDirty('sources', value);
    },
    canonicalSourcesJson(value: string) {
      if (JSON.stringify(this.advancedSources) === this.loadedSourcesJson) {
        this.advancedSources = JSON.parse(value);
      }
      this.loadedSourcesJson = value;
    },
  },
  async mounted() {
    await this.settingsStore.ensureLoaded();
    this.advancedSources = JSON.parse(
      JSON.stringify(this.settingsStore.rulesV2.activity_profiles_v2[0]?.sources ?? [])
    );
    this.loadedSourcesJson = JSON.stringify(this.advancedSources);
    this.categoryStore.load();
    window.addEventListener('beforeunload', this.beforeUnload);

    if (this.$route.query.builder === 'open') {
      this.builderOpen = true;
      this.$nextTick(() => {
        const el = this.$refs.builderSection as HTMLElement | undefined;
        if (el && typeof el.scrollIntoView === 'function') {
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    }
  },
  beforeDestroy() {
    window.removeEventListener('beforeunload', this.beforeUnload);
    this.categoryStore.setRulesV2DraftDirty('sources', false);
  },
  methods: {
    downgradeSourceLabel(source: Pick<SourceDefinitionV2, 'label'>) {
      return this.$t('settings.categorization.downgradeSourceItem', {
        label: source.label,
      });
    },
    dismissEditorHint() {
      this.editorHintDismissed = true;
      if (typeof localStorage === 'undefined') return;
      try {
        localStorage.setItem(EDITOR_HINT_DISMISSED_KEY, '1');
      } catch {
        // The hint still stays dismissed for this page load.
      }
    },
    requestEditorMode: async function (mode: RulesEditorMode) {
      if (mode === this.editorMode) return;
      this.categorySaveError = '';
      if (mode === 'advanced') {
        this.editorModeBusy = true;
        try {
          await this.settingsStore.setRulesEditorMode('advanced');
        } catch (error) {
          this.categorySaveError = error instanceof Error ? error.message : String(error);
        } finally {
          this.editorModeBusy = false;
        }
        return;
      }
      this.simplificationLosses = this.currentSimplificationLosses;
      if (hasRulesSimplificationLosses(this.simplificationLosses)) {
        this.$refs.simplifyModal.show();
        return;
      }
      this.editorModeBusy = true;
      try {
        await this.settingsStore.simplifyRulesV2();
        this.categoryStore.load();
      } catch (error) {
        this.categorySaveError = error instanceof Error ? error.message : String(error);
      } finally {
        this.editorModeBusy = false;
      }
    },
    confirmSimpleMode: async function () {
      this.categorySaveError = '';
      this.editorModeBusy = true;
      try {
        await this.settingsStore.simplifyRulesV2();
        this.categoryStore.load();
        this.categoryStore.discardPendingV2Changes();
        this.advancedSources = [];
        this.loadedSourcesJson = '[]';
        this.sourcesOpen = false;
        this.previewOpen = false;
        this.$refs.simplifyModal.hide();
      } catch (error) {
        this.categorySaveError = error instanceof Error ? error.message : String(error);
      } finally {
        this.editorModeBusy = false;
      }
    },
    addClass: function () {
      const lastId = this.categoryStore.addClass({
        name: ['New class'],
        rule: { type: 'regex', regex: 'FILL ME' },
      });
      this.editingId = lastId;
    },
    saveChanges: async function () {
      this.categorySaveError = '';
      this.sourceSaveError = '';
      if (this.advancedSourcesDirty && this.sourceErrors.length > 0) {
        this.sourceValidationAttempted = true;
        this.sourcesOpen = true;
        return;
      }
      try {
        await this.categoryStore.save(this.advancedSourcesDirty ? this.advancedSources : undefined);
        this.advancedSources = JSON.parse(
          JSON.stringify(this.settingsStore.rulesV2.activity_profiles_v2[0]?.sources ?? [])
        );
        this.loadedSourcesJson = JSON.stringify(this.advancedSources);
        this.sourceValidationAttempted = false;
      } catch (error) {
        this.categorySaveError = error instanceof Error ? error.message : String(error);
      }
    },
    resetChanges: async function () {
      await this.categoryStore.load();
      this.advancedSources = JSON.parse(
        JSON.stringify(this.settingsStore.rulesV2.activity_profiles_v2[0]?.sources ?? [])
      );
      this.loadedSourcesJson = JSON.stringify(this.advancedSources);
      this.sourceValidationAttempted = false;
    },
    restoreDefaultClasses: async function () {
      if (
        hasRulesSimplificationLosses(this.currentSimplificationLosses) &&
        !confirm(String(this.$t('settings.categorization.restoreDefaultsConfirm')))
      ) {
        return;
      }
      await this.categoryStore.restoreDefaultClasses();
    },
    hideEditModal: function () {
      this.editingId = null;
    },
    exportClasses: async function () {
      if (this.hasUnsavedRules) {
        this.categorySaveError = String(this.$t('settings.categorization.unsavedChanges'));
        return;
      }
      const rules = this.settingsStore.rulesV2;
      const export_data = {
        schema_version: 2,
        activity_profiles_v2: rules.activity_profiles_v2,
        category_sets_v2: rules.category_sets_v2,
        id: 'default',
        categories: this.categoryStore.classes_clean,
      };
      const text = JSON.stringify(export_data, null, 2);
      await downloadFile('aw-category-export.json', text, 'application/json');
    },
    importCategories: async function (elem) {
      this.categorySaveError = '';
      const file = elem.target.files[0];
      if (file.type != 'application/json') {
        this.categorySaveError = String(this.$t('settings.categorization.importJsonOnly'));
        return;
      }

      try {
        const text = await file.text();
        const import_obj = JSON.parse(text);
        if (!confirm(String(this.$t('settings.categorization.importReplaceConfirm')))) {
          return;
        }

        if (
          Array.isArray(import_obj.activity_profiles_v2) &&
          import_obj.activity_profiles_v2.length === 1 &&
          Array.isArray(import_obj.category_sets_v2) &&
          import_obj.category_sets_v2.length > 0
        ) {
          const imported = resolveRulesV2Settings({
            activity_profiles_v2: import_obj.activity_profiles_v2,
            category_sets_v2: import_obj.category_sets_v2,
            classes: this.categoryStore.classes_clean,
            always_active_pattern: this.settingsStore.always_active_pattern,
          });
          await this.settingsStore.saveCanonicalRulesV2({
            profiles: imported.activity_profiles_v2,
            categorySets: imported.category_sets_v2,
            extra: {
              rules_editor_mode: inferRulesEditorMode(
                imported.activity_profiles_v2[0],
                imported.category_sets_v2[0]
              ),
            },
          });
          this.categoryStore.load();
          this.advancedSources = JSON.parse(
            JSON.stringify(imported.activity_profiles_v2[0].sources)
          );
        } else if (Array.isArray(import_obj.categories)) {
          this.categoryStore.import(import_obj.categories);
        } else {
          throw new Error(String(this.$t('settings.categorization.importFormatUnknown')));
        }
      } catch (error) {
        this.categorySaveError = error instanceof Error ? error.message : String(error);
      } finally {
        elem.target.value = '';
      }
    },
    beforeUnload: function (e) {
      if (this.hasUnsavedRules) {
        const msg = this.$t('settings.unsavedCategoriesLeave');
        e = e || window.event;
        e.preventDefault();
        e.returnValue = msg;
        return msg;
      }
    },
  },
};
</script>
