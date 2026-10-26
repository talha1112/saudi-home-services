import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'auth:public';

/** Opts a route out of authentication. Everything else requires a valid access token. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
