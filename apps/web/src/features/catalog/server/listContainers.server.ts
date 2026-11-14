import 'server-only';
import { listOf } from './shared';
import type { Container } from './types';

export const listContainers = listOf<Container>('containers');
