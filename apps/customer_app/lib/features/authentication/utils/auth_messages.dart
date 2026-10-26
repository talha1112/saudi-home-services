import 'package:flutter/widgets.dart';
import 'package:hs_client/hs_client.dart';

import '../../../core/extensions/context_extensions.dart';

/// The localized text for a sign-in failure. Messages never contain the number, the code or any token.
String authMessage(BuildContext context, AuthIssue issue) =>
    context.tr(switch (issue) {
      AuthIssue.invalidPhone => 'authInvalidPhone',
      AuthIssue.invalidCode => 'authInvalidCode',
      AuthIssue.codeExpired => 'authCodeExpired',
      AuthIssue.tooManyRequests => 'authTooMany',
      AuthIssue.network => 'authNetwork',
      AuthIssue.unavailable => 'authUnavailable',
      AuthIssue.accountSuspended => 'authSuspended',
      AuthIssue.accountDeactivated => 'authDeactivated',
      AuthIssue.accountNeedsReview => 'authReview',
      AuthIssue.notEligible => 'authNotEligible',
      AuthIssue.verificationFailed => 'authVerifyFailed',
      AuthIssue.appNotAuthorized => 'authAppNotAuthorized',
      AuthIssue.generic => 'authGeneric',
    });
