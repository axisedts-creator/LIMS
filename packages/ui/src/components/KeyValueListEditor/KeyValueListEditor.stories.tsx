import { useState } from 'react';
import { KeyValueListEditor, type KeyValueRow } from './KeyValueListEditor';

export default { title: 'Fields/KeyValueListEditor', component: KeyValueListEditor };

export const Default = {
  render: () => {
    const [v, setV] = useState<KeyValueRow[]>([{ key: 'H', value: 'HIGH' }, { key: 'L', value: 'LOW' }]);
    return <KeyValueListEditor label="Flag map" name="flagMap" value={v} onChange={setV} maxRows={20} keyMaxLength={16} valueMaxLength={64} />;
  },
};
