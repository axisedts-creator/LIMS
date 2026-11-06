import { CodeBlock } from './CodeBlock';

export default { title: 'Data/CodeBlock', component: CodeBlock };

export const Default = { args: { label: 'Agent log', text: 'line1\nline2', allowCopy: true } };
export const ControlChars = {
  args: { label: 'Raw message', text: '\x02H|\\^&\x03\rP|1', renderControlChars: true, maxHeight: 240 },
};
export const Wrapped = { args: { label: 'Agent log', text: 'a long line '.repeat(30), wrap: true } };
