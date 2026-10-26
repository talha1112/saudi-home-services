import { SetMetadata } from '@nestjs/common';

export const ALLOW_PASSWORD_CHANGE_KEY = 'auth:allow-password-change';

/** Lets accounts flagged `mustChangePassword` reach the route (change-password, profile, logout). */
export const AllowWhenPasswordChangeRequired = () => SetMetadata(ALLOW_PASSWORD_CHANGE_KEY, true);
