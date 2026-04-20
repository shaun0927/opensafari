import 'dart:async';
import 'package:flutter/material.dart';

// Fixture for GitHub issue #46.
//
// Renders an 8000ms spinner-only phase on first build, then swaps to plain
// content. During the spinner phase the foreground AX tree is empty from the
// simulator's point of view — this is the exact signature sim-hid-bridge's
// TRANSITIONAL_STATE_TIMEOUT classification keys on. After 8000ms the tree
// has visible semantics again and the classification must de-promote.
//
// Bundle ID (set in ios/Runner.xcodeproj + Info.plist during
// `flutter create` bootstrap): com.opensafari.fixtures.flutterSpinnerQa

const Duration kSpinnerPhase = Duration(milliseconds: 8000);

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const SpinnerFixtureApp());
}

class SpinnerFixtureApp extends StatelessWidget {
  const SpinnerFixtureApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Flutter Spinner Fixture',
      home: const SpinnerPage(),
    );
  }
}

class SpinnerPage extends StatefulWidget {
  const SpinnerPage({super.key});

  @override
  State<SpinnerPage> createState() => _SpinnerPageState();
}

class _SpinnerPageState extends State<SpinnerPage> {
  bool _ready = false;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _timer = Timer(kSpinnerPhase, () {
      if (!mounted) return;
      setState(() {
        _ready = true;
      });
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // Deliberately NO Scaffold / AppBar / other widgets while spinning. The
    // goal is to present an AX surface that looks identical to a long-lived
    // transitional / loading screen: one spinner, no labels, no actionable
    // semantics — which is exactly what `FOREGROUND_CONTEXT_UNAVAILABLE`
    // fires on today.
    if (!_ready) {
      return const Directionality(
        textDirection: TextDirection.ltr,
        child: ColoredBox(
          color: Colors.black,
          child: Center(child: CircularProgressIndicator()),
        ),
      );
    }
    return const Directionality(
      textDirection: TextDirection.ltr,
      child: ColoredBox(
        color: Colors.white,
        child: Center(
          child: Text(
            'Content ready',
            style: TextStyle(fontSize: 24, color: Colors.black),
          ),
        ),
      ),
    );
  }
}
