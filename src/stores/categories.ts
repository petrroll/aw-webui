import _ from 'lodash';
import {
  cleanCategory,
  defaultCategories,
  build_category_hierarchy,
  createMissingParents,
  annotate,
  Category,
  Rule,
} from '~/util/classes';
import { getColorFromCategory } from '~/util/color';
import { defineStore } from 'pinia';
import { useSettingsStore } from '~/stores/settings';
import {
  validateProfileRulesV2,
  mergeSourceDefinitionChanges,
  categorySetToLegacyClasses,
  type RuleExpressionV2,
  type SourceDefinitionV2,
} from '~/util/rulesV2';
import {
  deleteCategoryRuleV2,
  synchronizeCategoryTreeV2,
  updateCategoryRuleV2,
} from '~/util/rulesV2Editor';

interface PendingV2Edit {
  draftId?: string;
  categoryId?: string;
  originalName: string[];
  name: string[];
  rule: RuleExpressionV2;
  priority: number;
  requires: string[];
}

interface PendingV2Delete {
  delete: true;
  categoryId?: string;
  name: string[];
}

export interface ProfilePresentationV2 {
  app_title_source_id?: string;
  browser_focus_source_id?: string;
}

interface State {
  classes: Category[];
  classes_unsaved_changes: boolean;
  pending_v2_edits: Array<PendingV2Edit | PendingV2Delete>;
  pending_v2_sources: SourceDefinitionV2[] | null;
  _rules_v2_dirty_sections: string[];
  replace_v2_rules_on_save: boolean;
  editable_category_set_id: string | null;
  editable_category_set_explicit: boolean;
}

function getScoreFromCategory(c: Category, allCats: Category[]): number {
  // Returns the score for a certain category, falling back to parents if none set
  // Very similar to getColorFromCategory
  if (c && c.data && c.data.score) {
    return c.data.score;
  } else if (c && c.name.slice(0, -1).length > 0) {
    // If no color is set on category, traverse parents until one is found
    const parent = c.name.slice(0, -1);
    const parentCat = allCats.find(cc => _.isEqual(cc.name, parent));
    return getScoreFromCategory(parentCat, allCats);
  } else {
    return 0;
  }
}

// Normalize URL-encoded category segments (e.g. "Work%20Project" → "Work Project").
// Route query params can arrive encoded while category names are stored decoded.
function normalizeSegments(cat: string[]): string[] {
  return (cat || []).map(segment => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
}

function assignIds(classes: Category[]): Category[] {
  let i = 0;
  return classes.map(c => Object.assign(c, { id: i++ }));
}

export const useCategoryStore = defineStore('categories', {
  state: (): State => ({
    classes: [],
    classes_unsaved_changes: false,
    pending_v2_edits: [],
    pending_v2_sources: null,
    _rules_v2_dirty_sections: [],
    replace_v2_rules_on_save: false,
    editable_category_set_id: null,
    editable_category_set_explicit: false,
  }),

  // getters
  getters: {
    classes_clean(): Category[] {
      return this.classes.map(cleanCategory);
    },
    rules_v2_unsaved_changes(): boolean {
      return this._rules_v2_dirty_sections.length > 0;
    },
    classes_hierarchy() {
      const hier = build_category_hierarchy(_.cloneDeep(this.classes));
      return _.sortBy(hier, [c => c.id || 0]);
    },
    classes_for_query(): [string[], Rule][] {
      return this.classes
        .filter(c => c.rule.type !== null)
        .map(c => {
          return [c.name, c.rule];
        });
    },
    all_categories(): string[][] {
      // Returns a list of category names (a list of list of strings)
      return _.uniqBy(
        _.flatten(
          this.classes.map((c: Category) => {
            const l = [];
            for (let i = 1; i <= c.name.length; i++) {
              l.push(c.name.slice(0, i));
            }
            return l;
          })
        ),
        (v: string[]) => v.join('>>>>') // Can be any separator that doesn't appear in the category names themselves
      );
    },
    allCategoriesSelect(): { value: string[]; text: string }[] {
      const categories = this.all_categories;
      const entries = categories.map(c => {
        return { text: c.join(' > '), value: c, id: c.id };
      });
      return _.sortBy(entries, 'text');
    },
    get_category(this: State) {
      return (category_arr: string[]): Category => {
        if (typeof category_arr === 'string' || category_arr instanceof String)
          console.error('Passed category was string, expected array. Lookup will fail.');

        const match = this.classes.find(c => _.isEqual(c.name, category_arr));
        if (!match) {
          if (!_.isEqual(category_arr, ['Uncategorized']))
            console.error("Couldn't find category: ", category_arr);
          // fallback
          return { name: ['Uncategorized'], rule: { type: 'none' } };
        }
        return annotate(_.cloneDeep(match));
      };
    },
    get_category_by_id(this: State) {
      return (id: number) => {
        return annotate(_.cloneDeep(this.classes.find((c: Category) => c.id == id)));
      };
    },
    pendingV2Edit(this: State) {
      return (
        categoryId: string | undefined,
        name: string[],
        draftId?: string
      ): PendingV2Edit | undefined => {
        const edit = this.pending_v2_edits.find(candidate => {
          if ('delete' in candidate) return false;
          if (draftId) return candidate.draftId === draftId;
          return categoryId
            ? candidate.categoryId === categoryId
            : _.isEqual(candidate.name, name) || _.isEqual(candidate.originalName, name);
        });
        return edit && !('delete' in edit) ? _.cloneDeep(edit) : undefined;
      };
    },
    pendingV2Sources(this: State): SourceDefinitionV2[] | null {
      if (!this.pending_v2_sources) return null;
      const persisted = useSettingsStore().rulesV2.activity_profiles_v2[0]?.sources ?? [];
      return mergeSourceDefinitionChanges(persisted, this.pending_v2_sources, []);
    },
    canonicalNameForPendingPath(this: State) {
      return (name: string[]): string[] => {
        let canonicalName = [...name];
        const renames = this.pending_v2_edits
          .filter((candidate): candidate is PendingV2Edit => !('delete' in candidate))
          .filter(candidate => !_.isEqual(candidate.originalName, candidate.name))
          .sort((left, right) => right.name.length - left.name.length);
        for (let pass = 0; pass < renames.length; pass++) {
          let changed = false;
          for (const rename of renames) {
            if (
              canonicalName.length >= rename.name.length &&
              _.isEqual(canonicalName.slice(0, rename.name.length), rename.name)
            ) {
              canonicalName = rename.originalName.concat(canonicalName.slice(rename.name.length));
              changed = true;
            }
          }
          if (!changed) break;
        }
        return canonicalName;
      };
    },
    get_category_color() {
      return (cat: string[]): string => {
        return getColorFromCategory(this.get_category(normalizeSegments(cat)), this.classes);
      };
    },
    get_category_score() {
      return (cat: string[]): number => {
        return getScoreFromCategory(this.get_category(normalizeSegments(cat)), this.classes);
      };
    },
    category_select() {
      return (insertMeta: boolean): { text: string; value?: string[] }[] => {
        // Useful for <select> elements enumerating categories
        let cats = this.all_categories;
        cats = cats
          .map((c: string[]) => {
            return { text: c.join(' > '), value: c };
          })
          .sort((a, b) => a.text > b.text);
        if (insertMeta) {
          cats = [
            { text: 'All', value: null },
            { text: 'Uncategorized', value: ['Uncategorized'] },
          ].concat(cats);
        }
        return cats;
      };
    },
  },

  actions: {
    load(this: State, classes?: Category[], categorySetId?: string) {
      const settingsStore = useSettingsStore();
      const rules = settingsStore.rulesV2;
      const selectedId =
        categorySetId ??
        rules.activity_profiles_v2[0]?.category_set_ids[0] ??
        rules.category_sets_v2[0]?.id ??
        null;
      const selectedSet = rules.category_sets_v2.find(set => set.id === selectedId);
      this.editable_category_set_id = selectedSet?.id ?? null;
      this.editable_category_set_explicit = categorySetId !== undefined;
      const loadedClasses =
        classes ??
        (categorySetId && selectedSet
          ? categorySetToLegacyClasses(selectedSet)
          : settingsStore.classes);
      this.classes = assignIds(createMissingParents(loadedClasses));
      this.classes_unsaved_changes = false;
      this.pending_v2_edits = [];
      this.pending_v2_sources = null;
      this.replace_v2_rules_on_save = false;
    },

    selectCategorySet(categorySetId: string) {
      this.load(undefined, categorySetId);
    },

    async save(
      this: State,
      sourceSnapshot?: SourceDefinitionV2[],
      presentation?: ProfilePresentationV2
    ) {
      const settingsStore = useSettingsStore();
      await settingsStore.ensureLoaded();
      const rules = settingsStore.rulesV2;
      if (
        !this.editable_category_set_explicit &&
        (rules.activity_profiles_v2[0]?.category_set_ids.length ?? 0) > 1
      ) {
        throw new Error(
          'Cannot save the combined category-set view; select a specific category set first'
        );
      }
      const submittedEdits = _.cloneDeep(this.pending_v2_edits);
      const submittedSources = _.cloneDeep(this.pending_v2_sources);
      const submittedClasses = this.classes.map(cleanCategory);
      const submittedReplaceRules = this.replace_v2_rules_on_save;
      let profiles = rules.activity_profiles_v2;
      let categorySets = rules.category_sets_v2;
      if (sourceSnapshot) {
        profiles = _.cloneDeep(profiles);
        profiles[0].sources = _.cloneDeep(sourceSnapshot);
      }
      if (presentation) {
        if (profiles === rules.activity_profiles_v2) profiles = _.cloneDeep(profiles);
        if (presentation.app_title_source_id) {
          profiles[0].app_title_source_id = presentation.app_title_source_id;
        } else {
          delete profiles[0].app_title_source_id;
        }
        if (presentation.browser_focus_source_id) {
          profiles[0].browser_focus_source_id = presentation.browser_focus_source_id;
        } else {
          delete profiles[0].browser_focus_source_id;
        }
      }
      const profileId = profiles[0]?.id ?? 'default';
      for (const edit of submittedEdits) {
        const updated =
          'delete' in edit
            ? deleteCategoryRuleV2({
                profileId,
                profiles,
                categorySets,
                categoryId: edit.categoryId,
                name: edit.name,
                categorySetId: this.editable_category_set_id ?? undefined,
              })
            : updateCategoryRuleV2({
                profileId,
                profiles,
                categorySets,
                ...edit,
                categorySetId: this.editable_category_set_id ?? undefined,
              });
        profiles = updated.profiles;
        categorySets = updated.categorySets;
      }
      if (submittedSources) {
        profiles = _.cloneDeep(profiles);
        profiles[0].sources = mergeSourceDefinitionChanges(
          profiles[0].sources,
          submittedSources,
          []
        );
      }
      const synchronized = synchronizeCategoryTreeV2({
        profileId,
        profiles,
        categorySets,
        classes: submittedClasses,
        replaceRules: submittedReplaceRules,
        categorySetId: this.editable_category_set_id ?? undefined,
      });
      const errors = synchronized.profiles.flatMap(profile =>
        validateProfileRulesV2(profile, synchronized.categorySets)
      );
      if (errors.length > 0) throw new Error(errors.join('\n'));
      await settingsStore.saveCanonicalRulesV2({
        profiles: synchronized.profiles,
        categorySets: synchronized.categorySets,
      });
      this.pending_v2_edits = this.pending_v2_edits.filter(
        current => !submittedEdits.some(submitted => _.isEqual(current, submitted))
      );
      if (_.isEqual(this.pending_v2_sources, submittedSources)) {
        this.pending_v2_sources = null;
      }
      if (
        this.replace_v2_rules_on_save === submittedReplaceRules &&
        _.isEqual(this.classes.map(cleanCategory), submittedClasses)
      ) {
        this.replace_v2_rules_on_save = false;
      }
      this.classes_unsaved_changes =
        this.pending_v2_edits.length > 0 ||
        this.pending_v2_sources !== null ||
        this.replace_v2_rules_on_save ||
        !_.isEqual(this.classes.map(cleanCategory), submittedClasses);
    },
    discardPendingV2Changes(this: State) {
      this.pending_v2_edits = [];
      this.pending_v2_sources = null;
    },
    discardNewClassDraft(
      this: State,
      classId: number,
      draftId: string,
      originalName: string[],
      wasDirty: boolean
    ) {
      this.classes = this.classes.filter(category => category.id !== classId);
      this.pending_v2_edits = this.pending_v2_edits.filter(candidate => {
        if ('delete' in candidate) return true;
        return !(candidate.draftId === draftId && _.isEqual(candidate.originalName, originalName));
      });
      this.classes_unsaved_changes =
        wasDirty ||
        this.pending_v2_edits.length > 0 ||
        this.pending_v2_sources !== null ||
        this.replace_v2_rules_on_save;
    },
    queueV2Sources(this: State, sources: SourceDefinitionV2[], baseline: SourceDefinitionV2[]) {
      const changed = mergeSourceDefinitionChanges([], sources, baseline);
      this.pending_v2_sources = mergeSourceDefinitionChanges(
        this.pending_v2_sources ?? [],
        changed,
        []
      );
      this.classes_unsaved_changes = true;
    },
    setRulesV2DraftDirty(this: State, section: string, dirty: boolean) {
      this._rules_v2_dirty_sections = dirty
        ? _.uniq([...this._rules_v2_dirty_sections, section])
        : this._rules_v2_dirty_sections.filter(candidate => candidate !== section);
    },
    queueV2Edit(this: State, edit: PendingV2Edit) {
      const index = this.pending_v2_edits.findIndex(candidate => {
        if ('delete' in candidate) return false;
        if (edit.draftId) return candidate.draftId === edit.draftId;
        return edit.categoryId
          ? candidate.categoryId === edit.categoryId
          : _.isEqual(candidate.originalName, edit.originalName);
      });
      if (index >= 0) this.pending_v2_edits.splice(index, 1, _.cloneDeep(edit));
      else this.pending_v2_edits.push(_.cloneDeep(edit));
      this.classes_unsaved_changes = true;
    },
    queueV2Delete(this: State, name: string[], categoryId?: string) {
      this.pending_v2_edits = this.pending_v2_edits.filter(
        candidate =>
          !(
            'delete' in candidate &&
            (categoryId ? candidate.categoryId === categoryId : _.isEqual(candidate.name, name))
          )
      );
      this.pending_v2_edits.push({ delete: true, name: [...name], categoryId });
      this.classes_unsaved_changes = true;
    },

    // mutations
    import(this: State, classes: Category[]) {
      let i = 0;
      // overwrite id even if already set
      this.classes = classes.map(c => Object.assign(c, { id: i++ }));
      this.classes_unsaved_changes = true;
      this.replace_v2_rules_on_save = true;
    },
    updateClass(this: State, new_class: Category) {
      const old_class = this.classes.find((c: Category) => c.id === new_class.id);
      const old_name = old_class.name;
      const parent_depth = old_class.name.length;

      if (new_class.id === undefined || new_class.id === null) {
        new_class.id = (_.max(_.map(this.classes, 'id')) ?? -1) + 1;
        this.classes.push(new_class);
      } else {
        Object.assign(old_class, new_class);
      }

      // When a parent category is renamed, we also need to rename the children.
      // Only match categories strictly longer than old_name (actual children),
      // not siblings with the same name (fixes #702).
      _.map(this.classes, c => {
        if (
          c.id !== new_class.id &&
          c.name.length > parent_depth &&
          _.isEqual(old_name, c.name.slice(0, parent_depth))
        ) {
          c.name = new_class.name.concat(c.name.slice(parent_depth));
        }
      });

      this.classes_unsaved_changes = true;
    },
    addClass(this: State, new_class: Category): number {
      new_class.id = (_.max(_.map(this.classes, 'id')) ?? -1) + 1;
      this.classes.push(new_class);
      this.classes_unsaved_changes = true;
      return new_class.id;
    },
    removeClass(this: State, classId: number) {
      this.classes = this.classes.filter((c: Category) => c.id !== classId);
      this.classes_unsaved_changes = true;
    },
    restoreDefaultClasses(this: State) {
      this.classes = assignIds(createMissingParents(defaultCategories));
      this.classes_unsaved_changes = true;
      this.replace_v2_rules_on_save = true;
    },
    clearAll(this: State) {
      this.classes = [];
      this.classes_unsaved_changes = true;
      this.pending_v2_edits = [];
      this.pending_v2_sources = null;
      this._rules_v2_dirty_sections = [];
      this.replace_v2_rules_on_save = false;
      this.editable_category_set_id = null;
    },
  },
});
