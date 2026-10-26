import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../../../common/auth/authenticated-user.js';
import { AllowWhenPasswordChangeRequired } from '../../../common/decorators/allow-password-change.decorator.js';
import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import { Public } from '../../../common/decorators/public.decorator.js';
import { RateLimit } from '../../../common/decorators/rate-limit.decorator.js';
import { Roles } from '../../../common/decorators/roles.decorator.js';
import { Role } from '../../../generated/prisma/client.js';
import { clientMeta } from '../auth.controller.js';
import { AdminLoginDto, AuthSessionDto, ChangePasswordDto } from '../dto/auth.dto.js';
import { AdminAuthService } from './admin-auth.service.js';

@ApiTags('Admin auth')
@Controller({ path: 'auth/admin', version: '1' })
export class AdminAuthController {
  constructor(private readonly admin: AdminAuthService) {}

  @Public()
  @RateLimit({ name: 'admin-login', limit: 30, windowSeconds: 900 })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Administrator sign-in (email + password)',
    description:
      'There is no admin registration endpoint. Failed attempts are throttled per email+IP, per email and per IP (429).',
  })
  @ApiOkResponse({ type: AuthSessionDto })
  login(@Body() dto: AdminLoginDto, @Req() req: Request): Promise<AuthSessionDto> {
    return this.admin.login(dto, clientMeta(req));
  }

  @Roles(Role.ADMIN)
  @AllowWhenPasswordChangeRequired()
  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Change the administrator password',
    description:
      'Signs the account out of every device and returns a new session. Required after the first sign-in with a bootstrap or reset password. ' +
      'A forgotten password is recovered by an operator with `npm run admin:reset-password`.',
  })
  @ApiOkResponse({ type: AuthSessionDto })
  changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
    @Req() req: Request,
  ): Promise<AuthSessionDto> {
    return this.admin.changePassword(user, dto, clientMeta(req));
  }
}
