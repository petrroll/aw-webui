<template lang="pug">
b-form-tags(
  :value="value"
  @input="$emit('input', $event)"
  add-on-change
  no-outer-focus
)
  template(v-slot="{ tags, inputAttrs, inputHandlers, disabled, removeTag }")
    b-form-select(
      v-bind="inputAttrs"
      v-on="inputHandlers"
      :disabled="disabled || availableOptions.length === 0"
      :options="availableOptions"
      :aria-label="ariaLabel"
      size="sm"
    )
      template(#first)
        option(disabled value="") {{ tags.length > 0 ? addLabel : allLabel }}
    div.mt-1(v-if="tags.length > 0")
      b-form-tag.mr-1.mb-1(
        v-for="tag in tags"
        :key="tag"
        @remove="removeTag(tag)"
        :title="optionText(tag)"
        :disabled="disabled"
        variant="info"
      )
        | {{ optionText(tag) }}
</template>

<script lang="ts">
import Vue from 'vue';

interface FilterOption {
  value: string;
  text: string;
}

export default Vue.extend({
  name: 'TimelineFilterSelect',
  props: {
    value: { type: Array, required: true },
    options: { type: Array, required: true },
    allLabel: { type: String, default: 'All' },
    addLabel: { type: String, default: 'Add another…' },
    ariaLabel: { type: String, default: '' },
  },
  computed: {
    normalizedOptions(): FilterOption[] {
      return (this.options as Array<string | FilterOption>).map(option =>
        typeof option === 'string' ? { value: option, text: option } : option
      );
    },
    availableOptions(): FilterOption[] {
      const selected = new Set(this.value as string[]);
      return this.normalizedOptions.filter(option => !selected.has(option.value));
    },
  },
  methods: {
    optionText(value: string): string {
      return this.normalizedOptions.find(option => option.value === value)?.text ?? value;
    },
  },
});
</script>
