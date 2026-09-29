import { defineStore } from 'pinia';
import moment, { Moment } from 'moment';
import { getClient } from '~/util/awclient';
import { Category, defaultCategories, cleanCategory } from '~/util/classes';
import { SavedQuery } from '~/util/savedQueries';
import { View, defaultViews } from '~/stores/views';
import type { PrivacyFilterRule } from '~/util/privacyFilters';
import { isEqual } from 'lodash';
import { AppLocale, i18n, isAppLocale, setAppLocale } from '~/i18n';
import {
  collectRuleSourceIds,
  applyRulesSimplification,
  categorySetToLegacyClasses,
  migrateLegacyCategorySets,
  migrateLegacySettings,
  initializeProfileSourceDefaults,
  resolveRulesV2Settings,
  inferRulesEditorMode,
  getLegacyWindowMode,
  selectedCategorySet,
  validateCategorySet,
  validateProfileRulesV2,
  type ActivityProfileV2,
  type CategorySetV2,
  type CompiledProfileQueryOptions,
  type CompiledActivityQueryV2,
  type RuleExpressionV2,
  type RulesEditorMode,
  type SourceDefinitionV2,
  mergeSourceDefinitionChanges,
} from '~/util/rulesV2';
import { compileActivityQueryV2, compileProfileQueryOptions } from '~/util/rulesV2Compilation';
import { deleteCategoryRuleV2, updateCategoryRuleV2 } from '~/util/rulesV2Editor';
import { useServerStore } from '~/stores/server';

function jsonEq(a: any, b: any) {
  const jsonA = JSON.parse(JSON.stringify(a));
  const jsonB = JSON.parse(JSON.stringify(b));
  return isEqual(jsonA, jsonB);
}

interface LegacyCategorySet {
  id: string;
  categories: Category[];
}

interface RulesV2Envelope {
  revision: number;
  activity_profiles_v2: ActivityProfileV2[];
  category_sets_v2: CategorySetV2[];
}

function isNotFound(error: unknown): boolean {
  return (error as { response?: { status?: number } })?.response?.status === 404;
}

function errorMessage(error: unknown): string {
  const responseMessage = (error as { response?: { data?: { message?: unknown } } })?.response?.data
    ?.message;
  return typeof responseMessage === 'string'
    ? responseMessage
    : error instanceof Error
    ? error.message
    : String(error);
}

function recoverableRulesRevision(value: unknown): number {
  const revision = (value as { revision?: unknown } | null)?.revision;
  return Number.isSafeInteger(revision) && (revision as number) >= 0 ? (revision as number) : 0;
}

function parseRulesEnvelope(value: unknown): RulesV2Envelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('rules_v2 must be an object');
  }
  const envelope = value as Partial<RulesV2Envelope>;
  if (!Number.isSafeInteger(envelope.revision) || (envelope.revision as number) < 1) {
    throw new Error('rules_v2.revision must be a positive safe integer');
  }
  if (!Array.isArray(envelope.activity_profiles_v2)) {
    throw new Error('rules_v2.activity_profiles_v2 must be an array');
  }
  if (!Array.isArray(envelope.category_sets_v2)) {
    throw new Error('rules_v2.category_sets_v2 must be an array');
  }
  return JSON.parse(JSON.stringify(envelope)) as RulesV2Envelope;
}

function resolveRulesState(state: State) {
  return resolveRulesV2Settings({
    activity_profiles_v2: state.activity_profiles_v2,
    category_sets_v2: state.category_sets_v2,
    classes: state.classes,
    always_active_pattern: state.always_active_pattern,
    authoritative: state._rulesV2Revision > 0,
  });
}

function safeRulesFallback(state: State) {
  const legacyInput = {
    classes: Array.isArray(state.classes) ? state.classes : defaultCategories,
    always_active_pattern:
      typeof state.always_active_pattern === 'string' ? state.always_active_pattern : '',
  };
  try {
    return { ...migrateLegacySettings(legacyInput), migrated: true };
  } catch (error) {
    console.error('Unable to use the stored legacy rules for recovery', error);
    return {
      ...migrateLegacySettings({ classes: defaultCategories, always_active_pattern: '' }),
      migrated: true,
    };
  }
}

function currentRulesDiagnostics(state: State): string[] {
  try {
    const rules = resolveRulesState(state);
    const profile = rules.activity_profiles_v2[0];
    if (!profile) return ['No activity profile is available'];
    return validateProfileRulesV2(profile, rules.category_sets_v2);
  } catch (error) {
    return [
      `Stored flexible-rules settings could not be loaded: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ];
  }
}

// Legacy settings are compatibility projections only. Every predecessor set is
// derived from canonical v2 data so inactive definitions survive old-client use.
function projectCanonicalRulesForLegacy(
  profile: ActivityProfileV2,
  categorySets: CategorySetV2[]
): {
  classes: Category[];
  always_active_pattern: string;
  category_sets: LegacyCategorySet[];
  active_set_ids: string[];
} {
  const activeSet = categorySets.find(set => set.id === profile.category_set_ids[0]);
  if (!activeSet) throw new Error('The active category set is unavailable');
  const category_sets = categorySets.map(set => ({
    id: set.id,
    categories: categorySetToLegacyClasses(set),
  }));
  const seenNames = new Set<string>();
  const classes = profile.category_set_ids.flatMap(setId => {
    const set = categorySets.find(candidate => candidate.id === setId);
    return (set ? categorySetToLegacyClasses(set) : []).filter(category => {
      const key = JSON.stringify(category.name);
      if (seenNames.has(key)) return false;
      seenNames.add(key);
      return true;
    });
  });
  return {
    classes,
    // An expression has no faithful legacy equivalent. An empty pattern is the
    // safe projection; retaining a previous regex would make old clients apply
    // active time that the canonical profile no longer requests.
    always_active_pattern:
      profile.active_time.type === 'legacy' ? profile.active_time.always_active_pattern : '',
    category_sets,
    active_set_ids: [...profile.category_set_ids],
  };
}

const RULE_SETTING_KEYS = new Set([
  'rules_v2',
  'activity_profiles_v2',
  'category_sets_v2',
  'classes',
  'always_active_pattern',
  // Compatibility projections are server-owned and must never be written by
  // the generic preference loop.
  'category_sets',
  'active_set_ids',
]);

let settingsLoadPromise: Promise<void> | null = null;

// Backoffs for NewReleaseNotification
export const SHORT_BACKOFF_PERIOD = 24 * 60 * 60;
export const LONG_BACKOFF_PERIOD = 5 * 24 * 60 * 60;

// Initial wait period for UserSatisfactionPoll
export const INITIAL_WAIT_PERIOD = 7 * 24 * 60 * 60;

interface State {
  // Timestamp when user was first seen (first time webapp is run)
  initialTimestamp: Moment;

  startOfDay: string;
  startOfWeek: string;
  durationDefault: number;
  useColorFallback: boolean;
  landingpage: string;
  theme: 'light' | 'dark' | 'auto';
  locale: string;

  newReleaseCheckData: Record<string, any>;
  userSatisfactionPollData: {
    isEnabled: boolean;
    nextPollTime: Moment;
    timesPollIsShown: number;
  };
  uncategorizedNotificationData: {
    isEnabled: boolean;
    // Below this total tracked duration (seconds) the hint is hidden —
    // avoids nagging on quiet days.
    minTotalSeconds: number;
    // Hint shows when the uncategorized fraction crosses this ratio.
    minRatio: number;
  };
  always_active_pattern: string;
  privacy_filters: PrivacyFilterRule[];
  classes: Category[];
  activity_profiles_v2: ActivityProfileV2[] | null;
  category_sets_v2: CategorySetV2[] | null;
  rules_editor_mode: RulesEditorMode | null;
  views: View[];
  saved_queries: SavedQuery[];

  // Whether to show certain WIP features
  devmode: boolean;
  showYearly: boolean;
  useMultidevice: boolean;
  requestTimeout: number;

  // Set to true if settings loaded
  _loaded: boolean;
  // Parse/shape errors captured before load falls back to a safe migrated model.
  _rulesV2LoadErrors: string[];
  // While recovering, generic preference saves must not persist the derived model
  // over the original canonical or predecessor rule documents.
  _rulesV2RecoveryActive: boolean;
  // Revision 0 means the canonical document is absent and the in-memory model
  // was migrated from predecessor settings.
  _rulesV2Revision: number;
  // Exact server response retained for recovery export; never written by a
  // generic preference save.
  _rulesV2RawDocument: unknown | null;
  _rulesV2Conflict: string;
}

export const useSettingsStore = defineStore('settings', {
  state: (): State => ({
    initialTimestamp: moment(),

    startOfDay: '04:00',
    startOfWeek: 'Monday',
    durationDefault: 4 * 60 * 60,
    useColorFallback: false,
    landingpage: '/home',

    theme: 'auto',
    locale: 'en',

    newReleaseCheckData: {
      isEnabled: true,
      nextCheckTime: moment().add(SHORT_BACKOFF_PERIOD, 'seconds'),
      howOftenToCheck: SHORT_BACKOFF_PERIOD,
      timesChecked: 0,
    },
    userSatisfactionPollData: {
      isEnabled: true,
      nextPollTime: moment().add(INITIAL_WAIT_PERIOD, 'seconds'),
      timesPollIsShown: 0,
    },
    uncategorizedNotificationData: {
      isEnabled: true,
      minTotalSeconds: 60 * 60, // 1 hour
      minRatio: 0.3, // 30%
    },

    always_active_pattern: '',
    privacy_filters: [],
    classes: defaultCategories,
    activity_profiles_v2: null,
    category_sets_v2: null,
    rules_editor_mode: null,
    views: defaultViews,
    saved_queries: [],

    // Developer settings
    // NOTE: PRODUCTION might be undefined (in tests, for example)
    devmode: typeof PRODUCTION === 'undefined' ? true : !PRODUCTION,
    showYearly: false,
    useMultidevice: false,
    requestTimeout: 30,

    _loaded: false,
    _rulesV2LoadErrors: [],
    _rulesV2RecoveryActive: false,
    _rulesV2Revision: 0,
    _rulesV2RawDocument: null,
    _rulesV2Conflict: '',
  }),

  getters: {
    loaded(state: State) {
      return state._loaded;
    },
    rulesV2(state: State): {
      activity_profiles_v2: ActivityProfileV2[];
      category_sets_v2: CategorySetV2[];
      migrated: boolean;
    } {
      try {
        return resolveRulesState(state);
      } catch {
        return safeRulesFallback(state);
      }
    },
    invalidRulesV2Diagnostics(state: State): string[] {
      return [...new Set([...state._rulesV2LoadErrors, ...currentRulesDiagnostics(state)])];
    },
    rulesV2RecoveryActive(state: State): boolean {
      return state._rulesV2RecoveryActive;
    },
    rulesV2Revision(state: State): number {
      return state._rulesV2Revision;
    },
    rulesV2Conflict(state: State): string {
      return state._rulesV2Conflict;
    },
    rawRulesV2Document(state: State): unknown | null {
      return state._rulesV2RawDocument;
    },
    rulesEditorMode(): RulesEditorMode {
      const rules = this.rulesV2;
      const profile = rules.activity_profiles_v2[0];
      const categorySet = selectedCategorySet(profile, rules.category_sets_v2);
      return (
        this.rules_editor_mode ??
        inferRulesEditorMode(profile, categorySet ?? rules.category_sets_v2[0])
      );
    },
    hasAdvancedRulesV2(): boolean {
      const rules = this.rulesV2;
      const profile = rules.activity_profiles_v2[0];
      const categorySet = profile
        ? selectedCategorySet(profile, rules.category_sets_v2)
        : undefined;
      return (
        !!profile && !!categorySet && inferRulesEditorMode(profile, categorySet) === 'advanced'
      );
    },
    compiledLegacyTargetOptions(): CompiledProfileQueryOptions | undefined {
      if (this.invalidRulesV2Diagnostics.length > 0) return undefined;
      const rules = this.rulesV2;
      const profile = rules.activity_profiles_v2[0];
      const categorySet = profile
        ? selectedCategorySet(profile, rules.category_sets_v2)
        : undefined;
      const capabilities = useServerStore().info?.capabilities ?? [];
      if (!profile || !categorySet || !capabilities.includes('query.categorize_v2.v1')) {
        return undefined;
      }
      const categorySourceIds = new Set(
        categorySet.categories.flatMap(category => [...collectRuleSourceIds(category.rule)])
      );
      if (
        profile.sources.some(
          source =>
            source.builtin !== 'window' &&
            (categorySourceIds.has(source.id) ||
              (source.creates_activity && source.builtin !== 'stopwatch'))
        ) &&
        !capabilities.includes('query.merge_subwatcher_fields.source_namespace.v1')
      ) {
        return undefined;
      }
      if (
        getLegacyWindowMode(profile, categorySet) === 'context' &&
        !capabilities.includes('query.merge_subwatcher_fields.source_namespace.v1')
      ) {
        return undefined;
      }
      if (
        profile.active_time.type === 'expression' &&
        !capabilities.includes('query.active_periods_v2.v1')
      ) {
        return undefined;
      }
      try {
        return compileProfileQueryOptions(profile, rules.category_sets_v2, capabilities);
      } catch (error) {
        console.error('Unable to compile flexible rules', error);
        return undefined;
      }
    },
    // Current source-only compiled options. The configured window is an ordinary
    // namespaced source and no legacy window mode is carried into this pipeline.
    compiledActivityQueryV2(): CompiledActivityQueryV2 | undefined {
      if (this.invalidRulesV2Diagnostics.length > 0) return undefined;
      const rules = this.rulesV2;
      const profile = rules.activity_profiles_v2[0];
      const categorySet = profile
        ? selectedCategorySet(profile, rules.category_sets_v2)
        : undefined;
      const capabilities = useServerStore().info?.capabilities ?? [];
      if (
        !profile ||
        !categorySet ||
        ![
          'query.categorize_v2.v1',
          'query.query_bucket_optional_raw.v1',
          'query.query_period.v1',
          'query.flood_v2.v1',
        ].every(capability => capabilities.includes(capability))
      ) {
        return undefined;
      }
      const usesNamespace =
        profile.sources.some(source => source.creates_activity || source.builtin === 'window') ||
        !!profile.app_title_source_id ||
        !!profile.browser_focus_source_id ||
        categorySet.categories.some(
          category => collectRuleSourceIds(category.rule).size > 0 || category.rule.type !== 'none'
        );
      if (
        usesNamespace &&
        !capabilities.includes('query.merge_subwatcher_fields.source_namespace.v1')
      ) {
        return undefined;
      }
      if (!capabilities.includes('query.active_periods_v2.v1')) {
        return undefined;
      }
      try {
        return compileActivityQueryV2(profile, rules.category_sets_v2, capabilities);
      } catch (error) {
        console.error('Unable to compile flexible activity rules', error);
        return undefined;
      }
    },
    activityV2Unsupported(): boolean {
      const rules = this.rulesV2;
      if (
        !useServerStore().info ||
        this.invalidRulesV2Diagnostics.length > 0 ||
        !rules.activity_profiles_v2[0] ||
        !rules.category_sets_v2[0]
      ) {
        return false;
      }
      return !this.compiledActivityQueryV2;
    },
  },

  actions: {
    async ensureLoaded() {
      if (this.loaded) {
        return;
      }

      if (!settingsLoadPromise) {
        settingsLoadPromise = this.load().finally(() => {
          settingsLoadPromise = null;
        });
      }

      await settingsLoadPromise;
    },
    async load() {
      if (typeof localStorage === 'undefined') {
        console.error('localStorage is not supported');
        return;
      }
      const client = getClient();

      // Fetch from server, fall back to localStorage
      const server_settings = await client.get_settings();
      const legacyServerSettings = server_settings as Record<string, unknown>;
      const loadErrors: string[] = [];
      let rulesRevision = 0;
      let rawRulesDocument: unknown | null = null;

      // Build a unified map: server value wins, localStorage is fallback.
      // Skip keys that are missing from BOTH sources — otherwise `null` from
      // localStorage.getItem overrides the defaults defined in `state()`.
      const storage: Record<string, unknown> = {};
      const used = new Set<string>();
      const stateKeys = new Set(Object.keys(this.$state));

      // 1. Server settings take priority
      for (const key of Object.keys(server_settings)) {
        if (key.startsWith('_') || !stateKeys.has(key)) continue;
        if (key === 'locale' && !isAppLocale(server_settings[key])) {
          console.warn('Ignoring invalid locale from server:', server_settings[key]);
          continue;
        }
        storage[key] = server_settings[key];
        used.add(key);
      }

      // 2. localStorage fills in gaps, but skip missing keys (null)
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith('_') || used.has(key) || !stateKeys.has(key)) continue;
        const raw = localStorage.getItem(key);
        if (raw === null || raw === 'null') continue; // key absent or stored as null → keep state() default

        // Keys ending with 'Data' are JSON-serialized objects in localStorage
        const isJsonKey =
          key.endsWith('Data') ||
          key == 'views' ||
          key == 'classes' ||
          key == 'activity_profiles_v2' ||
          key == 'category_sets_v2' ||
          key == 'saved_queries';
        try {
          if (isJsonKey) {
            let parsed = JSON.parse(raw);
            if (key == 'classes') {
              parsed = parsed.map(cleanCategory);
            }
            storage[key] = parsed;
          } else if (raw === 'true' || raw === 'false') {
            storage[key] = raw === 'true';
          } else if (key === 'locale') {
            if (isAppLocale(raw)) {
              storage[key] = raw;
            } else {
              console.warn('Ignoring invalid locale from storage:', raw);
            }
          } else {
            storage[key] = raw;
          }
        } catch (e) {
          console.error('failed to parse', key, raw, e);
        }
      }

      // The revisioned envelope is authoritative when present. GET-all may
      // contain derived projections, but those must never outrank this document.
      // Never probe an old arbitrary-key endpoint: it could return null with 200
      // and does not provide CAS semantics.
      const applyEnvelope = (raw: unknown) => {
        rawRulesDocument = JSON.parse(JSON.stringify(raw));
        // The CAS token remains usable even when the rest of a historical or
        // forward document cannot be interpreted. Explicit recovery reset/import
        // must use this revision rather than becoming stuck at expected 0.
        rulesRevision = recoverableRulesRevision(raw);
        const envelope = parseRulesEnvelope(raw);
        rulesRevision = envelope.revision;
        storage.activity_profiles_v2 = envelope.activity_profiles_v2;
        storage.category_sets_v2 = envelope.category_sets_v2;
      };
      if (legacyServerSettings.rules_v2 !== undefined) {
        try {
          applyEnvelope(legacyServerSettings.rules_v2);
        } catch (error) {
          loadErrors.push(
            `Stored flexible-rules settings could not be loaded: ${errorMessage(error)}`
          );
        }
      } else {
        const supportsRulesEnvelope =
          useServerStore().info?.capabilities?.includes('settings.rules_v2.v1') ?? false;
        if (supportsRulesEnvelope && typeof client.req.get === 'function') {
          try {
            const response = await client.req.get('/0/settings/rules_v2');
            applyEnvelope(response.data);
          } catch (error) {
            if (!isNotFound(error)) {
              rawRulesDocument =
                (error as { response?: { data?: unknown } })?.response?.data ?? rawRulesDocument;
              loadErrors.push(
                `Stored flexible-rules settings could not be loaded: ${errorMessage(error)}`
              );
            }
          }
        }
      }

      if (storage.category_sets_v2 == null) {
        const legacySetsRaw =
          legacyServerSettings.category_sets ??
          (() => {
            const raw = localStorage.getItem('category_sets');
            if (!raw || raw === 'null') return null;
            try {
              return JSON.parse(raw);
            } catch (error) {
              console.error('failed to parse category_sets', raw, error);
              return null;
            }
          })();
        const legacyActiveIdsRaw =
          legacyServerSettings.active_set_ids ??
          (() => {
            const raw = localStorage.getItem('active_set_ids');
            if (!raw || raw === 'null') return null;
            try {
              return JSON.parse(raw);
            } catch (error) {
              console.error('failed to parse active_set_ids', raw, error);
              return null;
            }
          })();
        if (Array.isArray(legacySetsRaw) && legacySetsRaw.length > 0) {
          try {
            const legacySets: Array<{ id: string; categories: Category[] }> = legacySetsRaw
              .filter(
                set =>
                  set &&
                  typeof set.id === 'string' &&
                  set.id.length > 0 &&
                  Array.isArray(set.categories)
              )
              .map(set => ({
                id: set.id as string,
                categories: set.categories.map(cleanCategory),
              }));
            if (legacySets.length > 0) {
              const activeIds = Array.isArray(legacyActiveIdsRaw)
                ? legacyActiveIdsRaw.filter((id): id is string => typeof id === 'string')
                : [];
              const migratedSets = migrateLegacyCategorySets(legacySets, activeIds);
              storage.category_sets_v2 = migratedSets.categorySets;
              if (storage.activity_profiles_v2 == null) {
                const migrated = migrateLegacySettings({
                  classes: (storage.classes as Category[] | undefined) ?? this.classes,
                  always_active_pattern:
                    (storage.always_active_pattern as string | undefined) ??
                    this.always_active_pattern,
                });
                storage.activity_profiles_v2 = [
                  {
                    ...migrated.activity_profiles_v2[0],
                    category_set_ids: migratedSets.activeSetIds,
                  },
                ];
              }
            }
          } catch (error) {
            loadErrors.push(
              `Stored flexible-rules settings could not be loaded: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
        }
      }
      // Predecessor documents may need one-time in-memory source defaults.
      // A revisioned canonical envelope is authoritative even when it has no
      // defaults marker: loading it must never add or reinterpret sources.
      if (rulesRevision === 0 && Array.isArray(storage.activity_profiles_v2)) {
        try {
          storage.activity_profiles_v2 = initializeProfileSourceDefaults(
            storage.activity_profiles_v2 as ActivityProfileV2[]
          );
        } catch (error) {
          loadErrors.push(
            `Stored flexible-rules settings could not be loaded: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
      this.$patch({
        ...storage,
        _loaded: true,
        _rulesV2LoadErrors: [],
        _rulesV2Revision: rulesRevision,
        _rulesV2RawDocument: rawRulesDocument,
        _rulesV2Conflict: '',
      });

      let canonicalSettings:
        | {
            activity_profiles_v2: ActivityProfileV2[];
            category_sets_v2: CategorySetV2[];
            classes: Category[];
            always_active_pattern: string;
          }
        | undefined;
      if (loadErrors.length === 0) {
        try {
          const resolvedRules = resolveRulesState(this.$state);
          const validationErrors = [
            ...resolvedRules.category_sets_v2.flatMap((set, index) =>
              validateCategorySet(set).map(error => `category_sets_v2[${index}]: ${error}`)
            ),
            ...resolvedRules.activity_profiles_v2.flatMap((profile, index) =>
              validateProfileRulesV2(profile, resolvedRules.category_sets_v2).map(
                error => `activity_profiles_v2[${index}]: ${error}`
              )
            ),
          ];
          if (validationErrors.length > 0) {
            throw new Error(validationErrors.join('; '));
          }
          const canonicalProfile = resolvedRules.activity_profiles_v2[0];
          const legacyProjection = projectCanonicalRulesForLegacy(
            canonicalProfile,
            resolvedRules.category_sets_v2
          );
          canonicalSettings = {
            activity_profiles_v2: resolvedRules.activity_profiles_v2,
            category_sets_v2: resolvedRules.category_sets_v2,
            classes: legacyProjection.classes,
            always_active_pattern: legacyProjection.always_active_pattern,
          };
        } catch (error) {
          loadErrors.push(
            `Stored flexible-rules settings could not be loaded: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
      if (!canonicalSettings) {
        const fallback = safeRulesFallback(this.$state);
        const profile = fallback.activity_profiles_v2[0];
        const legacyProjection = projectCanonicalRulesForLegacy(profile, fallback.category_sets_v2);
        canonicalSettings = {
          activity_profiles_v2: fallback.activity_profiles_v2,
          category_sets_v2: fallback.category_sets_v2,
          classes: legacyProjection.classes,
          always_active_pattern: legacyProjection.always_active_pattern,
        };
      }
      if (loadErrors.length > 0 && rawRulesDocument === null) {
        rawRulesDocument = Object.fromEntries(
          [...RULE_SETTING_KEYS]
            .filter(key => key !== 'rules_v2' && legacyServerSettings[key] !== undefined)
            .map(key => [key, JSON.parse(JSON.stringify(legacyServerSettings[key]))])
        );
      }
      this.$patch({
        ...canonicalSettings,
        _rulesV2LoadErrors: [...new Set(loadErrors)],
        _rulesV2RecoveryActive: loadErrors.length > 0,
        _rulesV2Revision: rulesRevision,
        _rulesV2RawDocument: rawRulesDocument,
      });

      const localeFromServer = 'locale' in server_settings;
      const localeFromLocalStorage = localStorage.getItem('locale') != null;

      if ((localeFromServer || localeFromLocalStorage) && isAppLocale(this.locale)) {
        setAppLocale(this.locale);
      } else if (isAppLocale(i18n.locale)) {
        this.$patch({ locale: i18n.locale as AppLocale });
      }

      // Since `requestTimeout` is used to initialize the client, we need to set it again
      // https://github.com/ActivityWatch/activitywatch/issues/979
      client.req.defaults.timeout = this.requestTimeout * 1000;
    },
    async save() {
      // Important check, to avoid saving settings before they are loaded (potentially overwriting them with defaults)
      if (!this.loaded) {
        console.error('Settings not loaded, not saving');
        return;
      }
      // We want to avoid saving to localStorage to not accidentally mess up pre-migration data
      // For example, if the user is using several browsers, and opened in their non-main browser on first run after upgrade.
      const saveToLocalStorage = false;

      // Save to localStorage and backend
      // NOTE: localStorage deprecated, will be removed in future
      const client = getClient();

      // Fetch current settings from server
      const server_settings = await client.get_settings();

      // Save settings
      for (const key of Object.keys(this.$state)) {
        // Skip keys starting with underscore, as they are local to the vuex store.
        if (key.startsWith('_')) {
          continue;
        }
        // Canonical rules and every compatibility projection are server-owned.
        // Rule edits use exactly one revisioned rules_v2 CAS request below;
        // ordinary preference saves never write either representation.
        if (RULE_SETTING_KEYS.has(key)) continue;

        const value = this.$state[key];
        if (
          value === null &&
          server_settings[key] === undefined &&
          (key === 'activity_profiles_v2' || key === 'category_sets_v2')
        ) {
          continue;
        }

        // Save to localStorage
        // NOTE: we always save the theme and landingpage to localStorage, since they are used before the settings are loaded
        if (saveToLocalStorage || key == 'theme' || key == 'landingpage') {
          if (typeof value === 'object') {
            localStorage.setItem(key, JSON.stringify(value));
          } else {
            localStorage.setItem(key, value);
          }
        }

        // Save changed settings to backend
        if (server_settings[key] === undefined || !jsonEq(server_settings[key], value)) {
          if (server_settings[key] === undefined && value === false) {
            // Skip saving settings that are set to false and not already saved on the server
            continue;
          }
          await client.req.post('/0/settings/' + key, value, {
            headers: {
              'Content-Type': 'application/json',
            },
          });
        }
      }

      // Keep local drafts and conflict state intact. The values just persisted
      // already live in this store; a full reload here could erase editor work.
    },
    async update(new_state: Record<string, any>) {
      await this.ensureLoaded();
      this.$patch(new_state);
      await this.save();
    },
    async saveCanonicalRulesV2(input: {
      profiles: ActivityProfileV2[];
      categorySets: CategorySetV2[];
      extra?: Record<string, unknown>;
      /** Required to replace a malformed/forward-version document in recovery mode. */
      recoveryReplacement?: boolean;
    }) {
      if (this._rulesV2RecoveryActive && !input.recoveryReplacement) {
        throw new Error(
          'Stored rules are in recovery mode. Export them, then use explicit import or reset to replace them.'
        );
      }
      const profile = input.profiles[0];
      if (
        !profile ||
        !Array.isArray(profile.category_set_ids) ||
        profile.category_set_ids.length === 0
      ) {
        throw new Error(
          'activity_profiles_v2[0].category_set_ids must be a non-empty string array'
        );
      }
      let errors: string[];
      try {
        errors = [
          ...input.categorySets.flatMap((set, index) =>
            validateCategorySet(set).map(error => `category_sets_v2[${index}]: ${error}`)
          ),
          ...input.profiles.flatMap((candidate, index) =>
            validateProfileRulesV2(candidate, input.categorySets).map(
              error => `activity_profiles_v2[${index}]: ${error}`
            )
          ),
        ];
      } catch (error) {
        throw new Error(`Canonical rules are malformed: ${errorMessage(error)}`);
      }
      if (errors.length > 0) throw new Error(errors.join('\n'));

      const serverInfo = useServerStore().info;
      if (serverInfo && !serverInfo.capabilities?.includes('settings.rules_v2.v1')) {
        throw new Error('This server does not support revisioned rules_v2 settings');
      }
      const request: RulesV2Envelope = {
        revision: this._rulesV2Revision,
        activity_profiles_v2: JSON.parse(JSON.stringify(input.profiles)),
        category_sets_v2: JSON.parse(JSON.stringify(input.categorySets)),
      };
      const client = getClient();
      let stored: RulesV2Envelope;
      try {
        const response = await client.req.post('/0/settings/rules_v2', request, {
          headers: { 'Content-Type': 'application/json' },
        });
        stored = parseRulesEnvelope(response.data);
      } catch (error) {
        if ((error as { response?: { status?: number } })?.response?.status === 409) {
          const message = `Rules were changed by another client. Your draft was kept. ${errorMessage(
            error
          )}`;
          this.$patch({ _rulesV2Conflict: message });
          throw new Error(message);
        }
        throw new Error(errorMessage(error));
      }

      const storedProfile = stored.activity_profiles_v2[0];
      const projection = projectCanonicalRulesForLegacy(storedProfile, stored.category_sets_v2);
      this.$patch({
        ...input.extra,
        activity_profiles_v2: stored.activity_profiles_v2,
        category_sets_v2: stored.category_sets_v2,
        classes: projection.classes,
        always_active_pattern: projection.always_active_pattern,
        _rulesV2Revision: stored.revision,
        _rulesV2RawDocument: stored,
        _rulesV2LoadErrors: [],
        _rulesV2RecoveryActive: false,
        _rulesV2Conflict: '',
      });
    },
    async rebaseRulesV2DraftForOverwrite() {
      if (!this._rulesV2Conflict) {
        throw new Error('There is no rules_v2 conflict to resolve');
      }
      const client = getClient();
      const response = await client.req.get('/0/settings/rules_v2');
      const serverEnvelope = parseRulesEnvelope(response.data);
      // Deliberately retain the local canonical snapshot and all editor drafts.
      // The caller has confirmed that the next save may overwrite intervening
      // server changes; only its CAS base revision is rebased.
      this.$patch({
        _rulesV2Revision: serverEnvelope.revision,
        _rulesV2Conflict: '',
      });
    },
    async replaceRulesV2WithDefaults() {
      const defaults = migrateLegacySettings({
        classes: defaultCategories,
        always_active_pattern: '',
        include_audible: true,
      });
      await this.saveCanonicalRulesV2({
        profiles: defaults.activity_profiles_v2,
        categorySets: defaults.category_sets_v2,
        extra: { rules_editor_mode: 'simple' },
        recoveryReplacement: true,
      });
    },
    async setRulesEditorMode(mode: RulesEditorMode) {
      await this.update({ rules_editor_mode: mode });
    },
    async simplifyRulesV2() {
      await this.ensureLoaded();
      const rules = this.rulesV2;
      const profile = rules.activity_profiles_v2[0];
      const categorySet = selectedCategorySet(profile, rules.category_sets_v2);
      if (!categorySet) throw new Error('The selected category set is unavailable');
      const simplified = applyRulesSimplification({
        profile,
        categorySet,
        always_active_pattern:
          profile.active_time.type === 'legacy' ? profile.active_time.always_active_pattern : '',
      });
      const simplifiedProfile = simplified.activity_profiles_v2[0];
      const simplifiedSet = simplified.category_sets_v2[0];
      await this.saveCanonicalRulesV2({
        profiles: rules.activity_profiles_v2.map(candidate =>
          candidate.id === profile.id ? simplifiedProfile : candidate
        ),
        categorySets: rules.category_sets_v2.map(candidate =>
          candidate.id === simplifiedSet.id ? simplifiedSet : candidate
        ),
        extra: { rules_editor_mode: 'simple' },
      });
    },
    async setActiveCategorySetsV2(categorySetIds: string[]) {
      await this.ensureLoaded();
      const rules = this.rulesV2;
      const knownIds = new Set(rules.category_sets_v2.map(set => set.id));
      const selected = [...new Set(categorySetIds)].filter(id => knownIds.has(id));
      if (selected.length === 0) throw new Error('Select at least one category set');
      const profiles: ActivityProfileV2[] = JSON.parse(JSON.stringify(rules.activity_profiles_v2));
      profiles[0].category_set_ids = selected;
      await this.saveCanonicalRulesV2({
        profiles,
        categorySets: rules.category_sets_v2,
        ...(selected.length > 1 ? { extra: { rules_editor_mode: 'advanced' } } : {}),
      });
    },
    async saveCategoryRuleV2(input: {
      categoryId?: string;
      originalName: string[];
      name: string[];
      rule: RuleExpressionV2;
      priority: number;
      requires: string[];
    }) {
      await this.ensureLoaded();
      const rules = this.rulesV2;
      const updated = updateCategoryRuleV2({
        profileId: rules.activity_profiles_v2[0]?.id ?? 'default',
        profiles: rules.activity_profiles_v2,
        categorySets: rules.category_sets_v2,
        ...input,
      });
      const errors = [
        ...updated.categorySets.flatMap(validateCategorySet),
        ...updated.profiles.flatMap(profile =>
          validateProfileRulesV2(profile, updated.categorySets)
        ),
      ];
      if (errors.length > 0) throw new Error(errors.join('\n'));
      await this.saveCanonicalRulesV2({
        profiles: updated.profiles,
        categorySets: updated.categorySets,
      });
    },
    async deleteCategoryRuleV2(name: string[], categoryId?: string) {
      await this.ensureLoaded();
      const rules = this.rulesV2;
      const updated = deleteCategoryRuleV2({
        profileId: rules.activity_profiles_v2[0]?.id ?? 'default',
        profiles: rules.activity_profiles_v2,
        categorySets: rules.category_sets_v2,
        categoryId,
        name,
      });
      const errors = updated.profiles.flatMap(profile =>
        validateProfileRulesV2(profile, updated.categorySets)
      );
      if (errors.length > 0) throw new Error(errors.join('\n'));
      await this.saveCanonicalRulesV2({
        profiles: updated.profiles,
        categorySets: updated.categorySets,
      });
    },
    async saveActiveTimeRuleV2(
      rule: RuleExpressionV2,
      sources?: SourceDefinitionV2[],
      baselineSources?: SourceDefinitionV2[]
    ) {
      await this.ensureLoaded();
      const rules = this.rulesV2;
      const profiles: ActivityProfileV2[] = JSON.parse(JSON.stringify(rules.activity_profiles_v2));
      const profile = profiles[0];
      if (!profile) throw new Error('No activity profile is available');
      if (sources) {
        profile.sources = mergeSourceDefinitionChanges(
          profile.sources,
          sources,
          baselineSources ?? profile.sources
        );
      }
      profile.active_time = { type: 'expression', rule: JSON.parse(JSON.stringify(rule)) };
      const errors = validateProfileRulesV2(profile, rules.category_sets_v2);
      if (errors.length > 0) throw new Error(errors.join('\n'));
      await this.saveCanonicalRulesV2({
        profiles,
        categorySets: rules.category_sets_v2,
      });
    },
    async saveRuleSourcesV2(sources: SourceDefinitionV2[]) {
      await this.ensureLoaded();
      const rules = this.rulesV2;
      const profiles: ActivityProfileV2[] = JSON.parse(JSON.stringify(rules.activity_profiles_v2));
      const profile = profiles[0];
      if (!profile) throw new Error('No activity profile is available');
      profile.sources = JSON.parse(JSON.stringify(sources));
      const errors = validateProfileRulesV2(profile, rules.category_sets_v2);
      if (errors.length > 0) throw new Error(errors.join('\n'));
      await this.saveCanonicalRulesV2({
        profiles,
        categorySets: rules.category_sets_v2,
      });
    },
    async saveLegacyActiveTimeV2(alwaysActivePattern = this.always_active_pattern) {
      await this.ensureLoaded();
      const rules = this.rulesV2;
      const profiles: ActivityProfileV2[] = JSON.parse(JSON.stringify(rules.activity_profiles_v2));
      const profile = profiles[0];
      if (!profile) throw new Error('No activity profile is available');
      const currentLegacy = profile.active_time.type === 'legacy' ? profile.active_time : undefined;
      profile.active_time = {
        type: 'legacy',
        use_afk: currentLegacy?.use_afk ?? true,
        include_audible: currentLegacy?.include_audible ?? true,
        always_active_pattern: alwaysActivePattern,
      };
      await this.saveCanonicalRulesV2({
        profiles,
        categorySets: rules.category_sets_v2,
      });
    },
    async useLegacyActiveTimeV2() {
      await this.saveLegacyActiveTimeV2();
    },
  },
});
