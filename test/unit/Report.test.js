import fs from 'fs';
import path from 'path';
import { mount } from '@vue/test-utils';
import Icon from 'vue-awesome/components/Icon.vue';
import 'vue-awesome/icons/save';

describe('Report route icons', () => {
  test('registers and renders the save icon used by export controls', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../src/views/Report.vue'), 'utf8');
    expect(source).toContain("import 'vue-awesome/icons/save';");

    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const wrapper = mount(Icon, { propsData: { name: 'save' } });
    expect(wrapper.findAll('path')).toHaveLength(1);
    expect(error).not.toHaveBeenCalled();
  });
});
