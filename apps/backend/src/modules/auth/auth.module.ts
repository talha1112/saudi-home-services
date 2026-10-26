import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { APP_CONFIG, type AppConfig } from '../../config/app.config.js';
import { AccessAuthenticator } from './access-authenticator.service.js';
import { AdminAuthController } from './admin/admin-auth.controller.js';
import { AdminAuthService } from './admin/admin-auth.service.js';
import { AdminBootstrapService } from './admin/admin-bootstrap.service.js';
import { AdminMfaPolicy, NoMfaPolicy } from './admin/admin-mfa.policy.js';
import { AuditService } from './audit.service.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { AuditIntegrityCheck } from './firebase/audit-integrity-check.service.js';
import { FirebaseAdminVerifier } from './firebase/firebase-admin-verifier.js';
import { DisabledFirebaseIdentityVerifier, FirebaseIdentityVerifier } from './firebase/firebase-identity-verifier.js';
import { FirebasePhoneAuthService } from './firebase/firebase-phone-auth.service.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { OtpService } from './otp/otp.service.js';
import { PasswordService } from './password.service.js';
import { SessionsService } from './sessions.service.js';
import { SmsModule } from './sms/sms.module.js';
import { TokenCleanupService } from './token-cleanup.service.js';
import { TokenService } from './tokens/token.service.js';

/**
 * Authentication and authorisation. JwtAuthGuard and RolesGuard are registered
 * globally and in this order, so every route is private unless marked @Public().
 */
@Module({
  imports: [SmsModule],
  controllers: [AuthController, AdminAuthController],
  providers: [
    AuthService,
    FirebasePhoneAuthService,
    AuditIntegrityCheck, // start-up guard: with Firebase sign-in on, the audit trail must be tamper-resistant
    {
      // The real adapter only when FIREBASE_AUTH_ENABLED=true; otherwise the endpoint answers 503 and no Firebase code runs.
      provide: FirebaseIdentityVerifier,
      inject: [ConfigService],
      useFactory: (config: ConfigService): FirebaseIdentityVerifier => {
        const app = config.getOrThrow<AppConfig>(APP_CONFIG);
        return app.firebase.auth.enabled ? new FirebaseAdminVerifier(app.firebase) : new DisabledFirebaseIdentityVerifier();
      },
    },
    AdminAuthService,
    AdminBootstrapService,
    OtpService,
    SessionsService,
    TokenService,
    AccessAuthenticator,
    TokenCleanupService,
    PasswordService,
    AuditService,
    { provide: AdminMfaPolicy, useClass: NoMfaPolicy },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [AdminBootstrapService, SessionsService, AuditService, AccessAuthenticator],
})
export class AuthModule {}
