import 'package:flutter/widgets.dart';
import 'package:hs_client/hs_client.dart';

import '../../app/app_scope.dart';
import '../../app/app_state.dart';
import '../../app/auth_scope.dart';
import '../../app/localization/app_strings.dart';
import '../utils/money.dart';

extension AppContext on BuildContext {
  /// Shared prototype state (subscribes to changes).
  AppState get app => AppScope.of(this);

  /// Shared prototype state without subscribing.
  AppState get appRead => AppScope.read(this);

  /// Sign-in state and session (subscribes to changes).
  AuthController get auth => AuthScope.of(this);

  /// Sign-in controller without subscribing.
  AuthController get authRead => AuthScope.read(this);

  bool get isAr => Localizations.localeOf(this).languageCode == 'ar';

  String tr(String key) => kStrings[key]?.of(isAr) ?? key;

  String l(Bi value) => value.of(isAr);

  String sar(num n) => money(n, ar: isAr);

  String sarNeg(num n) => moneyNeg(n, ar: isAr);

  /// Icon pointing "back" in the current reading direction.
  String get backIcon => isAr ? 'chevron-right' : 'chevron-left';

  /// Icon pointing "forward" in the current reading direction.
  String get forwardIcon => isAr ? 'chevron-left' : 'chevron-right';

  /// Bottom padding that clears the home indicator.
  double get bottomInset => MediaQuery.paddingOf(this).bottom;
}
