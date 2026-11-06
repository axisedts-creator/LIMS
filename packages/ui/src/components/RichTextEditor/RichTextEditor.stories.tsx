import { useState } from 'react';
import { RichTextEditor, SafeHtml } from './RichTextEditor';

export default { title: 'Fields/RichTextEditor', component: RichTextEditor };

export const Default = {
  render: () => {
    const [v, setV] = useState('<p>Normal <strong>mucosa</strong>.</p><ul><li>No dysplasia</li></ul>');
    return <RichTextEditor label="Findings" name="findings" maxLength={20000} value={v} onChange={setV} />;
  },
};
export const ReadOnly = { render: () => <RichTextEditor label="Findings" name="findings" maxLength={20000} value="<p>Signed text</p>" isReadOnly /> };
export const SafeHtmlView = { render: () => <SafeHtml html={'<p>Kept <em>marks</em></p><script>dropped()</script><a href="/help">Help</a>'} /> };
