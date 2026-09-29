import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import Vue from 'vue';
import { BootstrapVue } from 'bootstrap-vue';

import SourceDefinitionsEditor from '~/components/SourceDefinitionsEditor.vue';
import { useBucketsStore } from '~/stores/buckets';
import { useServerStore } from '~/stores/server';

Vue.use(BootstrapVue);

describe('SourceDefinitionsEditor interval policy', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    useBucketsStore().buckets = [];
    useServerStore().info = {
      capabilities: [
        'query.merge_subwatcher_fields.source_namespace.v1',
        'query.active_periods_v2.v1',
      ],
    };
  });

  test('shows and persists an explicit exact/heartbeat choice', async () => {
    const source = {
      id: 'calendar',
      label: 'Calendar',
      bucket_ids: ['calendar'],
      scope: 'global',
      fields: ['title'],
      creates_activity: true,
      interval_policy: 'exact',
    };
    const wrapper = mount(SourceDefinitionsEditor, {
      propsData: { value: [source] },
      mocks: { $t: key => key },
    });

    const intervalSelect = wrapper
      .findAll('select')
      .wrappers.find(select => select.find('option[value="heartbeat"]').exists());
    expect(intervalSelect).toBeDefined();
    expect(intervalSelect.element.value).toBe('exact');

    await intervalSelect.setValue('heartbeat');
    expect(wrapper.emitted('input').at(-1)[0][0]).toMatchObject({
      id: 'calendar',
      interval_policy: 'heartbeat',
    });

    wrapper.destroy();
  });

  test('removes stale inferred type metadata when fields are removed', () => {
    const wrapper = mount(SourceDefinitionsEditor, {
      propsData: {
        value: [
          {
            id: 'calendar',
            label: 'Calendar',
            bucket_ids: ['calendar'],
            scope: 'global',
            fields: ['title', 'state'],
            field_types: { title: 'string', state: 'scalar' },
          },
        ],
      },
      mocks: { $t: key => key },
    });

    const updated = wrapper.vm.updatedSource(wrapper.props('value')[0], 'fields', ['title']);
    expect(updated.field_types).toEqual({ title: 'string' });
    expect(updated.auto_generated).toBeUndefined();
    wrapper.destroy();
  });
});
