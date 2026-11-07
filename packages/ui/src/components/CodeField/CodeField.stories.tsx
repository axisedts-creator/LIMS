import { useState } from 'react';
import { CodeField } from './CodeField';

export default { title: 'Fields/CodeField', component: CodeField };

const P = { label: 'Code', name: 'code', maxLength: 32, pattern: '^[A-Z0-9][A-Z0-9_]{0,31}$', patternHint: 'Letters, digits and underscore; starts with a letter or digit' };
export const Default = {
  render: () => {
    const [v, setV] = useState('CBC');
    return <CodeField {...P} value={v} onChange={setV} />;
  },
};
export const ReadOnly = { render: () => <CodeField {...P} value="CBC" isReadOnly /> };
export const WithError = { render: () => <CodeField {...P} value="CBC" error="Code already exists" /> };
