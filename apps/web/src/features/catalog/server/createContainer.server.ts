import 'server-only';
import { CONTAINER } from './masters';
import { createOf } from './shared';
import type { Container } from './types';

export const createContainer = createOf<Container>('containers', CONTAINER.create, CONTAINER.required);
