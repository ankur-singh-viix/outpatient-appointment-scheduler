import { api } from './api';
import { createQueueApi } from './queue-api';

/** The queue API bound to the app's own request helper (authentication, errors, timeouts). */
export const queueApi = createQueueApi(api);
