import { ApiProperty, ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { IsISO8601, IsNumber, IsOptional, IsUUID, Max, Min } from 'class-validator';

const num = { allowNaN: false, allowInfinity: false } as const;

/** One position report from the assigned worker's phone. */
export class LocationPublishDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  bookingId!: string;

  @ApiProperty({ minimum: -90, maximum: 90 })
  @IsNumber(num)
  @Min(-90)
  @Max(90)
  latitude!: number;

  @ApiProperty({ minimum: -180, maximum: 180 })
  @IsNumber(num)
  @Min(-180)
  @Max(180)
  longitude!: number;

  @ApiPropertyOptional({ description: 'Horizontal accuracy radius in metres.' })
  @IsOptional()
  @IsNumber(num)
  @Min(0)
  @Max(100000)
  accuracyMeters?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 360 })
  @IsOptional()
  @IsNumber(num)
  @Min(0)
  @Max(360)
  headingDegrees?: number;

  @ApiPropertyOptional({ description: 'Metres per second.' })
  @IsOptional()
  @IsNumber(num)
  @Min(0)
  @Max(400)
  speedMps?: number;

  @ApiProperty({ description: 'When the phone took the reading (ISO 8601). Old or future readings are rejected.' })
  @IsISO8601({ strict: true })
  recordedAt!: string;
}

/** The same report as [LocationPublishDto] without the booking, which the REST path names. */
export class LocationReportDto extends OmitType(LocationPublishDto, ['bookingId'] as const) {}

export class BookingIdDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  bookingId!: string;
}
