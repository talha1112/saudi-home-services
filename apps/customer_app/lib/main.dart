import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/material.dart';
import 'package:hs_client/hs_client.dart';

import 'app/app.dart';
import 'core/config/api_config.dart';
import 'firebase_options.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);
  final client = HsClient.firebase(
    HsConfig(baseUrl: apiBaseUrl(), kind: AppKind.customer),
  );
  // Continue a saved session in the background; the splash screen waits for the result.
  client.auth.restore();
  runApp(App(client: client));
}
