import 'server-only';
import { CONTAINER } from './masters';
import { updateOf } from './shared';
import type { Container } from './types';

export const updateContainer = updateOf<Container>('containers', CONTAINER.patch);
