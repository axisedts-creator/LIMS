import { CodeBlock } from './CodeBlock';

export default { title: 'Data/CodeBlock', component: CodeBlock };

export const Default = { args: { label: 'Agent log', value: 'line1\nline2' } };
export const ControlChars = {
  args: { label: 'Raw message', value: '\x02H|\\^&\x03\rP|1', renderControlChars: true, allowCopy: false, caption: 'Viewing raw messages is recorded.' },
};
