import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Locale, Role, UserStatus, WorkerVerificationStatus } from '../../../generated/prisma/client.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const lowerTrim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);

/** Which mobile app is signing in. There is deliberately no "admin" option: administrators are never self-service. */
export const APP_TYPES = ['customer', 'worker'] as const;
export type AppType = (typeof APP_TYPES)[number];

export class RequestOtpDto {
  @ApiProperty({ example: '0501234567', description: 'Saudi (05xxxxxxxx) or international (+...) mobile number' })
  @Transform(trim)
  @IsString()
  @Matches(/^[+\d][\d\s().-]{5,24}$/, { message: 'phone must be a valid phone number' })
  phone: string;

  @ApiProperty({ enum: APP_TYPES, description: 'The app the person is signing in to' })
  @IsIn(APP_TYPES)
  app: AppType;

  @ApiPropertyOptional({ enum: ['AR', 'EN'], default: 'AR', description: 'Language of the SMS' })
  @IsOptional()
  @IsIn(['AR', 'EN'])
  locale?: 'AR' | 'EN';
}

export class VerifyOtpDto {
  @ApiProperty({ example: '0501234567' })
  @Transform(trim)
  @IsString()
  @Matches(/^[+\d][\d\s().-]{5,24}$/, { message: 'phone must be a valid phone number' })
  phone: string;

  @ApiProperty({ example: '123456' })
  @Transform(trim)
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code: string;

  @ApiProperty({ enum: APP_TYPES })
  @IsIn(APP_TYPES)
  app: AppType;
}

export class FirebasePhoneSignInDto {
  @ApiProperty({
    description:
      'The Firebase ID token the app received after verifying the phone number with Firebase Phone Authentication. ' +
      'The phone number, user id and sign-in time are read from the verified token, never from this request.',
  })
  @IsString()
  @Length(100, 4096)
  @Matches(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/, { message: 'idToken must be a Firebase ID token' })
  idToken: string;

  @ApiProperty({ enum: APP_TYPES, description: 'The app the person is signing in to' })
  @IsIn(APP_TYPES)
  app: AppType;
}

export class RefreshDto {
  @ApiProperty()
  @IsString()
  @Length(20, 200)
  refreshToken: string;
}

export class AdminLoginDto {
  @ApiProperty({ example: 'admin@example.com' })
  @Transform(lowerTrim)
  @IsEmail()
  @MaxLength(254)
  email: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password: string;

  @ApiPropertyOptional({ description: 'Second factor, once MFA is enabled for the account' })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  mfaCode?: string;
}

export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  currentPassword: string;

  @ApiProperty({ description: '12-128 characters, mixing letters with numbers or symbols' })
  @IsString()
  @MaxLength(128)
  newPassword: string;
}

export class OtpRequestedDto {
  @ApiProperty({ example: 300 })
  expiresInSeconds: number;

  @ApiProperty({ example: 60 })
  resendAfterSeconds: number;
}

export class AuthUserDto {
  @ApiProperty() id: string;
  @ApiProperty({ nullable: true }) phone: string | null;
  @ApiProperty({ nullable: true }) email: string | null;
  @ApiProperty({ nullable: true }) fullName: string | null;
  @ApiProperty({ enum: Locale }) locale: Locale;
  @ApiProperty({ enum: UserStatus }) status: UserStatus;
  @ApiProperty({ enum: Role, isArray: true }) roles: Role[];
  @ApiProperty({ enum: Role, description: 'The role of the current session' }) activeRole: Role;
  @ApiPropertyOptional({ enum: WorkerVerificationStatus }) workerVerificationStatus?: WorkerVerificationStatus;
  @ApiProperty() mustChangePassword: boolean;
}

export class AuthSessionDto {
  @ApiProperty({ example: 'Bearer' }) tokenType: 'Bearer';
  @ApiProperty() accessToken: string;
  @ApiProperty({ example: 900 }) accessTokenExpiresInSeconds: number;
  @ApiProperty({ description: 'Single use. Store securely (Keystore/Keychain on mobile).' }) refreshToken: string;
  @ApiProperty() refreshTokenExpiresAt: string;
  @ApiProperty({ type: AuthUserDto }) user: AuthUserDto;
  @ApiPropertyOptional({ description: 'True when this sign-in created the account' }) isNewUser?: boolean;
}
