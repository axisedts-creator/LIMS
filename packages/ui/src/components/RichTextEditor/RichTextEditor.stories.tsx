import { useState } from 'react';
import { RichTextEditor, SafeHtml, type RichTextTool } from './RichTextEditor';

export default { title: 'Fields/RichTextEditor', component: RichTextEditor };

const ALL: RichTextTool[] = ['bold', 'italic', 'underline', 'bullet_list', 'ordered_list', 'table', 'h3', 'h4'];

export const Default = {
  render: () => {
    const [v, setV] = useState('<p>Normal <strong>mucosa</strong>.</p><ul><li>No dysplasia</li></ul>');
    return <RichTextEditor label="Findings" name="findings" maxLength={20000} allowed={ALL} value={v} onChange={setV} />;
  },
};
export const ReadOnly = { render: () => <RichTextEditor label="Findings" name="findings" maxLength={20000} allowed={ALL} value="<p>Signed text</p>" isReadOnly /> };
export const SafeHtmlView = {
  render: () => <SafeHtml html={'<h3>Gross</h3><p>Kept <em>marks</em></p><table><tbody><tr><td>cell</td></tr></tbody></table><script>dropped()</script><a href="/help">Help</a>'} />,
};
