import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { Locale, Role, UserStatus, WorkerVerificationStatus } from '../../generated/prisma/client.js';

export class CustomerProfileDto {
  @ApiProperty() userId: string;
  @ApiProperty({ nullable: true }) fullName: string | null;
  @ApiProperty() marketingOptIn: boolean;
  @ApiProperty() createdAt: string;
}

export class UpdateCustomerProfileDto {
  @ApiProperty({ minLength: 2, maxLength: 120, description: 'The name shown to professionals once a booking is paid' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value))
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  fullName: string;
}

export class WorkerProfileDto {
  @ApiProperty() userId: string;
  @ApiProperty({ nullable: true }) fullName: string | null;
  @ApiProperty({ nullable: true }) bio: string | null;
  @ApiProperty({ nullable: true }) yearsOfExperience: number | null;
  @ApiProperty({ enum: WorkerVerificationStatus }) verificationStatus: WorkerVerificationStatus;
  @ApiPropertyOptional({ nullable: true }) verificationNote: string | null;
  @ApiProperty() isOnline: boolean;
  @ApiProperty() acceptsUrgentJobs: boolean;
}

export class WorkerJobsDto {
  @ApiProperty({ type: [Object], description: 'Placeholder until bookings exist' }) items: unknown[];
}

export class AdminUserSummaryDto {
  @ApiProperty() id: string;
  @ApiProperty({ nullable: true }) phone: string | null;
  @ApiProperty({ nullable: true }) email: string | null;
  @ApiProperty({ nullable: true }) fullName: string | null;
  @ApiProperty({ enum: Locale }) locale: Locale;
  @ApiProperty({ enum: UserStatus }) status: UserStatus;
  @ApiProperty({ enum: Role, isArray: true }) roles: Role[];
  @ApiPropertyOptional({ enum: WorkerVerificationStatus }) workerVerificationStatus?: WorkerVerificationStatus;
  @ApiProperty() createdAt: string;
  @ApiProperty({ nullable: true }) lastLoginAt: string | null;
}
