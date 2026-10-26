import 'package:flutter/foundation.dart';
import 'package:hs_client/hs_client.dart';

import '../core/config/demo_data.dart';
import '../dev_fixtures.dart';
import '../shared/models/worker_data.dart';

/// Local, in-memory state that drives the UI prototype. There is no backend.
class AppState extends ChangeNotifier {
  bool _arabic = false;
  bool get isArabic => _arabic;
  void setArabic(bool value) {
    if (_arabic == value) return;
    _arabic = value;
    notifyListeners();
  }

  String phone = '';

  // Main tab shell (0 home, 1 jobs, 2 earnings, 3 profile)
  int tab = 0;
  int jobsTab = 0;
  int earningsPeriod = 1;
  void showTab(int index, {int? jobs, int? period}) {
    tab = index;
    if (jobs != null) jobsTab = jobs;
    if (period != null) earningsPeriod = period;
    notifyListeners();
  }

  bool online = true;

  // Quote being prepared / sent for the first request
  QuoteState quoteState = QuoteState.none;
  int stage = 0;
  String labour = '121';
  String parts = '30';
  String quoteNote =
      'Includes drain flush for both units. Parts: drain pump seal.';
  int validity = 1;

  String planId = 'pro';
  SubscriptionPlan get plan => kPlans.firstWhere((p) => p.id == planId);

  JobRequest get request => kRequests.first;

  /// Where the job in progress is, exactly as the backend released it to this worker: only the city and district before the customer has
  /// paid, the full address and exact point after. Null until the job has been loaded. Debug builds start with a prototype value
  /// (see dev_fixtures.dart) when demo data is switched on (`--dart-define=DEMO_DATA=true`, never in release builds).
  BookingLocation? activeJobLocation = kDemoData ? devJobLocation : null;

  /// Shows the place from a freshly loaded booking (`GET /workers/me/bookings/:id`).
  void setActiveJob(BookingView? booking) {
    activeJobLocation = booking?.location;
    notifyListeners();
  }

  double get labourAmount => double.tryParse(labour) ?? 0;
  double get partsAmount => double.tryParse(parts) ?? 0;
  double get gross => kMinCharge + labourAmount + partsAmount;
  double get commission => (gross * plan.rate).round() / 100;
  double get net => ((gross - commission) * 100).round() / 100;

  bool get quoteAccepted => quoteState == QuoteState.accepted;
  bool get jobDone => quoteAccepted && stage >= 4;

  /// Number of requests still waiting for a quote.
  int get newRequestCount => kRequests
      .where((r) => r != kRequests.first || quoteState == QuoteState.none)
      .length;

  void update(VoidCallback change) {
    change();
    notifyListeners();
  }
}
