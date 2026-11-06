import { useState } from 'react';
import { FormulaEditor } from './FormulaEditor';

export default { title: 'Fields/FormulaEditor', component: FormulaEditor };

export const Default = {
  render: () => {
    const [v, setV] = useState('MCV / RBC');
    return <FormulaEditor label="Formula" name="formula" maxLength={500} value={v} onChange={setV} />;
  },
};
export const WithDiagnostics = {
  render: () => <FormulaEditor label="Formula" name="formula" maxLength={500} value="A+B" diagnostics={[{ message: 'Unknown analyte B', position: 2 }]} />,
};
