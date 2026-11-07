import { PageShell } from './PageShell';

export default { title: 'Shell/PageShell', component: PageShell };

export const Default = {
  render: () => (
    <PageShell
      topBar={<span>Synthetic Lab</span>}
      nav={
        <ul>
          <li>
            <a href="#orders">Orders</a>
          </li>
        </ul>
      }
      help={<p>Help text for this page.</p>}
      banner={<p>Support session active</p>}
    >
      <h1>Orders</h1>
    </PageShell>
  ),
};
