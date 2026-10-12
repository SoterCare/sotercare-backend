import { AlertActionSource } from '../database/entities';

/** AR-4 audit channel; clients identify themselves with `X-Client: mobile|web`. */
export const sourceOf = (client?: string): AlertActionSource =>
  client === 'mobile' || client === 'web' ? client : 'unknown';
