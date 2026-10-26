import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../../common/auth/authenticated-user.js';
import { AllowWhenPasswordChangeRequired } from '../../common/decorators/allow-password-change.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import type { ClientMeta } from './auth.types.js';
import { AuthService } from './auth.service.js';
import { FirebasePhoneAuthService } from './firebase/firebase-phone-auth.service.js';
import {
  AuthSessionDto,
  AuthUserDto,
  FirebasePhoneSignInDto,
  OtpRequestedDto,
  RefreshDto,
  RequestOtpDto,
  VerifyOtpDto,
} from './dto/auth.dto.js';

export function clientMeta(req: Request): ClientMeta {
  return { ip: req.ip, userAgent: req.get('user-agent') ?? undefined };
}

@ApiTags('Auth')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly firebase: FirebasePhoneAuthService,
  ) {}

  @Public()
  @RateLimit({ name: 'otp-request', limit: 10, windowSeconds: 600 })
  @Post('otp/request')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send a sign-in code by SMS',
    description:
      'For the customer and worker apps. The response is identical whether or not the number has an account. ' +
      'Limits: resend cooldown, hourly caps per number and per client, and a per-IP request limit (429 with Retry-After).',
  })
  @ApiOkResponse({ type: OtpRequestedDto })
  requestOtp(@Body() dto: RequestOtpDto, @Req() req: Request): Promise<OtpRequestedDto> {
    return this.auth.requestOtp(dto, clientMeta(req));
  }

  @Public()
  @RateLimit({ name: 'otp-verify', limit: 30, windowSeconds: 600 })
  @Post('otp/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Verify the code and sign in',
    description:
      'Creates the account on first use. Signing in through the worker app adds the WORKER role (pending approval); ' +
      'administrator access can never be obtained here.',
  })
  @ApiOkResponse({ type: AuthSessionDto })
  verifyOtp(@Body() dto: VerifyOtpDto, @Req() req: Request): Promise<AuthSessionDto> {
    return this.auth.verifyOtp(dto, clientMeta(req));
  }

  @Public()
  @RateLimit({ name: 'firebase-auth', limit: 20, windowSeconds: 600 })
  @Post('firebase/phone')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign in with a Firebase Phone Authentication ID token',
    description:
      'For the customer and worker apps. The server verifies the token with the Firebase Admin SDK and takes the phone number from it; ' +
      'the request carries no phone number, user id or role. Answers with the same session as the code flow (rotating refresh tokens). ' +
      'An existing account is signed in only if it is already linked to the same Firebase identity (409 otherwise); administrators can never sign in here. ' +
      '503 while Firebase sign-in is not configured.',
  })
  @ApiOkResponse({ type: AuthSessionDto })
  firebasePhone(@Body() dto: FirebasePhoneSignInDto, @Req() req: Request): Promise<AuthSessionDto> {
    return this.firebase.signIn(dto, clientMeta(req));
  }

  @Public()
  @RateLimit({ name: 'refresh', limit: 60, windowSeconds: 600 })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exchange a refresh token for a new session',
    description:
      'Refresh tokens are single use and rotate on every call. Re-using an old token revokes the whole session.',
  })
  @ApiOkResponse({ type: AuthSessionDto })
  refresh(@Body() dto: RefreshDto, @Req() req: Request): Promise<AuthSessionDto> {
    return this.auth.refresh(dto.refreshToken, clientMeta(req));
  }

  @Public()
  @RateLimit({ name: 'logout', limit: 60, windowSeconds: 600 })
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'End the session that owns this refresh token',
    description: 'Always returns 204, so it works with an expired access token and reveals nothing about the token.',
  })
  async logout(@Body() dto: RefreshDto, @Req() req: Request): Promise<void> {
    await this.auth.logout(dto.refreshToken, clientMeta(req));
  }

  @AllowWhenPasswordChangeRequired()
  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'End every session of the signed-in user (all devices)' })
  async logoutAll(@CurrentUser() user: AuthenticatedUser, @Req() req: Request): Promise<void> {
    await this.auth.logoutEverywhere(user, clientMeta(req));
  }

  @AllowWhenPasswordChangeRequired()
  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'The signed-in user' })
  @ApiOkResponse({ type: AuthUserDto })
  me(@CurrentUser() user: AuthenticatedUser): Promise<AuthUserDto> {
    return this.auth.me(user);
  }
}
