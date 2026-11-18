import { Button } from '../Button/Button';
import { SplitConsole } from './SplitConsole';

export default { title: 'Layout/SplitConsole', component: SplitConsole };

const items = ['S-0001', 'S-0002', 'S-0003'];

export const Default = {
  render: () => (
    <SplitConsole
      listLabel="Verification queue"
      detailLabel="Sample detail"
      list={<ul>{items.map((s) => <li key={s}><button type="button" data-console-item>{s}</button></li>)}</ul>}
      detail={<p>Results for the selected sample.</p>}
      actions={<><Button variant="primary">Approve</Button><Button>Send back</Button></>}
    />
  ),
};
export const EmptyQueue = {
  render: () => <SplitConsole listLabel="Verification queue" detailLabel="Sample detail" list={<p>No samples waiting</p>} detail={<p>Pick a sample.</p>} />,
};
