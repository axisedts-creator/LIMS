import { IconButton } from './IconButton';

export default { title: 'Actions/IconButton', component: IconButton, args: { label: 'Close panel', icon: 'close', onPress: () => {} } };

export const Ghost = {};
export const Secondary = { args: { variant: 'secondary', icon: 'copy', label: 'Copy' } };
