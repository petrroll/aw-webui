<template lang="pug">
// The category edit modal
b-modal(
  id="edit"
  ref="edit"
  :title="$t('settings.categorization.editCategory')"
  :ok-title="$t('common.apply')"
  @show="resetModal"
  @hidden="hidden"
  @ok="handleOk"
)
  div.my-1
    b-input-group.my-1(prepend="Name")
      b-form-input(v-model="editing.name")
    b-input-group(prepend="Parent")
      b-select(v-model="editing.parent", :options="allCategories")
    //| ID: {{editing.id}}

  hr
  div.my-1
    b Rule
    div(v-if="editorMode === 'simple'")
      b-alert.mt-2(variant="info" :show="advancedRuleLocked")
        | {{ $t('settings.categorization.simpleRuleLocked') }}
      b-input-group.my-1(prepend="Type")
        b-select(v-model="editing.rule.type", :options="allRuleTypes" :disabled="advancedRuleLocked")
      div(v-if="editing.rule.type === 'regex'")
        b-input-group.my-1(prepend="Pattern")
          b-form-input(v-model="editing.rule.regex" :disabled="advancedRuleLocked")
        div.d-flex
          div.flex-grow-1
            b-form-checkbox(v-model="editing.rule.ignore_case" :disabled="advancedRuleLocked" switch)
              | Case insensitive
          div.flex-grow-1
            small.text-right
              div.text-danger(v-if="!validPattern") Invalid pattern
              div.text-warning(v-if="validPattern && broad_pattern") Pattern too broad
    div.mt-2(v-else)
      p.small.text-muted
        | {{ $t('settings.categorization.weightHelp') }}
      RulesValidationAlert(
        v-if="advancedValidationAttempted"
        :errors="advancedErrors"
        :sources="advancedSources"
      )
      b-alert(variant="danger" :show="!!advancedSaveError") {{ advancedSaveError }}
      RuleExpressionEditor(
        v-model="advancedRule"
        :source-definitions="advancedSources"
        :allow-bucket-sources="supportsContextSources"
        :allow-activity-creation="true"
        :activity-creation-supported="supportsActivityCoverage"
        @sources-input="advancedSources = $event"
      )
      b-form-group
        template(#label)
          | {{ $t('settings.categorization.categoryPriority') }}
          span.ml-1.d-inline-block(
            tabindex="0"
            role="button"
            v-b-tooltip.hover.focus
            :title="$t('settings.categorization.categoryPriorityHelp')"
          )
            icon(name="info-circle")
        b-form-input(type="number" v-model.number="advancedPriority")
      b-form-group.mt-3
        template(#label)
          | {{ $t('settings.categorization.prerequisites') }}
          span.ml-1.d-inline-block(
            tabindex="0"
            role="button"
            v-b-tooltip.hover.focus
            :title="$t('settings.categorization.prerequisitesHelp')"
          )
            icon(name="info-circle")
        div(v-if="requirementOptions.length")
          div.prerequisite-option(v-for="option in requirementOptions" :key="option.value")
            span.d-inline-block(
              tabindex="0"
              v-b-tooltip.hover.focus
              :title="option.tooltip || ''"
              :class="{ 'prerequisite-disabled': option.disabled }"
            )
              b-form-checkbox(
                :checked="advancedRequires.includes(option.value)"
                :disabled="option.disabled"
                @input="toggleRequirement(option.value, $event)"
              )
                | {{ option.text }}
                small.text-warning.ml-2(v-if="option.missingRule && !option.disabled")
                  | {{ $t('settings.categorization.prerequisiteMissingRule') }}
        small.text-muted(v-else) {{ $t('settings.categorization.noPrerequisites') }}

  hr
  div.my-1
    b Color

    b-form-checkbox(v-model="editing.inherit_color" switch)
      | Inherit parent color
    div.mt-1(v-show="!editing.inherit_color")
      color-picker(v-model="editing.color")

  hr
  div.my-1
    b Productivity score
    b-form-checkbox(v-model="editing.inherit_score" switch)
      | Inherit parent score
    b-input-group.my-1(prepend="Score" v-if="!editing.inherit_score")
      b-form-input(v-model="editing.score")

  hr
  div.my-1
    b-btn(variant="danger", @click="removeClass(categoryId); $refs.edit.hide()")
      icon(name="trash")
      | Remove category
</template>

<script lang="ts">
import _ from 'lodash';
import ColorPicker from '~/components/ColorPicker.vue';
import { useCategoryStore } from '~/stores/categories';
import { useBucketsStore } from '~/stores/buckets';
import { useSettingsStore } from '~/stores/settings';
import { useServerStore } from '~/stores/server';
import { mapState } from 'pinia';
import { validateRegex, isRegexBroad } from '~/util/validate';
import RuleExpressionEditor from '~/components/RuleExpressionEditor.vue';
import RulesValidationAlert from '~/components/RulesValidationAlert.vue';
import { buildParentRequirementOptions } from '~/util/rulesEditor';
import {
  canUseSimpleCategoryUI,
  collectRuleSourceIds,
  isLegacyCompatibleRuleV2,
  legacyRuleToV2,
  validateRuleExpression,
  v2RuleToLegacy,
  type RuleExpressionV2,
  type SourceDefinitionV2,
} from '~/util/rulesV2';
import { findCategoryRuleV2 } from '~/util/rulesV2Editor';

import 'vue-awesome/icons/trash';
import 'vue-awesome/icons/info-circle';

export default {
  name: 'CategoryEditModal',
  components: {
    'color-picker': ColorPicker,
    RuleExpressionEditor,
    RulesValidationAlert,
  },
  props: {
    categoryId: { type: Number, required: true },
  },
  data: function () {
    return {
      categoryStore: useCategoryStore(),
      bucketsStore: useBucketsStore(),
      settingsStore: useSettingsStore(),
      serverStore: useServerStore(),
      advancedRule: { type: 'none' } as RuleExpressionV2,
      advancedSources: [] as SourceDefinitionV2[],
      loadedAdvancedSources: [] as SourceDefinitionV2[],
      advancedPriority: 0,
      advancedRequires: [] as string[],
      advancedCategoryId: undefined as string | undefined,
      advancedDraftId: undefined as string | undefined,
      advancedSaveError: '',
      advancedValidationAttempted: false,
      simpleUI: true,
      originalName: [] as string[],

      editing: {
        id: 0, // FIXME: Use ID assigned to category in store, in order for saves to be uniquely targeted
        name: null,
        rule: {},
        parent: [],
        inherit_color: true,
        color: null,
        inherit_score: true,
        score: null,
      },
    };
  },
  computed: {
    ...mapState(useCategoryStore, {
      allCategories: state => [{ value: [], text: 'None' }].concat(state.allCategoriesSelect),
    }),
    allRuleTypes: function () {
      return [
        { value: 'none', text: 'None' },
        { value: 'regex', text: 'Regular Expression' },
        //{ value: 'glob', text: 'Glob pattern' },
      ];
    },
    valid: function () {
      return this.editing.rule.type !== 'none' && this.validPattern;
    },
    validPattern: function () {
      return this.editing.rule.type === 'regex' && validateRegex(this.editing.rule.regex || '');
    },
    broad_pattern: function () {
      return this.editing.rule.type === 'regex' && isRegexBroad(this.editing.rule.regex || '');
    },
    editorMode: function () {
      return this.settingsStore.rulesEditorMode;
    },
    supportsContextSources: function () {
      return (
        this.serverStore.info?.capabilities?.includes(
          'query.merge_subwatcher_fields.source_namespace.v1'
        ) ?? false
      );
    },
    supportsActivityCoverage: function () {
      const capabilities = this.serverStore.info?.capabilities ?? [];
      return capabilities.includes('query.merge_subwatcher_fields.source_namespace.v1');
    },
    requirementOptions: function () {
      const rules = this.settingsStore.rulesV2;
      const editedPath = [...(this.editing.parent ?? []), this.editing.name].filter(
        part => typeof part === 'string' && part.length > 0
      );
      const editableSet = rules.category_sets_v2.find(
        set => set.id === this.categoryStore.editable_category_set_id
      );
      return buildParentRequirementOptions({
        categories: editableSet?.categories ?? [],
        currentPath: editedPath,
        currentCategoryId: this.advancedCategoryId,
        selectedIds: this.advancedRequires,
        pendingEdit: category => this.categoryStore.pendingV2Edit(category.id, category.name),
      }).map(option => {
        return {
          ...option,
          tooltip: option.missingRule
            ? this.$t(
                this.advancedRequires.includes(option.value)
                  ? 'settings.categorization.prerequisiteSelectedWithoutRule'
                  : 'settings.categorization.prerequisiteUnavailableWithoutRule'
              )
            : '',
        };
      });
    },
    advancedErrors: function () {
      const errors = validateRuleExpression(this.advancedRule);
      const sourceIds = new Set(this.advancedSources.map(source => source.id));
      for (const sourceId of collectRuleSourceIds(this.advancedRule)) {
        if (!sourceIds.has(sourceId)) {
          errors.push(
            String(this.$t('settings.categorization.ruleUnknownSource', { source: sourceId }))
          );
        }
      }
      return errors;
    },
    advancedRuleLocked: function () {
      return this.editorMode === 'simple' && !this.simpleUI;
    },
  },
  watch: {
    categoryId: function (new_value) {
      if (new_value !== null) {
        this.showModal();
      }
    },
  },
  mounted: function () {
    this.bucketsStore.ensureLoaded().catch(error => {
      console.warn('Unable to load host suggestions', error);
    });
    if (this.categoryId !== null) {
      this.showModal();
    }
  },
  methods: {
    toggleRequirement(categoryId: string, checked: boolean) {
      this.advancedRequires = checked
        ? _.uniq([...this.advancedRequires, categoryId])
        : this.advancedRequires.filter(id => id !== categoryId);
    },
    showModal() {
      this.$refs.edit.show();
    },
    hidden() {
      this.$emit('hidden');
    },
    removeClass() {
      this.categoryStore.queueV2Delete(this.originalName, this.advancedCategoryId);
      this.categoryStore.removeClass(this.categoryId);
    },
    checkFormValidity() {
      const simpleValid =
        this.advancedRuleLocked ||
        this.editing.rule.type === 'none' ||
        (this.editing.rule.type === 'regex' && this.validPattern);
      return (
        (this.editorMode === 'simple' && simpleValid) ||
        (this.editorMode === 'advanced' && this.advancedErrors.length === 0)
      );
    },
    async handleOk(event) {
      // Prevent modal from closing
      event.preventDefault();
      // Trigger submit handler
      if (await this.handleSubmit()) this.$emit('ok');
    },
    async handleSubmit() {
      // Exit when the form isn't valid
      if (!this.checkFormValidity()) {
        this.advancedValidationAttempted = this.editorMode === 'advanced';
        return false;
      }

      // Save the category
      const projectedAdvancedRule = v2RuleToLegacy(this.advancedRule) ?? { type: 'none' as const };
      const new_class = {
        id: this.editing.id,
        name: this.editing.parent.concat(this.editing.name),
        rule:
          this.editorMode === 'advanced'
            ? projectedAdvancedRule
            : this.editing.rule.type !== 'none'
            ? this.editing.rule
            : { type: 'none' },
        data: {
          color: this.editing.inherit_color === true ? undefined : this.editing.color,
          score: this.editing.inherit_score === true ? undefined : this.editing.score,
        },
      };
      this.advancedSaveError = '';
      this.advancedValidationAttempted = false;
      const preserveAdvanced = this.editorMode === 'advanced' || this.advancedRuleLocked;
      this.categoryStore.queueV2Edit({
        draftId: this.advancedDraftId,
        categoryId: this.advancedCategoryId,
        originalName: this.originalName,
        name: new_class.name,
        rule: preserveAdvanced ? this.advancedRule : legacyRuleToV2(new_class.rule),
        priority: preserveAdvanced ? this.advancedPriority : 0,
        requires: preserveAdvanced ? this.advancedRequires : [],
      });
      this.categoryStore.queueV2Sources(this.advancedSources, this.loadedAdvancedSources);
      this.categoryStore.updateClass(new_class);

      // Hide the modal manually
      this.$nextTick(() => {
        this.$refs.edit.hide();
      });
      return true;
    },
    resetModal() {
      const cat = this.categoryStore.get_category_by_id(this.categoryId);
      const color = cat.data ? cat.data.color : undefined;
      const inherit_color = !color;
      const score = cat.data ? cat.data.score : undefined;
      const inherit_score = !score;
      const rules = this.settingsStore.rulesV2;
      this.advancedSources = _.cloneDeep(
        this.categoryStore.pendingV2Sources ?? rules.activity_profiles_v2[0]?.sources ?? []
      );
      this.loadedAdvancedSources = _.cloneDeep(this.advancedSources);
      const canonicalName = this.categoryStore.canonicalNameForPendingPath(cat.name);
      const v2Category = findCategoryRuleV2(
        rules.activity_profiles_v2[0],
        rules.category_sets_v2,
        canonicalName,
        this.categoryStore.editable_category_set_id ?? undefined
      );
      const pendingEdit = this.categoryStore.pendingV2Edit(v2Category?.id, cat.name);
      this.originalName = [...(pendingEdit?.originalName ?? v2Category?.name ?? canonicalName)];
      this.advancedRule = _.cloneDeep(
        pendingEdit?.rule ?? v2Category?.rule ?? legacyRuleToV2(cat.rule)
      );
      this.advancedCategoryId = pendingEdit?.categoryId ?? v2Category?.id;
      this.advancedDraftId = pendingEdit?.draftId;
      this.advancedPriority = pendingEdit?.priority ?? v2Category?.priority ?? 0;
      this.advancedRequires = [...(pendingEdit?.requires ?? v2Category?.requires ?? [])];
      this.simpleUI = pendingEdit
        ? canUseSimpleCategoryUI({
            rule: pendingEdit.rule,
            priority: pendingEdit.priority,
            requires: pendingEdit.requires,
          })
        : v2Category?.simple_ui ?? isLegacyCompatibleRuleV2(this.advancedRule);
      this.advancedSaveError = '';
      this.advancedValidationAttempted = false;
      this.editing = {
        id: cat.id,
        name: cat.subname,
        rule: _.cloneDeep(cat.rule),
        parent: cat.parent ? cat.parent : [],
        color,
        inherit_color,
        score,
        inherit_score,
      };
    },
  },
};
</script>

<style scoped>
.prerequisite-option + .prerequisite-option {
  margin-top: 0.35rem;
}

.prerequisite-disabled {
  cursor: not-allowed;
}
</style>
