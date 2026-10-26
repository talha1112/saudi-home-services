import 'package:flutter/material.dart';

import '../../../app/jobs_scope.dart';
import '../../../core/config/demo_data.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../earnings/screens/earnings_screen.dart';
import '../../jobs/screens/jobs_screen.dart';
import '../../profile/screens/profile_screen.dart';
import '../widgets/app_bottom_nav.dart';
import 'home_screen.dart';

/// Hosts the four main tabs behind the bottom navigation bar.
class MainShell extends StatelessWidget {
  const MainShell({super.key});

  @override
  Widget build(BuildContext context) {
    final app = context.app;
    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: IndexedStack(
          index: app.tab,
          children: const [
            HomeScreen(),
            JobsScreen(),
            EarningsScreen(),
            ProfileScreen(),
          ],
        ),
      ),
      bottomNavigationBar: ListenableBuilder(
        listenable: JobsScope.of(context).jobs,
        builder: (context, _) => AppBottomNav(
          index: app.tab,
          jobsBadge: kDemoData
              ? app.newRequestCount
              : JobsScope.of(context).jobs.newRequests.length,
          onSelected: (i) => app.showTab(i),
        ),
      ),
    );
  }
}
