import { Grid } from './Grid';

export default { title: 'Layout/Grid', component: Grid };

export const ThreeColumns = {
  render: () => (
    <Grid columns={3}>
      <p>A</p>
      <p>B</p>
      <p>C</p>
    </Grid>
  ),
};
