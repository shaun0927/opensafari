import 'dart:async';
import 'package:flutter/material.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const MyApp());
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Fixture App',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.deepPurple),
      ),
      home: const FixturePage(),
    );
  }
}

class FixturePage extends StatefulWidget {
  const FixturePage({super.key});

  @override
  State<FixturePage> createState() => _FixturePageState();
}

class _FixturePageState extends State<FixturePage> {
  int _counter = 0;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      setState(() {
        _counter++;
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
    return Scaffold(
      appBar: AppBar(
        title: const Text('Fixture App'),
      ),
      body: Padding(
        padding: const EdgeInsets.all(16.0),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.start,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Semantics(
              label: 'Login',
              child: ElevatedButton(
                onPressed: () {},
                child: const Text('Log in'),
              ),
            ),
            const SizedBox(height: 16),
            Semantics(
              identifier: 'login-btn',
              label: 'Submit',
              child: ElevatedButton(
                onPressed: () {},
                child: const Text('Submit'),
              ),
            ),
            const SizedBox(height: 16),
            Semantics(
              identifier: 'email-field',
              textField: true,
              label: 'Email',
              child: const TextField(
                decoration: InputDecoration(hintText: 'Email'),
              ),
            ),
            const SizedBox(height: 16),
            Text('Counter: $_counter'),
          ],
        ),
      ),
    );
  }
}
